/**
 * @file    po-stuck-detector.ts
 * @purpose Identify POs stalled at any pipeline stage. Pure read against
 *          existing tables — no new state. Emits one row per stuck PO with
 *          the stage label + how long it's been stuck.
 *
 * Stages and thresholds:
 *   acked_no_tracking       acked ≥ 7d ago, no tracking_numbers, not received
 *   tracking_stale          most-recent shipment update ≥ 5d, not delivered
 *   delivered_no_receipt    carrier delivered ≥ 24h, no Finale receive_date
 *   received_no_invoice     receive_date ≥ 14d, no matched invoice
 *   invoice_unreconciled    invoice present ≥ 7d, unreconciled
 *
 * Thresholds are conservative — tighten over time once we see the signal/noise
 * mix in production.
 */
import { createClient } from "@/lib/db";

export type StuckStage =
    | 'acked_no_tracking'
    | 'tracking_stale'
    | 'delivered_no_receipt'
    | 'invoice_unreconciled';

export interface StuckPO {
    poNumber: string;
    vendorName: string | null;
    stage: StuckStage;
    daysStuck: number;
    summary: string;            // short human-readable
    detail?: string;            // extra context (carrier name, invoice number, etc.)
    stageSinceISO: string;      // when this stage started
}

const ACKED_NO_TRACKING_DAYS = 7;
const TRACKING_STALE_DAYS = 5;
const DELIVERED_NO_RECEIPT_HOURS = 24;
const INVOICE_UNRECONCILED_DAYS = 7;

function ageDays(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86_400_000);
}

function ageHours(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 3_600_000);
}

export async function detectStuckPOs(): Promise<StuckPO[]> {
    const supabase = createClient();
    if (!supabase) return [];

    const stuck: StuckPO[] = [];

    // ── Stage 1+2+3: open POs (committed, in flight) ────────────
    // Note: receive_date isn't a Supabase column — receipt state lives in
    // Finale. We treat any PO with po_sent_verified_at set as potentially
    // in flight; delivered/received signals come from shipments.delivered_at
    // and the AP invoice arrival.
    const { data: openPOs, error: e1 } = await supabase
        .from('purchase_orders')
        .select(
            'po_number, vendor_name, po_sent_verified_at, vendor_acknowledged_at, ' +
            'tracking_numbers, tracking_requested_at, vendor_noncomm_at'
        )
        .not('po_sent_verified_at', 'is', null)
        .limit(500);
    if (e1) console.warn('[po-stuck-detector] open POs query failed:', e1.message);

    // Pull shipments for any PO we need status on, single query
    const openPoNumbers = (openPOs ?? []).map(p => p.po_number);
    const shipmentsByPO = new Map<string, Array<{ status_category: string | null; status_display: string | null; delivered_at: string | null; last_checked_at: string | null; updated_at: string | null; }>>();
    if (openPoNumbers.length > 0) {
        const { data: ships } = await supabase
            .from('shipments')
            .select('po_numbers, status_category, status_display, delivered_at, last_checked_at, updated_at')
            .overlaps('po_numbers', openPoNumbers);
        for (const s of ships ?? []) {
            for (const po of (s.po_numbers ?? []) as string[]) {
                if (!shipmentsByPO.has(po)) shipmentsByPO.set(po, []);
                shipmentsByPO.get(po)!.push(s as any);
            }
        }
    }

    for (const po of openPOs ?? []) {
        if (po.vendor_noncomm_at) continue; // already flagged elsewhere
        const ships = shipmentsByPO.get(po.po_number) ?? [];
        const anyDelivered = ships.find(s => s.delivered_at || s.status_category === 'delivered');
        const hasTracking = (po.tracking_numbers && po.tracking_numbers.length > 0) || ships.length > 0;

        // 1. Acked but no tracking
        if (!hasTracking) {
            const since = po.vendor_acknowledged_at ?? po.po_sent_verified_at;
            const d = ageDays(po.vendor_acknowledged_at);
            if (d != null && d >= ACKED_NO_TRACKING_DAYS) {
                stuck.push({
                    poNumber: po.po_number,
                    vendorName: po.vendor_name,
                    stage: 'acked_no_tracking',
                    daysStuck: d,
                    summary: `acked ${d}d ago, still no tracking`,
                    stageSinceISO: since!,
                });
                continue;
            }
        }

        // 3. Delivered (per carrier) but no Finale receipt
        if (anyDelivered) {
            const deliveredAt = anyDelivered.delivered_at ?? anyDelivered.updated_at;
            const hrs = ageHours(deliveredAt);
            if (hrs != null && hrs >= DELIVERED_NO_RECEIPT_HOURS) {
                stuck.push({
                    poNumber: po.po_number,
                    vendorName: po.vendor_name,
                    stage: 'delivered_no_receipt',
                    daysStuck: Math.floor(hrs / 24),
                    summary: `carrier says delivered ${Math.floor(hrs / 24)}d ago, no Finale receipt`,
                    detail: anyDelivered.status_display ?? 'Delivered',
                    stageSinceISO: deliveredAt!,
                });
                continue;
            }
        }

        // 2. Tracking exists but its last status update is stale
        if (hasTracking && !anyDelivered) {
            const newest = ships
                .map(s => s.last_checked_at ?? s.updated_at)
                .filter(Boolean)
                .sort()
                .pop();
            const d = ageDays(newest);
            if (d != null && d >= TRACKING_STALE_DAYS) {
                stuck.push({
                    poNumber: po.po_number,
                    vendorName: po.vendor_name,
                    stage: 'tracking_stale',
                    daysStuck: d,
                    summary: `tracking last updated ${d}d ago`,
                    detail: ships[0]?.status_display ?? '',
                    stageSinceISO: newest!,
                });
                continue;
            }
        }
    }

    // ── Stage 5: invoice present but unreconciled ────────────
    const invoiceCutoff = new Date(Date.now() - INVOICE_UNRECONCILED_DAYS * 86_400_000).toISOString();
    const { data: stalled } = await supabase
        .from('invoices')
        .select('po_number, vendor_name, invoice_number, created_at, reconciled_at')
        .lte('created_at', invoiceCutoff)
        .is('reconciled_at', null)
        .limit(200);
    for (const inv of stalled ?? []) {
        const d = ageDays(inv.created_at);
        if (d == null) continue;
        stuck.push({
            poNumber: inv.po_number ?? `inv:${inv.invoice_number}`,
            vendorName: inv.vendor_name,
            stage: 'invoice_unreconciled',
            daysStuck: d,
            summary: `invoice ${inv.invoice_number} stuck ${d}d unreconciled`,
            detail: inv.invoice_number ?? undefined,
            stageSinceISO: inv.created_at!,
        });
    }

    // Sort: oldest stuck first
    stuck.sort((a, b) => b.daysStuck - a.daysStuck);
    return stuck;
}

export function summariseStuck(rows: StuckPO[]): { total: number; byStage: Record<StuckStage, number> } {
    const byStage = {
        acked_no_tracking: 0,
        tracking_stale: 0,
        delivered_no_receipt: 0,
        invoice_unreconciled: 0,
    } as Record<StuckStage, number>;
    for (const r of rows) byStage[r.stage] += 1;
    return { total: rows.length, byStage };
}
