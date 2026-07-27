/**
 * @file    api/dashboard/receivings/route.ts
 * @purpose Returns Finale received POs enriched with local reconciliation data.
 *          For each received PO, shows: matched invoice, price changes,
 *          freight/tax adjustments, approval status, and invoice-PO match suggestions.
 *
 *          GET  — received POs + reconciliation + match suggestions
 *          POST — actions: complete_po, match_invoice, mark_freight_pattern
 *
 * @updated 2026-07-14 — added 30d window, match suggestions, PO completion, freight learning
 */

import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';
import { createClient } from '@/lib/db';
import { findPOCandidates } from '@/lib/purchasing/invoice-po-matcher';
import { transitionLifecycleState } from '@/lib/purchasing/po-lifecycle';
import { recordFreightEvidence, markVendorFreightPattern, getVendorFreightClassification } from '@/lib/purchasing/vendor-freight-learning';
import { reconcileInvoiceToPO, applyReconciliation } from '@/lib/finale/reconciler';

// ── In-flight PO reconciliation guard ─────────────────────────────────────
// Prevents concurrent Finale writes when two browser tabs / bust=1 calls
// attempt to auto-reconcile the same PO simultaneously.
// The Set is module-scoped so it resets on server restart / HMR.
const _reconcilingPOs = new Set<string>();
// ────────────────────────────────────────────────────────────────────────────

// ── Concurrency-limited async map ────────────────────────────────────────
/**
 * Maps an array with a bounded number of concurrent async operations.
 * Preserves input order. Replaces unbounded Promise.all(arr.map(fn))
 * which fans out N requests at once. Used for PostgREST loops that are
 * NOT subject to the Finale 500ms global queue (local DB calls only).
 */
async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

export function getDenverWeekStart(date: Date): string {
    const denverNow = new Date(date.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    const day = denverNow.getDay();
    const daysSinceMonday = (day + 6) % 7;
    denverNow.setDate(denverNow.getDate() - daysSinceMonday);
    return denverNow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

export async function GET(req: NextRequest) {
    // ── Outer guard: the route MUST NEVER hang the socket ──
    // If the handler doesn't resolve within 45s (including Finale timeout),
    // return a graceful error payload instead of a hung connection.
    const ROUTE_TIMEOUT_MS = 45_000;
    try {
        const payload = await Promise.race([
            handleGET(req),
            new Promise<NextResponse>((_, reject) =>
                setTimeout(() => reject(new Error(`Receivings route timed out (${ROUTE_TIMEOUT_MS / 1000}s)`)), ROUTE_TIMEOUT_MS),
            ),
        ]);
        return payload;
    } catch (outerErr: any) {
        console.warn('[receivings] Route guard caught hang — returning graceful error:', outerErr?.message || outerErr);
        return NextResponse.json({
            error: 'finale_timeout',
            message: 'Receivings data temporarily unavailable — Finale rate-limited',
            received: [],
            days: 30,
            range: 'error',
            startDate: '',
            asOf: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' }),
            matchSuggestions: [],
            freightClasses: {},
            recentAutoCompletions: [],
        });
    }
}

async function handleGET(req: NextRequest): Promise<NextResponse> {
    try {
        const { searchParams } = new URL(req.url);
        const daysParam = searchParams.get('days');
        const matchInvoiceId = searchParams.get('match_invoice');

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const DEFAULT_RECEIVINGS_DAYS = 30;
        const startStr = daysParam
            ? (() => {
                const days = parseInt(daysParam, 10);
                const start = new Date(now);
                start.setDate(start.getDate() - days);
                return start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            })()
            : (() => {
                const start = new Date(now);
                start.setDate(start.getDate() - DEFAULT_RECEIVINGS_DAYS);
                return start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            })();

        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const finale = new FinaleClient();
        // Finale receivings can hang 60s+ under load — fail open so the panel paints.
        // NOTE(2026-07-27): getTodaysReceivedPOs no longer uses a soft timeout at all.
        // Shipment enrichment on the request path is CACHE-ONLY (synchronous Map
        // lookups, zero network I/O), with cold shipment detail fetched by a bounded
        // single-flight background warm-up. See the DECISION block in receivings.ts.
        // Consequence: base GraphQL POs always return promptly even when Finale is
        // rate-limited, and there is no enrichment race left to tune here.
        let received: any[] = [];
        try {
            // NOTE(2026-07-27): No inner timeout here — the request path in
            // getTodaysReceivedPOs performs no shipment network I/O, so it cannot
            // stall on Finale rate limiting. The outer route guard (45s) remains the
            // sole backstop for a genuinely hung connection.
            received = await finale.getTodaysReceivedPOs(startStr, tomorrowStr);
        } catch (finaleErr: any) {
            console.warn('[receivings] Finale getTodaysReceivedPOs failed/timeout:', finaleErr?.message || finaleErr);
            received = [];
        }

        // Enrich with reconciliation data from local Postgres
        const sb = createClient();
        if (sb && received.length > 0) {
            const poNumbers = received
                .map((r: any) => r.poNumber || r.orderId)
                .filter(Boolean);

            if (poNumbers.length > 0) {
                const { data: invoices } = await sb
                    .from('vendor_invoices')
                    .select('po_number, invoice_number, subtotal, freight, tax, total, status, created_at, id, pdf_storage_path, source_ref')
                    .in('po_number', poNumbers)
                    .order('created_at', { ascending: false });

                const { data: outcomes } = await sb
                    .from('reconciliation_outcomes')
                    .select('po_id, invoice_id, outcome, outcome_meta, created_at, resolved_at')
                    .in('po_id', poNumbers)
                    .order('created_at', { ascending: false });

                const invoiceMap = new Map<string, any[]>();
                for (const inv of (invoices || [])) {
                    const key = inv.po_number;
                    if (!invoiceMap.has(key)) invoiceMap.set(key, []);
                    invoiceMap.get(key)!.push(inv);
                }

                const outcomeMap = new Map<string, any[]>();
                for (const oc of (outcomes || [])) {
                    const key = oc.po_id;
                    if (!outcomeMap.has(key)) outcomeMap.set(key, []);
                    outcomeMap.get(key)!.push(oc);
                }

                for (const po of received) {
                    const poNum = po.poNumber || po.orderId;
                    (po as any)._reconciliation = {
                        invoices: invoiceMap.get(poNum) || [],
                        outcomes: outcomeMap.get(poNum) || [],
                        hasPendingApproval: (outcomeMap.get(poNum) || []).some(
                            (o: any) => o.outcome === 'pending_approval' && !o.resolved_at
                        ),
                        hasAutoApplied: (outcomeMap.get(poNum) || []).some(
                            (o: any) => o.outcome === 'auto_applied'
                        ),
                        matchedInvoice: (invoiceMap.get(poNum) || [])[0] || null,
                    };
                }
            }

            // ── Match suggestions: find unmatched invoices for received PO vendors ──
            const vendorNames = [...new Set(received.map((r: any) => r.supplier).filter(Boolean))] as string[];
            let matchSuggestions: any[] = [];

            if (vendorNames.length > 0) {
                let unmatchedInvoices: any[] = [];
                try {
                    const { data } = await sb
                        .from('vendor_invoices')
                        .select('id, invoice_number, vendor_name, invoice_date, subtotal, freight, tax, total, raw_data')
                        .is('po_number', null)
                        .in('vendor_name', vendorNames)
                        .order('created_at', { ascending: false })
                        .limit(20);
                    unmatchedInvoices = data || [];
                } catch (fetchErr: any) {
                    console.warn(`[receivings] Failed to fetch unmatched invoices: ${fetchErr?.message || fetchErr}`);
                    unmatchedInvoices = [];
                }

                // Local invoice_cache fallback when PostgREST is empty/down (photo invoices etc.)
                try {
                    const { getUnmatchedInvoices, getInvoiceCacheByVendor } = await import(
                        '@/lib/storage/purchasing-cache'
                    );
                    const localUnmatched = getUnmatchedInvoices();
                    const seen = new Set(
                        unmatchedInvoices.map(
                            (i) =>
                                `${(i.vendor_name || '').toLowerCase()}|${i.invoice_number || ''}|${i.total || 0}`,
                        ),
                    );
                    for (const v of vendorNames) {
                        const rows = [
                            ...localUnmatched.filter((r) =>
                                (r.vendor_name || '').toLowerCase().includes(String(v).toLowerCase().slice(0, 12)),
                            ),
                            ...getInvoiceCacheByVendor(v).filter((r) => !r.matched_po && !r.po_number),
                        ];
                        for (const row of rows) {
                            const key = `${(row.vendor_name || '').toLowerCase()}|${row.invoice_number || ''}|${row.total || 0}`;
                            if (seen.has(key)) continue;
                            // Only skip confirmed matches — OCR may set po_number as candidate
                            if (row.matched_po) continue;
                            seen.add(key);
                            unmatchedInvoices.push({
                                id: row.vendor_invoice_id || key,
                                invoice_number: row.invoice_number,
                                vendor_name: row.vendor_name,
                                invoice_date: row.invoice_date,
                                subtotal: row.total || 0,
                                freight: row.freight || 0,
                                tax: row.tax || 0,
                                total: row.total || 0,
                                raw_data: {
                                    lineItems: (() => {
                                        try {
                                            return JSON.parse(row.line_items || '[]');
                                        } catch {
                                            return [];
                                        }
                                    })(),
                                    source: 'invoice_cache',
                                    ocrPoCandidate: row.po_number || null,
                                },
                                _fromCache: true,
                            });
                        }
                    }
                    // Also surface DTE / recent AP photo invoices even if vendor name on PO differs slightly
                    for (const row of localUnmatched.slice(0, 30)) {
                        const key = `${(row.vendor_name || '').toLowerCase()}|${row.invoice_number || ''}|${row.total || 0}`;
                        if (seen.has(key)) continue;
                        if (row.matched_po) continue;
                        seen.add(key);
                        unmatchedInvoices.push({
                            id: row.vendor_invoice_id || key,
                            invoice_number: row.invoice_number,
                            vendor_name: row.vendor_name,
                            invoice_date: row.invoice_date,
                            subtotal: row.total || 0,
                            freight: row.freight || 0,
                            tax: row.tax || 0,
                            total: row.total || 0,
                            raw_data: {
                                source: 'invoice_cache',
                                ocrPoCandidate: row.po_number || null,
                            },
                            _fromCache: true,
                        });
                    }
                } catch (cacheErr: any) {
                    console.warn('[receivings] invoice_cache fallback failed:', cacheErr?.message || cacheErr);
                }

                if (unmatchedInvoices && unmatchedInvoices.length > 0) {
                    // Hard cap — findPOCandidates hits PostgREST; unbounded loops hang the panel
                    const toScore = unmatchedInvoices.slice(0, 12);
                    // Drop dropship-flow invoices before scoring (vendor keyword or known patterns)
                    const { classifyInvoice } = await import('@/config/invoice-classification');
                    const filteredToScore = toScore.filter((inv: any) => {
                        const cls = classifyInvoice({
                            vendorName: inv.vendor_name,
                            poNumber: inv.raw_data?.ocrPoCandidate || inv.po_number || null,
                        });
                        return cls.classification !== 'dropship_flow_through';
                    });
                    // Prefer filtered list
                    const scoreList = filteredToScore; // always use filtered (may be empty)

                    // ── Phase A: score all invoices in parallel (read-only, concurrency 4) ──
                    // DECISION(2026-07-27): Previously this loop scored up to 12 invoices
                    // sequentially against 4s findPOCandidates timeouts (~48s worst case).
                    // Now scoring runs in parallel at concurrency 4. The write/auto-apply
                    // phase (Phase B) remains strictly sequential — financial writes must
                    // never overlap. These are local PostgREST calls, NOT subject to the
                    // Finale 500ms global queue.
                    // Dropship POs/invoices are excluded before scoring (scoreList).
                    const scoredResults = await mapConcurrent(scoreList, 4, async (inv) => {
                        // OCR short-circuit: no DB call needed — still never offer dropship POs
                        const ocrPo = inv.raw_data?.ocrPoCandidate || inv.po_number || null;
                        if (inv._fromCache && ocrPo && !/DropshipPO/i.test(String(ocrPo))) {
                            return {
                                inv,
                                status: 'ocr' as const,
                                ocrSuggestion: {
                                    invoiceId: inv.id,
                                    invoiceNumber: inv.invoice_number,
                                    vendorName: inv.vendor_name,
                                    invoiceDate: inv.invoice_date,
                                    invoiceTotal: inv.total,
                                    candidates: [{
                                        orderId: String(ocrPo),
                                        vendorName: inv.vendor_name,
                                        orderDate: inv.invoice_date || '',
                                        total: Number(inv.total || 0),
                                        status: 'ocr_candidate',
                                        score: 70,
                                        reasons: ['OCR PO# candidate'],
                                        isOpen: true,
                                    }],
                                    autoApplyReady: false,
                                    fromCache: true,
                                },
                            };
                        }
                        try {
                            const scorePromise = findPOCandidates({
                                id: inv.id,
                                invoiceNumber: inv.invoice_number,
                                vendorName: inv.vendor_name,
                                invoiceDate: inv.invoice_date,
                                subtotal: Number(inv.subtotal || 0),
                                freight: Number(inv.freight || 0),
                                tax: Number(inv.tax || 0),
                                total: Number(inv.total || 0),
                                lineItems: inv.raw_data?.lineItems || [],
                                ocrPoCandidate: inv.raw_data?.ocrPoCandidate || inv.raw_data?.poNumber || null,
                                ocrOrderCandidate: inv.raw_data?.orderNumber || null,
                            });
                            const result = await Promise.race([
                                scorePromise,
                                new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
                            ]);
                            if (!result) {
                                return { inv, status: 'timed_out' as const };
                            }
                            return { inv, status: 'scored' as const, result };
                        } catch (err: any) {
                            return { inv, status: 'error' as const, err };
                        }
                    });

                    // ── Phase B: process scored results sequentially (side-effect-safe) ──
                    for (const sr of scoredResults) {
                        const { inv } = sr;
                        if (sr.status === 'ocr' && sr.ocrSuggestion) {
                            // Never offer dropship POs as OCR match targets
                            const ocrCands = (sr.ocrSuggestion.candidates || []).filter(
                                (c: any) => !/DropshipPO/i.test(String(c.orderId || '')),
                            );
                            if (ocrCands.length === 0) continue;
                            matchSuggestions.push({ ...sr.ocrSuggestion, candidates: ocrCands });
                            continue;
                        }
                        if (sr.status === 'timed_out') {
                            matchSuggestions.push({
                                invoiceId: inv.id,
                                invoiceNumber: inv.invoice_number,
                                vendorName: inv.vendor_name,
                                invoiceDate: inv.invoice_date,
                                invoiceTotal: inv.total,
                                candidates: [],
                                autoApplyReady: false,
                                fromCache: !!inv._fromCache,
                                timedOut: true,
                            });
                            continue;
                        }
                        if (sr.status === 'error') {
                            console.warn(`[receivings] Match scoring failed for invoice: ${sr.err?.message || sr.err}`);
                            continue;
                        }

                        // Scored successfully — execute side effects
                        const result = sr.result!;
                        // Strip dropship POs from candidates — never match those
                        result.candidates = (result.candidates || []).filter(
                            (c: any) => !/DropshipPO/i.test(String(c.orderId || '')),
                        );
                        if (result.candidates.length === 0) {
                            matchSuggestions.push({
                                invoiceId: inv.id,
                                invoiceNumber: inv.invoice_number,
                                vendorName: inv.vendor_name,
                                invoiceDate: inv.invoice_date,
                                invoiceTotal: inv.total,
                                candidates: [],
                                autoApplyReady: false,
                                fromCache: !!inv._fromCache,
                            });
                            continue;
                        }
                        // Recompute best after filter
                        result.bestMatch = result.candidates[0] || null;
                        if (result.autoApplyReady && result.bestMatch && /DropshipPO/i.test(result.bestMatch.orderId || '')) {
                            result.autoApplyReady = false;
                        }
                        try {
                            // Auto-apply high-confidence matches: score ≥80 and autoApplyReady
                            // Never auto-apply cache-only rows against PostgREST (id may be local)
                            // Never auto-apply dropship POs
                            const best = result.candidates[0];
                            const shouldAutoApply =
                                best &&
                                best.score >= 80 &&
                                result.autoApplyReady &&
                                !inv._fromCache &&
                                !/DropshipPO/i.test(String(best.orderId || ''));

                            if (shouldAutoApply) {
                                // Auto-match: link invoice to PO, but DON'T complete PO in Finale
                                // Human must review and click Complete PO to finalize
                                try {
                                    await sb
                                        .from('vendor_invoices')
                                        .update({ po_number: best.orderId, status: 'matched', updated_at: new Date().toISOString() })
                                        .eq('id', inv.id);

                                    await transitionLifecycleState(
                                        best.orderId,
                                        'INVOICED',
                                        'receivings-auto-match',
                                        {
                                            invoiceId: inv.id,
                                            invoiceNumber: inv.invoice_number,
                                            score: best.score,
                                            reasons: best.reasons,
                                        }
                                    );

                                    // Route through reconciler — single source of truth for freight/fees.
                                    // Uses delta-based freight, duplicate detection, disproportion guards.
                                    // Skip if this PO is already being reconciled by another request.
                                    if (_reconcilingPOs.has(best.orderId)) {
                                        console.log(
                                            `[receivings] Skipping PO ${best.orderId} — reconciliation already in-flight`,
                                        );
                                    } else {
                                        // Only trust raw_data if it has the InvoiceData shape.
                                        // Modules / raw email payloads stored as raw_data lack the
                                        // required fields and would pass nulls into the reconciler.
                                        const rawData = inv.raw_data as Record<string, unknown> | undefined;
                                        const hasValidRawData =
                                            rawData &&
                                            typeof rawData.vendorName === 'string' &&
                                            typeof rawData.invoiceNumber === 'string' &&
                                            typeof rawData.total === 'number';

                                        const invoiceData = hasValidRawData ? rawData : {
                                            vendorName: inv.vendor_name,
                                            invoiceNumber: inv.invoice_number,
                                            invoiceDate: inv.invoice_date,
                                            dueDate: null,
                                            total: Number(inv.total || 0),
                                            amountDue: Number(inv.total || 0),
                                            subtotal: Number(inv.subtotal || 0),
                                            freight: Number(inv.freight || 0),
                                            tax: Number(inv.tax || 0),
                                            poNumber: best.orderId,
                                            lineItems: inv.raw_data?.lineItems || [],
                                            confidence: "medium" as const,
                                        };

                                        _reconcilingPOs.add(best.orderId);
                                        try {
                                            const reconResult = await reconcileInvoiceToPO(
                                                invoiceData as any,
                                                best.orderId,
                                                finale,
                                                'receivings-auto-match',
                                            );

                                            if (reconResult.overallVerdict === 'auto_approve') {
                                                await applyReconciliation(reconResult, finale);
                                            }

                                            // Log the auto-match event
                                            await sb.from('ap_activity_log').insert({
                                                intent: 'RECONCILIATION_AUTO_APPLIED',
                                                action_taken: `Auto-matched to PO ${best.orderId} — recon verdict=${reconResult.overallVerdict}`,
                                                metadata: {
                                                    invoiceNumber: inv.invoice_number,
                                                    poNumber: best.orderId,
                                                    vendorName: inv.vendor_name,
                                                    score: best.score,
                                                    reasons: best.reasons,
                                                    status: 'needs_review',
                                                    reconVerdict: reconResult.overallVerdict,
                                                },
                                                email_from: inv.vendor_name || '',
                                                email_subject: `Invoice ${inv.invoice_number} auto-matched`,
                                            });
                                        } catch (reconErr: any) {
                                            console.warn(
                                                `[receivings] Reconciliation failed for invoice ${inv.invoice_number} → PO ${best.orderId}: ${reconErr?.message || reconErr}`,
                                            );
                                            // Log the failure
                                            try {
                                                await sb.from('ap_activity_log').insert({
                                                    intent: 'RECONCILIATION_AUTO_APPLY_FAILED',
                                                    action_taken: `Auto-apply failed for ${inv.invoice_number} → PO ${best.orderId}`,
                                                    metadata: {
                                                        invoiceNumber: inv.invoice_number,
                                                        poNumber: best.orderId,
                                                        vendorName: inv.vendor_name,
                                                        score: best.score,
                                                        error: reconErr?.message || String(reconErr),
                                                    },
                                                    email_from: inv.vendor_name || '',
                                                    email_subject: `Auto-apply failed — ${inv.invoice_number}`,
                                                });
                                            } catch {
                                                // Non-critical
                                            }
                                        } finally {
                                            _reconcilingPOs.delete(best.orderId);
                                        }
                                    }
                                } catch (autoApplyErr: any) {
                                    console.warn(
                                        `[receivings] Auto-apply failed for invoice ${inv.invoice_number} → PO ${best.orderId}: ${autoApplyErr?.message || autoApplyErr}`,
                                    );
                                    // Log the failure so it shows on the dashboard
                                    try {
                                        await sb.from('ap_activity_log').insert({
                                            intent: 'RECONCILIATION_AUTO_APPLY_FAILED',
                                            action_taken: `Auto-apply failed for ${inv.invoice_number} → PO ${best.orderId}`,
                                            metadata: {
                                                invoiceNumber: inv.invoice_number,
                                                poNumber: best.orderId,
                                                vendorName: inv.vendor_name,
                                                score: best.score,
                                                error: autoApplyErr?.message || String(autoApplyErr),
                                            },
                                            email_from: inv.vendor_name || '',
                                            email_subject: `Auto-apply failed — ${inv.invoice_number}`,
                                        });
                                    } catch {
                                        // Non-critical — logging failure shouldn't cascade
                                    }
                                }

                                // Show in suggestions as auto-matched, not hidden
                                matchSuggestions.push({
                                    invoiceId: inv.id,
                                    invoiceNumber: inv.invoice_number,
                                    vendorName: inv.vendor_name,
                                    invoiceDate: inv.invoice_date,
                                    invoiceTotal: inv.total,
                                    candidates: result.candidates.slice(0, 5),
                                    autoApplyReady: true,
                                    autoMatched: true,  // flag: auto-matched, needs human completion
                                });
                            } else {
                                // Needs human attention: show in suggestions
                                matchSuggestions.push({
                                    invoiceId: inv.id,
                                    invoiceNumber: inv.invoice_number,
                                    vendorName: inv.vendor_name,
                                    invoiceDate: inv.invoice_date,
                                    invoiceTotal: inv.total,
                                    candidates: result.candidates.slice(0, 5),
                                    autoApplyReady: result.autoApplyReady ?? false,
                                    fromCache: !!inv._fromCache,
                                });
                            }
                        } catch (matchErr: any) {
                            console.warn(`[receivings] Match scoring failed for invoice: ${matchErr?.message || matchErr}`);
                        }
                    }
                }
            }

            // ── Recent auto-completions (audit trail for auto-processed) ──
            let recentAutoCompletions: Array<{
                intent: string;
                poNumber?: string;
                invoiceNumber?: string;
                vendorName?: string;
                createdAt: string;
                metadata?: any;
            }> = [];
            try {
                const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString(); // 30 days
                const { data: activityLog } = await sb
                    .from('ap_activity_log')
                    .select('intent, created_at, metadata')
                    .in('intent', ['RECONCILIATION_AUTO_APPLIED', 'RECONCILIATION_ERROR'])
                    .gte('created_at', cutoff)
                    .order('created_at', { ascending: false })
                    .limit(20);
                if (activityLog) {
                    recentAutoCompletions = activityLog.map((row: any) => ({
                        intent: row.intent,
                        poNumber: row.metadata?.poNumber || row.metadata?.orderId || '',
                        invoiceNumber: row.metadata?.invoice || row.metadata?.invoiceNumber || '',
                        vendorName: row.metadata?.vendorName || '',
                        createdAt: row.created_at,
                        metadata: row.metadata,
                    }));
                }
            } catch (completionsErr: any) {
                console.warn(`[receivings] Failed to fetch recent auto-completions: ${completionsErr?.message || completionsErr}`);
            }

            // ── Freight classifications for received PO vendors ──
            // DECISION(2026-07-27): This loop was 40 sequential ~2.2s PostgREST
            // round-trips and is now bounded-parallel at 8. These are local-DB
            // calls (PostgREST on port 3000), NOT subject to the Finale 500ms
            // global queue, so real parallelism is achieved here.
            const freightClasses: Record<string, any> = {};
            const fcResults = await mapConcurrent(vendorNames, 8, async (v) => {
                try {
                    const result = await getVendorFreightClassification(v);
                    return { vendor: v, result };
                } catch (fcErr: any) {
                    console.warn(`[receivings] Freight classification failed for ${v}: ${fcErr?.message || fcErr}`);
                    return { vendor: v, result: undefined };
                }
            });
            for (const fr of fcResults) {
                if (fr.result !== undefined) {
                    freightClasses[fr.vendor] = fr.result;
                }
            }

            return NextResponse.json({
                received,
                days: daysParam ? parseInt(daysParam, 10) : DEFAULT_RECEIVINGS_DAYS,
                range: daysParam ? 'rolling_days' : 'rolling_30d',
                startDate: startStr,
                asOf: todayStr,
                matchSuggestions,
                freightClasses,
                recentAutoCompletions,
            });
        }

        return NextResponse.json({
            received,
            days: daysParam ? parseInt(daysParam, 10) : DEFAULT_RECEIVINGS_DAYS,
            range: daysParam ? 'rolling_days' : 'rolling_30d',
            startDate: startStr,
            asOf: todayStr,
            matchSuggestions: [],
            freightClasses: {},
        });
    } catch (err: any) {
        console.error('Receivings API error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── POST: Complete PO, match invoice, mark freight pattern ──────────────────

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { action } = body;

        if (action === 'approve_reconciliation') {
            const { orderId, invoiceId } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

            const sb = createClient();
            if (!sb) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

            const now = new Date().toISOString();

            // Update ap_pending_approvals
            if (invoiceId) {
                await sb
                    .from('ap_pending_approvals')
                    .update({ status: 'approved', resolved_at: now })
                    .eq('order_id', orderId)
                    .eq('invoice_number', invoiceId);
            } else {
                await sb
                    .from('ap_pending_approvals')
                    .update({ status: 'approved', resolved_at: now })
                    .eq('order_id', orderId);
            }

            // Update reconciliation_outcomes
            await sb
                .from('reconciliation_outcomes')
                .update({ outcome: 'approved', resolved_at: now })
                .eq('po_id', orderId)
                .is('resolved_at', null);

            // Update invoices status
            await sb
                .from('invoices')
                .update({ status: 'reconciled', updated_at: now })
                .eq('po_number', orderId);

            // Update vendor_invoices status
            await sb
                .from('vendor_invoices')
                .update({ status: 'reconciled', updated_at: now })
                .eq('po_number', orderId);

            // Transition lifecycle state
            const { transitionLifecycleState } = await import('@/lib/purchasing/po-lifecycle');
            await transitionLifecycleState(
                orderId,
                'RECONCILED',
                'dashboard-receivings',
                { invoiceId: invoiceId || null, approvedAt: now },
            );

            return NextResponse.json({ ok: true, orderId, reconciled: true });
        }

        if (action === 'complete_po') {
            const { orderId, vendorName, hadFreightOnPO, invoiceFreight, freightMatched } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

            const finale = new FinaleClient();
            const result = await finale.completeOrder(orderId);
            const finalStatus = result?.finalStatus || 'ORDER_COMPLETED';

            // Record freight evidence for learning
            await recordFreightEvidence({
                orderId,
                vendorName: vendorName || '',
                hadFreightOnPO: hadFreightOnPO || false,
                invoiceFreight: invoiceFreight || 0,
                freightMatched: freightMatched || false,
                completedBy: 'dashboard',
            });

            // Invalidate caches so Active Purchases drops this PO
            const { invalidatePurchasingCaches } = await import('@/lib/purchasing/cache');
            await invalidatePurchasingCaches();

            return NextResponse.json({ completed: true, orderId, finalStatus });
        }

        if (action === 'match_invoice') {
            const { invoiceId, poNumber } = body;
            if (!invoiceId || !poNumber) {
                return NextResponse.json({ error: 'invoiceId and poNumber required' }, { status: 400 });
            }

            const sb = createClient();
            if (!sb) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

            await sb
                .from('vendor_invoices')
                .update({ po_number: poNumber })
                .eq('id', invoiceId);

            await transitionLifecycleState(poNumber, 'INVOICED', 'dashboard-receivings', { invoiceId });

            return NextResponse.json({ matched: true, invoiceId, poNumber });
        }

        if (action === 'mark_freight_pattern') {
            const { vendorName, pattern } = body;
            if (!vendorName || !pattern) {
                return NextResponse.json({ error: 'vendorName and pattern required' }, { status: 400 });
            }

            await markVendorFreightPattern(vendorName, pattern);

            return NextResponse.json({ marked: true, vendorName, pattern });
        }

        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    } catch (err: any) {
        console.error('Receivings POST error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
