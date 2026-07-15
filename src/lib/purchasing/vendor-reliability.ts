/**
 * @file    vendor-reliability.ts
 * @purpose Per-vendor rolling reliability metrics computed from existing
 *          purchase_orders + invoices + shipments tables. Pure compute,
 *          no new state. Backs the Vendor Reliability scorecard.
 *
 * Metrics (rolling 180 days):
 *   replyRate          % of sent POs where vendor_acknowledged_at is set
 *   onTimeRate         % of delivered POs that landed within median lead-time + 7d
 *   avgReplyHours      median hours from po_sent_verified_at → vendor_acknowledged_at
 *   avgDaysToDelivery  median days from po_sent_verified_at → shipments.delivered_at
 *   invoiceAccuracy    % of invoices with total within ±3% of matched PO total
 *   noncommRate        % of POs marked vendor_noncomm_at
 *   poCount            sample size in window
 */
import { createClient } from "@/lib/db";

export interface VendorReliability {
    vendorName: string;
    poCount: number;
    replyRate: number | null;          // 0..1
    onTimeRate: number | null;         // 0..1
    avgReplyHours: number | null;
    avgDaysToDelivery: number | null;
    invoiceAccuracy: number | null;    // 0..1, only when ≥2 invoices in sample
    noncommRate: number | null;        // 0..1
    grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
    /** Window covered, ISO date inclusive */
    windowStart: string;
    windowEnd: string;
}

const WINDOW_DAYS = 180;
const ON_TIME_BUFFER_DAYS = 7;

function median(nums: number[]): number | null {
    if (nums.length === 0) return null;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function gradeFromMetrics(r: Omit<VendorReliability, 'grade' | 'windowStart' | 'windowEnd'>): VendorReliability['grade'] {
    if (r.poCount === 0) return null;
    // Weighted score: reply (25%), on-time (35%), invoice (25%), noncomm penalty (15%)
    let score = 0;
    let weight = 0;
    if (r.replyRate != null) { score += r.replyRate * 25; weight += 25; }
    if (r.onTimeRate != null) { score += r.onTimeRate * 35; weight += 35; }
    if (r.invoiceAccuracy != null) { score += r.invoiceAccuracy * 25; weight += 25; }
    if (r.noncommRate != null) { score += (1 - r.noncommRate) * 15; weight += 15; }
    if (weight === 0) return null;
    const pct = score / weight; // 0..1
    if (pct >= 0.85) return 'A';
    if (pct >= 0.70) return 'B';
    if (pct >= 0.55) return 'C';
    if (pct >= 0.40) return 'D';
    return 'F';
}

export async function computeVendorReliability(): Promise<VendorReliability[]> {
    const supabase = createClient();
    if (!supabase) return [];

    const windowStart = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const windowEnd = new Date().toISOString();

    // ── POs in window ──
    const { data: pos, error } = await supabase
        .from('purchase_orders')
        .select(
            'po_number, vendor_name, po_sent_verified_at, vendor_acknowledged_at, ' +
            'vendor_noncomm_at, total_amount'
        )
        .gte('po_sent_verified_at', windowStart)
        .not('po_sent_verified_at', 'is', null)
        .not('vendor_name', 'is', null)
        .limit(2000);
    if (error || !pos) {
        console.error('[vendor-reliability] PO query failed:', error?.message);
        return [];
    }

    // ── Deliveries (shipments) ──
    const poNumbers = pos.map(p => p.po_number);
    const deliveriesByPO = new Map<string, string>(); // poNumber → delivered_at
    if (poNumbers.length > 0) {
        const { data: ships } = await supabase
            .from('shipments')
            .select('po_numbers, delivered_at')
            .overlaps('po_numbers', poNumbers)
            .not('delivered_at', 'is', null);
        for (const s of ships ?? []) {
            for (const po of (s.po_numbers ?? []) as string[]) {
                const prev = deliveriesByPO.get(po);
                if (!prev || (s.delivered_at as string) < prev) {
                    deliveriesByPO.set(po, s.delivered_at as string);
                }
            }
        }
    }

    // ── Invoices ──
    const invoicesByPO = new Map<string, { total: number | null; poTotal: number | null }>();
    if (poNumbers.length > 0) {
        const { data: invs } = await supabase
            .from('invoices')
            .select('po_number, total, total_amount')
            .in('po_number', poNumbers);
        const poTotalsByNumber = new Map(pos.map(p => [p.po_number, p.total_amount as number | null]));
        for (const inv of invs ?? []) {
            const t = (inv as any).total ?? (inv as any).total_amount ?? null;
            if (!inv.po_number) continue;
            invoicesByPO.set(inv.po_number, { total: t, poTotal: poTotalsByNumber.get(inv.po_number) ?? null });
        }
    }

    // ── Group by vendor ──
    const byVendor = new Map<string, typeof pos>();
    for (const po of pos) {
        const key = (po.vendor_name ?? '').trim();
        if (!key) continue;
        if (!byVendor.has(key)) byVendor.set(key, []);
        byVendor.get(key)!.push(po);
    }

    const out: VendorReliability[] = [];
    for (const [vendorName, vendorPOs] of byVendor) {
        const total = vendorPOs.length;
        if (total === 0) continue;

        const ackedCount = vendorPOs.filter(p => p.vendor_acknowledged_at).length;
        const noncommCount = vendorPOs.filter(p => p.vendor_noncomm_at).length;

        const replyHours: number[] = [];
        for (const po of vendorPOs) {
            if (!po.po_sent_verified_at || !po.vendor_acknowledged_at) continue;
            const sent = new Date(po.po_sent_verified_at).getTime();
            const acked = new Date(po.vendor_acknowledged_at).getTime();
            if (isNaN(sent) || isNaN(acked) || acked < sent) continue;
            replyHours.push((acked - sent) / 3_600_000);
        }

        const deliveryDays: number[] = [];
        const onTimeFlags: boolean[] = [];
        // Use vendor's own median delivery time as the on-time threshold (computed locally below).
        for (const po of vendorPOs) {
            const delivered = deliveriesByPO.get(po.po_number);
            if (!delivered || !po.po_sent_verified_at) continue;
            const sent = new Date(po.po_sent_verified_at).getTime();
            const ts = new Date(delivered).getTime();
            if (isNaN(sent) || isNaN(ts) || ts < sent) continue;
            deliveryDays.push((ts - sent) / 86_400_000);
        }
        const medianDelivery = median(deliveryDays);
        if (medianDelivery != null) {
            for (const d of deliveryDays) {
                onTimeFlags.push(d <= medianDelivery + ON_TIME_BUFFER_DAYS);
            }
        }

        const invoiceMatches: boolean[] = [];
        for (const po of vendorPOs) {
            const inv = invoicesByPO.get(po.po_number);
            if (!inv || inv.total == null || inv.poTotal == null || inv.poTotal === 0) continue;
            const diff = Math.abs(inv.total - inv.poTotal) / Math.abs(inv.poTotal);
            invoiceMatches.push(diff <= 0.03);
        }

        const partial: Omit<VendorReliability, 'grade' | 'windowStart' | 'windowEnd'> = {
            vendorName,
            poCount: total,
            replyRate: total > 0 ? ackedCount / total : null,
            onTimeRate: onTimeFlags.length > 0 ? onTimeFlags.filter(Boolean).length / onTimeFlags.length : null,
            avgReplyHours: median(replyHours),
            avgDaysToDelivery: medianDelivery,
            invoiceAccuracy: invoiceMatches.length >= 2 ? invoiceMatches.filter(Boolean).length / invoiceMatches.length : null,
            noncommRate: total > 0 ? noncommCount / total : null,
        };
        out.push({
            ...partial,
            grade: gradeFromMetrics(partial),
            windowStart,
            windowEnd,
        });
    }

    // Sort worst-first: F > D > C > B > A, then by poCount desc inside grade
    const gradeRank: Record<string, number> = { F: 0, D: 1, C: 2, B: 3, A: 4, '': 5 };
    out.sort((a, b) => {
        const ga = gradeRank[a.grade ?? ''] ?? 5;
        const gb = gradeRank[b.grade ?? ''] ?? 5;
        if (ga !== gb) return ga - gb;
        return b.poCount - a.poCount;
    });

    return out;
}
