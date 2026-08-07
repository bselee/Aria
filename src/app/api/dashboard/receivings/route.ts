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

// ── GET response cache (paint-first) ─────────────────────────────────────
// HERMIA(2026-08-06): Panel timed out because every GET ran Finale GraphQL
// + up to 12× findPOCandidates + auto-reconcile Finale writes. Cache the
// full JSON for 3 minutes so lifecycle paint is ~ms; bust=1 forces rebuild.
type ReceivingsPayload = {
    received: any[];
    days: number;
    range: string;
    startDate: string;
    asOf: string;
    matchSuggestions: any[];
    freightClasses: Record<string, any>;
    recentAutoCompletions?: any[];
    cachedAt?: string;
    cacheAgeMs?: number;
};
let _getCache: { at: number; key: string; payload: ReceivingsPayload } | null = null;
const GET_CACHE_TTL_MS = 3 * 60 * 1000;
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

/** Extract line items from a vendor_invoices row's raw_data or cached line_items. */
function extractLineItems(inv: any): Array<{ sku?: string; qty?: number; description?: string }> | null {
    // Try raw_data.lineItems first (OCR extraction)
    const rd = inv.raw_data as Record<string, unknown> | null;
    if (rd?.lineItems && Array.isArray(rd.lineItems) && rd.lineItems.length > 0) {
        return (rd.lineItems as any[]).map((li: any) => ({
            sku: li.sku || li.productId || li.partNumber || undefined,
            qty: li.qty ?? li.quantity ?? undefined,
            description: li.description || undefined,
        }));
    }
    // Fall back to cached line_items JSON string (from invoice_cache)
    if (inv.line_items) {
        try {
            const parsed = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : inv.line_items;
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((li: any) => ({
                    sku: li.sku || li.productId || undefined,
                    qty: li.qty ?? li.quantity ?? undefined,
                    description: li.description || undefined,
                }));
            }
        } catch { /* not JSON */ }
    }
    return null;
}

export async function GET(req: NextRequest) {
    // ── Outer guard: the route MUST NEVER hang the socket ──
    // HERMIA(2026-08-06): Dropped 45s → 20s. Panel paint budget is ~5–8s;
    // anything longer feels like a timeout. Prefer cached payload over hang.
    const ROUTE_TIMEOUT_MS = 20_000;
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
        // Serve stale cache if we have one rather than empty skeleton
        if (_getCache?.payload?.received?.length) {
            const age = Date.now() - _getCache.at;
            return NextResponse.json({
                ..._getCache.payload,
                stale: true,
                cacheAgeMs: age,
                message: 'Serving cached receivings after timeout',
            }, { headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'stale-on-timeout' } });
        }
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
        const bust = searchParams.has('bust');

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

        const cacheKey = `${startStr}|${todayStr}|${matchInvoiceId || ''}`;
        if (!bust && _getCache && _getCache.key === cacheKey && (Date.now() - _getCache.at) < GET_CACHE_TTL_MS) {
            const age = Date.now() - _getCache.at;
            return NextResponse.json(
                { ..._getCache.payload, cachedAt: new Date(_getCache.at).toISOString(), cacheAgeMs: age },
                { headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'hit' } },
            );
        }

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
            // Soft budget: GraphQL must not eat the whole route timeout.
            received = await Promise.race([
                finale.getTodaysReceivedPOs(startStr, tomorrowStr),
                new Promise<any[]>((_, reject) =>
                    setTimeout(() => reject(new Error('getTodaysReceivedPOs soft budget 12s')), 12_000),
                ),
            ]);
        } catch (finaleErr: any) {
            console.warn('[receivings] Finale getTodaysReceivedPOs failed/timeout:', finaleErr?.message || finaleErr);
            // Prefer stale received list over empty if cache has one
            if (_getCache?.payload?.received?.length) {
                received = _getCache.payload.received;
            } else {
                received = [];
            }
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
                                    // HERMIA(2026-08-06): Drop junk invoices before scoring
                                    unmatchedInvoices = unmatchedInvoices.filter((inv: any) => {
                                        const total = Number(inv.total || 0);
                                        const invNo = String(inv.invoice_number || "").trim();
                                        if (total < 1 && !invNo) return false;
                                        if (total < 1) return false; // $0 placeholders
                                        return true;
                                    });
                                }

                                if (unmatchedInvoices && unmatchedInvoices.length > 0) {
                                    // HERMIA(2026-08-06): Paint budget. Was 12×4s sequential-ish scoring
                                    // + Finale auto-reconcile on GET → 45s panel timeouts.
                                    // Cap hard: 6 invoices, 2s each, concurrency 4. NO writes on GET.
                                    const toScore = unmatchedInvoices.slice(0, 6);
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
                                    // Now scoring runs in parallel at concurrency 4.
                                    // HERMIA(2026-08-06): Phase B Finale auto-apply REMOVED from GET.
                                    // GET is paint-only. Auto-match writes belong on POST/cron.
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
                                                    invoiceLineItems: extractLineItems(inv),
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
                                                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
                                            ]);
                                            if (!result) {
                                                return { inv, status: 'timed_out' as const };
                                            }
                                            return { inv, status: 'scored' as const, result };
                                        } catch (err: any) {
                                            return { inv, status: 'error' as const, err };
                                        }
                                    });

                                    // ── Phase B: suggestions only (NO Finale writes on GET) ──
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
                                                invoiceLineItems: extractLineItems(inv),
                                            });
                                            continue;
                                        }
                                        if (sr.status === 'error') {
                                            console.warn(`[receivings] Match scoring failed for invoice: ${sr.err?.message || sr.err}`);
                                            continue;
                                        }

                                        // Scored successfully — surface suggestions only
                                        const result = sr.result!;
                                        // Strip dropship POs from candidates — never match those
                                        result.candidates = (result.candidates || []).filter(
                                            (c: any) => !/DropshipPO/i.test(String(c.orderId || '')),
                                        );
                                        result.bestMatch = result.candidates[0] || null;
                                        if (result.autoApplyReady && result.bestMatch && /DropshipPO/i.test(result.bestMatch.orderId || '')) {
                                            result.autoApplyReady = false;
                                        }
                                        matchSuggestions.push({
                                            invoiceId: inv.id,
                                            invoiceNumber: inv.invoice_number,
                                            vendorName: inv.vendor_name,
                                            invoiceDate: inv.invoice_date,
                                            invoiceTotal: inv.total,
                                            candidates: result.candidates.slice(0, 5),
                                            autoApplyReady: result.autoApplyReady ?? false,
                                            fromCache: !!inv._fromCache,
                                            invoiceLineItems: extractLineItems(inv),
                                        });
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
                        // HERMIA(2026-08-06): Cap to 12 vendors — full list was burning paint budget.
                        const freightClasses: Record<string, any> = {};
                        const vendorsForFreight = vendorNames.slice(0, 12);
                        const fcResults = await mapConcurrent(vendorsForFreight, 8, async (v) => {
                            try {
                                const result = await Promise.race([
                                    getVendorFreightClassification(v),
                                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
                                ]);
                                return { vendor: v, result };
                            } catch (fcErr: any) {
                                console.warn(`[receivings] Freight classification failed for ${v}: ${fcErr?.message || fcErr}`);
                                return { vendor: v, result: undefined };
                            }
                        });
                        for (const fr of fcResults) {
                            if (fr.result !== undefined && fr.result !== null) {
                                freightClasses[fr.vendor] = fr.result;
                            }
                        }

                        const payload: ReceivingsPayload = {
                            received,
                            days: daysParam ? parseInt(daysParam, 10) : DEFAULT_RECEIVINGS_DAYS,
                            range: daysParam ? 'rolling_days' : 'rolling_30d',
                            startDate: startStr,
                            asOf: todayStr,
                            matchSuggestions,
                            freightClasses,
                            recentAutoCompletions,
                        };
                        _getCache = { at: Date.now(), key: cacheKey, payload };
                        return NextResponse.json(payload, {
                            headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'miss' },
                        });
                    }

                    const emptyPayload: ReceivingsPayload = {
                        received,
                        days: daysParam ? parseInt(daysParam, 10) : DEFAULT_RECEIVINGS_DAYS,
                        range: daysParam ? 'rolling_days' : 'rolling_30d',
                        startDate: startStr,
                        asOf: todayStr,
                        matchSuggestions: [],
                        freightClasses: {},
                    };
                    _getCache = { at: Date.now(), key: cacheKey, payload: emptyPayload };
                    return NextResponse.json(emptyPayload, {
                        headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'miss-empty' },
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

            // ── HERMIA(2026-07-29): 3-way match enforcement ─────────────────
            // This handler previously flipped ap_pending_approvals,
            // reconciliation_outcomes, invoices and vendor_invoices to
            // 'approved'/'reconciled' and returned ok:true — WITHOUT ever
            // contacting Finale and without comparing the three documents.
            // Every click wrote a false "reconciled" state: the DB claimed the
            // corrections had posted while Finale never received them.
            //
            // Correct AP order of operations is now enforced:
            //   1. Load the stored reconciliation for this PO.
            //   2. Push the approved price/freight changes to Finale FIRST.
            //   3. Only if Finale accepts the write, record 'reconciled' in the DB.
            // A failure at step 2 returns 4xx/5xx so the operator sees it,
            // instead of a green tick over an unposted correction.
            const { data: approval } = await sb
                .from('ap_pending_approvals')
                .select('id, reconciliation_result, invoice_number, status')
                .eq('order_id', orderId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            const reconciliationResult = (approval as any)?.reconciliation_result;

            if (!reconciliationResult) {
                // Nothing to post. Refuse rather than mark the PO reconciled.
                return NextResponse.json(
                    {
                        error: 'No reconciliation on file for this PO',
                        detail:
                            `No stored reconciliation_result was found for ${orderId}, so there is ` +
                            `nothing to push to Finale. Re-run the AP match for this PO before approving.`,
                        orderId,
                        applied: false,
                    },
                    { status: 409 },
                );
            }

            // Step 2: post to Finale BEFORE claiming success anywhere.
            let appliedCount = 0;
            try {
                const { applyReconciliation } = await import('@/lib/finale/reconciler');
                const finaleClient = new FinaleClient();
                const applyResult = await applyReconciliation(reconciliationResult as any, finaleClient);
                appliedCount = applyResult.applied.length;

                if (applyResult.errors.length > 0) {
                    return NextResponse.json(
                        {
                            error: 'Finale rejected part of the reconciliation',
                            detail: applyResult.errors.join('; '),
                            orderId,
                            applied: false,
                            appliedCount,
                        },
                        { status: 502 },
                    );
                }
            } catch (err: any) {
                console.error(`[receivings/approve] Finale apply failed for ${orderId}:`, err?.message);
                return NextResponse.json(
                    {
                        error: 'Failed to apply reconciliation to Finale',
                        detail: err?.message ?? String(err),
                        orderId,
                        applied: false,
                    },
                    { status: 502 },
                );
            }

            // Step 3: Finale accepted the write — now it is true to say reconciled.
            const approvalId = (approval as any)?.id;
            if (approvalId) {
                await sb
                    .from('ap_pending_approvals')
                    .update({ status: 'approved', resolved_at: now })
                    .eq('id', approvalId);
            } else if (invoiceId) {
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
                { invoiceId: invoiceId || null, approvedAt: now, appliedCount },
            );

            return NextResponse.json({ ok: true, orderId, reconciled: true, applied: true, appliedCount });
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
