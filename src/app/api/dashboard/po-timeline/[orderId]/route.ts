/**
 * @file    po-timeline/[orderId]/route.ts
 * @purpose Aggregate every event in a PO's lifecycle into a single ordered
 *          list for the Purchases panel drill-down drawer.
 *
 * Sources merged:
 *   purchase_orders     po_sent_verified_at, vendor_acknowledged_at,
 *                       tracking_requested_at, tracking_requested_at_l2,
 *                       receive_date, vendor_noncomm_at, human_reply_detected_at
 *   shipments           status_display + estimated_delivery_at + delivered_at
 *                       per tracking number
 *   invoices            received from vendor, reconciled_at
 *   ap_activity_log     reconciliation events (best-effort)
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';

export type TimelineEvent = {
    at: string;                  // ISO timestamp
    kind:
        | 'sent'
        | 'acked'
        | 'tracking_requested'
        | 'tracking_requested_l2'
        | 'tracking_landed'
        | 'in_transit'
        | 'out_for_delivery'
        | 'delivered'
        | 'received'
        | 'invoiced'
        | 'reconciled'
        | 'noncomm'
        | 'human_reply';
    label: string;
    detail?: string;
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ orderId: string }> }) {
    const { orderId } = await ctx.params;
    const supabase = createClient();
    if (!supabase) return NextResponse.json({ events: [], error: 'no supabase' }, { status: 500 });

    const events: TimelineEvent[] = [];

    // ── PO row ──
    const { data: po, error: poErr } = await supabase
        .from('purchase_orders')
        .select(
            'po_number, vendor_name, po_sent_at, po_sent_verified_at, ' +
            'vendor_acknowledged_at, vendor_ack_source, human_reply_detected_at, ' +
            'tracking_requested_at, tracking_requested_at_l2, ' +
            'vendor_noncomm_at, tracking_numbers, total_amount'
        )
        .eq('po_number', orderId)
        .maybeSingle();

    if (poErr || !po) {
        return NextResponse.json({
            events: [], poNumber: orderId, found: false,
            error: poErr?.message,
        });
    }

    if (po.po_sent_verified_at || po.po_sent_at) {
        events.push({
            at: po.po_sent_verified_at ?? po.po_sent_at!,
            kind: 'sent',
            label: 'PO sent',
            detail: po.vendor_name ?? undefined,
        });
    }
    if (po.vendor_acknowledged_at) {
        events.push({
            at: po.vendor_acknowledged_at,
            kind: 'acked',
            label: 'Vendor acknowledged',
            detail: po.vendor_ack_source ?? undefined,
        });
    }
    if (po.tracking_requested_at) {
        events.push({
            at: po.tracking_requested_at,
            kind: 'tracking_requested',
            label: 'Follow-up L1 drafted',
        });
    }
    if (po.tracking_requested_at_l2) {
        events.push({
            at: po.tracking_requested_at_l2,
            kind: 'tracking_requested_l2',
            label: 'Follow-up L2 drafted',
        });
    }
    if (po.human_reply_detected_at) {
        events.push({
            at: po.human_reply_detected_at,
            kind: 'human_reply',
            label: 'Human reply detected',
        });
    }
    if (po.vendor_noncomm_at) {
        events.push({
            at: po.vendor_noncomm_at,
            kind: 'noncomm',
            label: 'Marked vendor non-communicative',
        });
    }
    // Note: Receipt date lives in Finale (not Supabase), so the "received"
    // event is emitted by the Active Purchases data layer from shipments[].delivered_at.

    // ── Shipments ──
    const { data: ships } = await supabase
        .from('shipments')
        .select('tracking_number, status_category, status_display, estimated_delivery_at, delivered_at, last_checked_at, updated_at, created_at')
        .overlaps('po_numbers', [orderId])
        .order('created_at', { ascending: true });
    for (const s of ships ?? []) {
        if (s.created_at) {
            events.push({
                at: s.created_at,
                kind: 'tracking_landed',
                label: 'Tracking captured',
                detail: s.tracking_number,
            });
        }
        if (s.status_category === 'out_for_delivery' && s.last_checked_at) {
            events.push({
                at: s.last_checked_at,
                kind: 'out_for_delivery',
                label: 'Out for delivery',
                detail: s.tracking_number,
            });
        }
        if (s.delivered_at) {
            events.push({
                at: s.delivered_at,
                kind: 'delivered',
                label: 'Carrier confirmed delivered',
                detail: s.status_display ?? s.tracking_number,
            });
        }
    }

    // ── Invoices ──
    const { data: invs } = await supabase
        .from('invoices')
        .select('invoice_number, created_at, reconciled_at, total')
        .eq('po_number', orderId);
    for (const inv of invs ?? []) {
        if (inv.created_at) {
            events.push({
                at: inv.created_at,
                kind: 'invoiced',
                label: 'Invoice received',
                detail: inv.invoice_number ?? undefined,
            });
        }
        if (inv.reconciled_at) {
            events.push({
                at: inv.reconciled_at,
                kind: 'reconciled',
                label: 'Reconciled',
                detail: inv.invoice_number ?? undefined,
            });
        }
    }

    // Sort chronologically
    events.sort((a, b) => a.at.localeCompare(b.at));

    return NextResponse.json({
        poNumber: orderId,
        vendorName: po.vendor_name,
        total: po.total_amount,
        events,
    });
}
