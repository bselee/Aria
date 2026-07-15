/**
 * @file    api/dashboard/pending-approvals/route.ts
 * @purpose Returns approval queue with invoice vs PO details for review.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/db';

export async function GET() {
    const sb = createClient();
    if (!sb) return NextResponse.json({ error: 'DB not configured' }, { status: 500 });

    // Fetch pending approvals with invoice and PO data joined
    const { data: approvals } = await sb
        .from('ap_pending_approvals')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(30);

    if (!approvals || approvals.length === 0) {
        return NextResponse.json({ approvals: [], count: 0 });
    }

    // Enrich with PO data
    const poNumbers = Array.from(new Set(approvals.map((a: any) => a.order_id).filter(Boolean)));
    const { data: pos } = await sb
        .from('purchase_orders')
        .select('po_number, vendor_name, total_amount, lifecycle_stage, finale_url')
        .in('po_number', poNumbers);

    const poMap = new Map();
    for (const po of (pos || [])) {
        poMap.set(po.po_number, po);
    }

    const enriched = approvals.map((a: any) => {
        const po = poMap.get(a.order_id) || {};
        const rec = a.reconciliation_result || {};
        return {
            id: a.id,
            orderId: a.order_id,
            vendorName: a.vendor_name,
            invoiceNumber: a.invoice_number,
            verdict: a.verdict_type,
            poTotal: po.total_amount || rec.poTotal || 0,
            invoiceTotal: rec.matchedInvoice?.total || 0,
            priceChanges: rec.priceChanges || [],
            feeChanges: rec.feeChanges || [],
            totalDollarImpact: rec.totalDollarImpact || 0,
            warnings: rec.warnings || [],
            created: a.created_at,
        };
    });

    return NextResponse.json({ approvals: enriched, count: enriched.length });
}
