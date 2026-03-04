/**
 * @file    reorder-engine.ts
 * @purpose Prescriptive reorder intelligence.
 *          Takes an existing BuildRiskReport and generates concrete action items:
 *            - "PERLITE runs out Mar 10 (7d) — order 3,600 → 56d runway"
 *            - "CRAFT4 selling 12/day → build 360 → 30d on shelf"
 *          Fetches lead times from Finale for at-risk components (5x parallel).
 *          Never throws — returns empty array on any error.
 */

import { ComponentDemand, FGVelocity } from './build-risk';
import { leadTimeService } from './lead-time-service';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface ReorderPrescription {
    componentSku: string;
    riskLevel: 'CRITICAL' | 'WARNING';
    stockoutDays: number;
    stockoutDate: string;               // e.g. "Mar 10"
    dailyConsumptionRate: number;       // units/day (90d avg from Finale)
    impliedStock: number;               // ≈ stockoutDays × dailyRate
    leadTimeDays: number | null;
    suggestedOrderQty: number;          // rounded to nearest 100
    daysAfterOrder: number;             // runway once order arrives
    incomingPOs: ComponentDemand['incomingPOs'];
    affectedFGSkus: string[];
    fgSuggestions: Array<{
        fgSku: string;
        dailySalesRate: number;
        currentFGStock: number | null;
        suggestedBuildQty: number;      // dailySalesRate × 30, rounded to 10
        daysAfterBuild: number | null;
    }>;
}

// ──────────────────────────────────────────────────
// ENGINE
// ──────────────────────────────────────────────────

/**
 * Generate reorder prescriptions from a completed BuildRiskReport.
 *
 * Only processes CRITICAL and WARNING components with ≤45-day stockout
 * AND meaningful consumption data (consumptionQuantity or demandQuantity > 0).
 *
 * Lead times are fetched from Finale in parallel (5x concurrency, ~10-15s for 20 SKUs).
 * If Finale has no lead time set for a component, we default to 14 days.
 */
export async function generateReorderPrescriptions(
    components: Map<string, ComponentDemand>,
    fgVelocity: Map<string, FGVelocity>,
): Promise<ReorderPrescription[]> {
    const atRisk = Array.from(components.values()).filter(c =>
        (c.riskLevel === 'CRITICAL' || c.riskLevel === 'WARNING') &&
        c.stockoutDays !== null &&
        c.stockoutDays <= 45
    );

    if (atRisk.length === 0) return [];

    // Warm vendor lead time cache once before the batch (no-op if already fresh)
    await leadTimeService.warmCache();

    // Batch resolve lead times using vendor history → SKU product → 14d default
    const leadTimes = new Map<string, number | null>();
    const queue = atRisk.map(c => c.componentSku);
    const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
        while (queue.length > 0) {
            const sku = queue.shift()!;
            const comp = components.get(sku);
            // If getComponentStockProfile already populated leadTimeDays, use it as the
            // SKU-level hint. Vendor history takes priority if available.
            const vendorName = comp?.incomingPOs?.[0]?.supplier ?? '';
            const lt = await leadTimeService.getForVendor(vendorName, sku);
            leadTimes.set(sku, lt.days);
        }
    });
    await Promise.all(workers);

    const today = new Date();
    const prescriptions: ReorderPrescription[] = [];

    for (const comp of atRisk) {
        // Daily consumption rate: prefer actual consumption (from build WOs),
        // fall back to demand quantity (projected build demand). Both are 90d windows.
        const base = comp.consumptionQuantity ?? comp.demandQuantity;
        if (!base || base <= 0) continue;
        const dailyRate = base / 90;

        const days = comp.stockoutDays!;
        const stockoutDate = new Date(today);
        stockoutDate.setDate(stockoutDate.getDate() + days);
        const stockoutDateStr = stockoutDate.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', timeZone: 'America/Denver',
        });

        const impliedStock = Math.round(days * dailyRate);
        const lead = leadTimes.get(comp.componentSku) ?? null;

        // Order covers: lead time + 60-day buffer, rounded up to nearest 100
        const buffer = (lead ?? 14) + 60;
        const suggestedOrderQty = Math.max(100, Math.ceil(dailyRate * buffer / 100) * 100);
        const daysAfterOrder = Math.round((impliedStock + suggestedOrderQty) / dailyRate);

        // FG build suggestions for each finished good that uses this component
        const fgSuggestions: ReorderPrescription['fgSuggestions'] = [];
        for (const fgSku of Array.from(comp.usedIn)) {
            const vel = fgVelocity.get(fgSku);
            if (!vel || vel.dailyRate <= 0) continue;
            // Build 30 days of sales, rounded to nearest 10
            const buildQty = Math.max(10, Math.ceil(vel.dailyRate * 30 / 10) * 10);
            const stockAfterBuild = (vel.stockOnHand ?? 0) + buildQty;
            const daysAfterBuild = Math.round(stockAfterBuild / vel.dailyRate);
            fgSuggestions.push({
                fgSku,
                dailySalesRate: vel.dailyRate,
                currentFGStock: vel.stockOnHand,
                suggestedBuildQty: buildQty,
                daysAfterBuild,
            });
        }

        prescriptions.push({
            componentSku: comp.componentSku,
            riskLevel: comp.riskLevel as 'CRITICAL' | 'WARNING',
            stockoutDays: days,
            stockoutDate: stockoutDateStr,
            dailyConsumptionRate: dailyRate,
            impliedStock,
            leadTimeDays: lead,
            suggestedOrderQty,
            daysAfterOrder,
            incomingPOs: comp.incomingPOs,
            affectedFGSkus: Array.from(comp.usedIn),
            fgSuggestions: fgSuggestions.sort((a, b) => b.dailySalesRate - a.dailySalesRate),
        });
    }

    return prescriptions.sort((a, b) => a.stockoutDays - b.stockoutDays);
}

// ──────────────────────────────────────────────────
// FORMATTERS
// ──────────────────────────────────────────────────

export function formatPrescriptionsTelegram(prescriptions: ReorderPrescription[]): string {
    if (prescriptions.length === 0) return '';

    const count = prescriptions.length;
    let msg = `🧠 *Smart Reorder Alerts — ${count} component${count !== 1 ? 's' : ''} need action*\n\n`;

    for (const p of prescriptions) {
        const icon = p.riskLevel === 'CRITICAL' ? '🔴' : '🟡';
        const rate = p.dailyConsumptionRate < 1
            ? p.dailyConsumptionRate.toFixed(1)
            : Math.round(p.dailyConsumptionRate).toLocaleString();
        const leadStr = p.leadTimeDays !== null ? ` · Lead: ${p.leadTimeDays}d` : '';
        const poNote = p.incomingPOs.length > 0
            ? ` · ⚠️ ${p.incomingPOs.length} PO coming`
            : '';

        msg += `${icon} *\`${p.componentSku}\`* — out ~*${p.stockoutDate}* (${p.stockoutDays}d)\n`;
        msg += `  Rate: ${rate}/day${leadStr}${poNote}\n`;
        msg += `  📦 Order *${p.suggestedOrderQty.toLocaleString()}* → ${p.daysAfterOrder}d runway\n`;

        if (p.fgSuggestions.length > 0) {
            msg += `  🏭 Builds:\n`;
            for (const fg of p.fgSuggestions.slice(0, 3)) {
                const fgRate = fg.dailySalesRate < 1
                    ? fg.dailySalesRate.toFixed(1)
                    : Math.round(fg.dailySalesRate).toString();
                const afterBuild = fg.daysAfterBuild !== null ? ` → ${fg.daysAfterBuild}d stock` : '';
                msg += `    • \`${fg.fgSku}\`: ${fgRate}/day → build *${fg.suggestedBuildQty.toLocaleString()}*${afterBuild}\n`;
            }
            if (p.fgSuggestions.length > 3) {
                msg += `    _+${p.fgSuggestions.length - 3} more builds_\n`;
            }
        }
        msg += `\n`;
    }

    return msg.trim();
}

/**
 * Compact format for the /alerts bot command — shows recent alerts from Supabase.
 */
export function formatAlertsDigest(rows: Array<{
    sku: string;
    risk_level: string;
    stockout_days: number | null;
    suggested_order_qty: number | null;
    days_after_order: number | null;
    alerted_at: string;
}>): string {
    if (rows.length === 0) return '✅ No active reorder alerts in the last 24 hours.';

    let msg = `🧠 *Reorder Alerts — Last 24h*\n\n`;
    for (const r of rows) {
        const icon = r.risk_level === 'CRITICAL' ? '🔴' : '🟡';
        const ago = Math.round((Date.now() - new Date(r.alerted_at).getTime()) / 60000);
        const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
        const orderNote = r.suggested_order_qty
            ? ` · Order ${r.suggested_order_qty.toLocaleString()} → ${r.days_after_order ?? '?'}d`
            : '';
        msg += `${icon} \`${r.sku}\` — ${r.stockout_days ?? '?'}d to stockout${orderNote} _(${agoStr})_\n`;
    }
    msg += `\n_Run /buildrisk for full analysis with build suggestions._`;
    return msg;
}
