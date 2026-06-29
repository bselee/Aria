/**
 * @file    api/dashboard/receivings/route.ts
 * @purpose Returns Finale received POs enriched with local reconciliation data.
 *          For each received PO, shows: matched invoice, price changes,
 *          freight/tax adjustments, and approval status.
 *          Enables one-click "Approve & Apply" from the receivings panel.
 * @updated 2026-06-29 — added reconciliation enrichment
 */

import { NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';
import { createClient } from '@/lib/supabase';

export function getDenverWeekStart(date: Date): string {
    const denverNow = new Date(date.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    const day = denverNow.getDay();
    const daysSinceMonday = (day + 6) % 7;
    denverNow.setDate(denverNow.getDate() - daysSinceMonday);
    return denverNow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const daysParam = searchParams.get('days');

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const startStr = daysParam
            ? (() => {
                const days = parseInt(daysParam, 10);
                const start = new Date(now);
                start.setDate(start.getDate() - days);
                return start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            })()
            : getDenverWeekStart(now);

        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const finale = new FinaleClient();
        const received = await finale.getTodaysReceivedPOs(startStr, tomorrowStr);

        // Enrich with reconciliation data from local Postgres
        const sb = createClient();
        if (sb && received.length > 0) {
            // Extract PO numbers from received data
            const poNumbers = received
                .map((r: any) => r.poNumber || r.orderId)
                .filter(Boolean);

            if (poNumbers.length > 0) {
                // Fetch vendor invoices matching these POs
                const { data: invoices } = await sb
                    .from('vendor_invoices')
                    .select('po_number, invoice_number, subtotal, freight, tax, total, status, created_at')
                    .in('po_number', poNumbers)
                    .order('created_at', { ascending: false });

                // Fetch reconciliation outcomes for these POs
                const { data: outcomes } = await sb
                    .from('reconciliation_outcomes')
                    .select('po_id, invoice_id, outcome, outcome_meta, created_at, resolved_at')
                    .in('po_id', poNumbers)
                    .order('created_at', { ascending: false });

                // Build lookup maps
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

                // Attach reconciliation data to each received PO
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
        }

        return NextResponse.json({
            received,
            days: daysParam ? parseInt(daysParam, 10) : null,
            range: daysParam ? 'rolling_days' : 'week_to_date',
            startDate: startStr,
            asOf: todayStr,
        });
    } catch (err: any) {
        console.error('Receivings API error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
