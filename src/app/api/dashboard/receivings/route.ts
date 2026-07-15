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

export function getDenverWeekStart(date: Date): string {
    const denverNow = new Date(date.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    const day = denverNow.getDay();
    const daysSinceMonday = (day + 6) % 7;
    denverNow.setDate(denverNow.getDate() - daysSinceMonday);
    return denverNow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

export async function GET(req: NextRequest) {
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
        const received = await finale.getTodaysReceivedPOs(startStr, tomorrowStr);

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
                const { data: unmatchedInvoices } = await sb
                    .from('vendor_invoices')
                    .select('id, invoice_number, vendor_name, invoice_date, subtotal, freight, tax, total, raw_data')
                    .is('po_number', null)
                    .in('vendor_name', vendorNames)
                    .order('created_at', { ascending: false })
                    .limit(20);

                if (unmatchedInvoices && unmatchedInvoices.length > 0) {
                    for (const inv of unmatchedInvoices) {
                        try {
                            const result = await findPOCandidates({
                                id: inv.id,
                                invoiceNumber: inv.invoice_number,
                                vendorName: inv.vendor_name,
                                invoiceDate: inv.invoice_date,
                                subtotal: Number(inv.subtotal || 0),
                                freight: Number(inv.freight || 0),
                                tax: Number(inv.tax || 0),
                                total: Number(inv.total || 0),
                                lineItems: inv.raw_data?.lineItems || [],
                            });
                            // Auto-apply high-confidence matches: score ≥80 and autoApplyReady
                            const best = result.candidates[0];
                            const shouldAutoApply = best && best.score >= 80 && result.autoApplyReady;

                            if (shouldAutoApply) {
                                // Auto-match: link invoice to PO silently
                                try {
                                    await sb
                                        .from('vendor_invoices')
                                        .update({ po_number: best.orderId, status: 'reconciled', updated_at: new Date().toISOString() })
                                        .eq('id', inv.id);

                                    // Auto-complete: if no price/qty issues, transition lifecycle
                                    const { transitionLifecycleState } = await import('@/lib/purchasing/po-lifecycle');
                                    await transitionLifecycleState(
                                        best.orderId,
                                        'RECONCILED',
                                        'auto-matcher',
                                        { invoice: inv.invoice_number, score: best.score, reasons: best.reasons }
                                    );
                                } catch { /* auto-apply failed silently */ }
                                // Don't add to suggestions — it's handled
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
                                });
                            }
                        } catch { /* skip individual match failures */ }
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
            } catch { /* skip recent completions */ }

            // ── Freight classifications for received PO vendors ──
            const freightClasses: Record<string, any> = {};
            for (const v of vendorNames) {
                try {
                    freightClasses[v] = await getVendorFreightClassification(v);
                } catch { /* skip */ }
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
