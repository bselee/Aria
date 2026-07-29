/**
 * @file    assess-active-pos.ts
 * @purpose Realistic assessment of all active POs — groups by risk, shows vendor
 *          patterns, indicates what action is actually needed. Not just a list.
 * @author  Hermia
 * @created 2026-07-29
 * @deps    @/lib/finale/client, @/lib/purchasing/active-purchases
 *
 * Usage:
 *   node --import tsx src/cli/assess-active-pos.ts
 *   node --import tsx src/cli/assess-active-pos.ts --vendor "Thorvin"
 *   node --import tsx src/cli/assess-active-pos.ts --risk critical
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { FinaleClient } from "@/lib/finale/client";
import { loadActivePurchases, type ActivePurchase } from "@/lib/purchasing/active-purchases";

// ── Constants ────────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_MS = Date.now();
const MS_PER_DAY = 86_400_000;

type RiskLevel = "critical" | "at_risk" | "on_track" | "long_lead" | "unknown";

interface AssessedPO {
    orderId: string;
    vendorName: string;
    orderDate: string;
    total: number;
    daysSinceOrder: number;
    expectedDate: string;
    daysUntilExpected: number;
    isOverdue: boolean;
    daysOverdue: number;
    risk: RiskLevel;
    riskReason: string;
    hasTracking: boolean;
    trackingCount: number;
    hasTrackingDelivery: boolean;
    lifecycleStage: string;
    completionState: string;
    etaSource: string;
    etaConfidence: string;
    vendorHasMultiplePOs: boolean;
    vendorLateCount: number;
    action: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysDiff(a: string, b: string): number {
    return Math.floor((new Date(a).getTime() - new Date(b).getTime()) / MS_PER_DAY);
}

function fmt(n: number): string {
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDollar(n: number): string {
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// ── Assessment Logic ─────────────────────────────────────────────────────────

function assessRisk(po: ActivePurchase, vendorLateCount: number): { risk: RiskLevel; reason: string; action: string } {
    const expDate = po.etaProfile?.expectedDate || po.expectedDate;
    const daysLate = expDate ? daysDiff(TODAY, expDate) : 0;
    const isOverdue = daysLate > 0;
    const hasTracking = (po.trackingNumbers?.length || 0) > 0 || po.shipments.length > 0;
    const hasDelivery = po.shipments.length > 0 && po.shipments.every(s => s.status_category === "delivered");
    const daysSinceOrder = po.orderDate ? daysDiff(TODAY, po.orderDate) : 0;
    const confidence = po.etaProfile?.confidence || "low";

    // Critical: Overdue with no tracking at all — can't even see where it is
    if (isOverdue && !hasTracking && daysLate > 7) {
        return {
            risk: "critical",
            reason: `Overdue ${daysLate}d with NO tracking — blind spot. Ordered ${daysSinceOrder}d ago.`,
            action: "Email vendor for status + tracking number immediately.",
        };
    }

    // Critical: Overdue with tracking but vendor is a repeat offender
    if (isOverdue && vendorLateCount >= 2 && daysLate > 10) {
        return {
            risk: "critical",
            reason: `Overdue ${daysLate}d — vendor has ${vendorLateCount} late POs. Ordered ${daysSinceOrder}d ago.`,
            action: "Escalate to vendor. Multiple late POs from this supplier — systemic issue.",
        };
    }

    // Critical: Overdue more than 14 days
    if (isOverdue && daysLate > 14) {
        return {
            risk: "critical",
            reason: `Overdue ${daysLate}d. Ordered ${daysSinceOrder}d ago. ${confidence} confidence ETA.`,
            action: "Check tracking for delivery scan. If no scan, email vendor.",
        };
    }

    // At Risk: Overdue but within 14 days
    if (isOverdue && daysLate <= 14) {
        return {
            risk: "at_risk",
            reason: `Overdue ${daysLate}d. ${hasTracking ? "Has tracking — check carrier." : "No tracking."}`,
            action: hasTracking ? "Check carrier tracking for delivery status." : "Request tracking from vendor.",
        };
    }

    // At Risk: Due within 3 days, no tracking
    if (!isOverdue && expDate && daysDiff(expDate, TODAY) <= 3 && !hasTracking) {
        return {
            risk: "at_risk",
            reason: `Due in ${daysDiff(expDate, TODAY)}d with no tracking. ${confidence} confidence ETA.`,
            action: "Request tracking from vendor before due date.",
        };
    }

    // At Risk: Due within 7 days, low confidence ETA
    if (!isOverdue && expDate && daysDiff(expDate, TODAY) <= 7 && confidence === "low") {
        return {
            risk: "at_risk",
            reason: `Due in ${daysDiff(expDate, TODAY)}d — low confidence ETA (${po.etaProfile?.source || "default"}).`,
            action: "Verify ETA with vendor or check for tracking updates.",
        };
    }

    // Tracking shows delivered but not marked received
    if (hasDelivery) {
        return {
            risk: "at_risk",
            reason: "Tracking shows DELIVERED but not marked received in Finale.",
            action: "Mark receipt in Finale immediately — goods are there.",
        };
    }

    // Long Lead: Due more than 30 days out
    if (expDate && daysDiff(expDate, TODAY) > 30) {
        return {
            risk: "long_lead",
            reason: `Due in ${daysDiff(expDate, TODAY)}d.`,
            action: "No action needed now. Check back in 3 weeks.",
        };
    }

    // On Track: Everything looks normal
    return {
        risk: "on_track",
        reason: `Due in ${expDate ? daysDiff(expDate, TODAY) : "?"}d. ${hasTracking ? "Tracking active." : "Awaiting tracking."}`,
        action: hasTracking ? "Monitor tracking." : "No action — within expected window.",
    };
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
    console.log("🔍 Active PO Assessment");
    console.log("═══════════════════════\n");

    const args = process.argv.slice(2);
    const vendorFilter = args.includes("--vendor")
        ? args[args.indexOf("--vendor") + 1]?.toLowerCase()
        : null;
    const riskFilter = args.includes("--risk")
        ? args[args.indexOf("--risk") + 1]?.toLowerCase()
        : null;

    const finale = new FinaleClient();
    const activePos = await loadActivePurchases(finale, 60);

    if (activePos.length === 0) {
        console.log("✅ No active POs.");
        process.exit(0);
    }

    // Build vendor late-count index
    const vendorLateMap = new Map<string, number>();
    for (const po of activePos) {
        const expDate = po.etaProfile?.expectedDate || po.expectedDate;
        if (expDate && new Date(expDate).getTime() < TODAY_MS) {
            const key = po.vendorName.toLowerCase();
            vendorLateMap.set(key, (vendorLateMap.get(key) || 0) + 1);
        }
    }

    // Assess each PO
    const assessed: AssessedPO[] = activePos.map(po => {
        const expDate = po.etaProfile?.expectedDate || po.expectedDate;
        const isOverdue = expDate ? new Date(expDate).getTime() < TODAY_MS : false;
        const daysLate = isOverdue && expDate ? daysDiff(TODAY, expDate) : 0;
        const hasTracking = (po.trackingNumbers?.length || 0) > 0 || po.shipments.length > 0;
        const hasDelivery = po.shipments.length > 0 && po.shipments.every(s => s.status_category === "delivered");
        const vendorKey = po.vendorName.toLowerCase();
        const vendorLateCount = vendorLateMap.get(vendorKey) || 0;
        const assessment = assessRisk(po, vendorLateCount);

        return {
            orderId: po.orderId,
            vendorName: po.vendorName,
            orderDate: po.orderDate || "",
            total: po.total,
            daysSinceOrder: po.orderDate ? daysDiff(TODAY, po.orderDate) : 0,
            expectedDate: expDate || "?",
            daysUntilExpected: expDate ? daysDiff(expDate, TODAY) : 999,
            isOverdue,
            daysOverdue: daysLate,
            risk: assessment.risk,
            riskReason: assessment.reason,
            hasTracking,
            trackingCount: (po.trackingNumbers?.length || 0) + po.shipments.length,
            hasTrackingDelivery: hasDelivery,
            lifecycleStage: po.lifecycleStage || "none",
            completionState: po.completionState,
            etaSource: po.etaProfile?.source || "default",
            etaConfidence: po.etaProfile?.confidence || "low",
            vendorHasMultiplePOs: vendorLateCount >= 2,
            vendorLateCount,
            action: assessment.action,
        };
    });

    // Filter
    let filtered = assessed;
    if (vendorFilter) {
        filtered = filtered.filter(a => a.vendorName.toLowerCase().includes(vendorFilter));
    }
    if (riskFilter) {
        filtered = filtered.filter(a => a.risk === riskFilter);
    }

    // Sort: critical first, then at_risk, then on_track, then long_lead
    const riskOrder: Record<RiskLevel, number> = { critical: 0, at_risk: 1, on_track: 2, long_lead: 3, unknown: 4 };
    filtered.sort((a, b) => {
        const r = riskOrder[a.risk] - riskOrder[b.risk];
        if (r !== 0) return r;
        // Within same risk: most overdue first
        return b.daysOverdue - a.daysOverdue;
    });

    // ── Summary ───────────────────────────────────────────────────────────────

    const byRisk = new Map<RiskLevel, AssessedPO[]>();
    for (const a of filtered) {
        const list = byRisk.get(a.risk) || [];
        list.push(a);
        byRisk.set(a.risk, list);
    }

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  RISK SUMMARY");
    console.log("═══════════════════════════════════════════════════════════════");
    for (const [risk, pos] of [
        ["critical", byRisk.get("critical") || []],
        ["at_risk", byRisk.get("at_risk") || []],
        ["on_track", byRisk.get("on_track") || []],
        ["long_lead", byRisk.get("long_lead") || []],
    ] as [RiskLevel, AssessedPO[]][]) {
        if (pos.length === 0) continue;
        const total = pos.reduce((s, p) => s + p.total, 0);
        const icons: Record<string, string> = { critical: "🔴", at_risk: "🟡", on_track: "🟢", long_lead: "🔵" };
        console.log(`  ${icons[risk] || ""} ${risk.toUpperCase().padEnd(12)} ${pos.length} POs · ${fmtDollar(total)}`);
    }

    // ── Vendor Patterns ───────────────────────────────────────────────────────

    // Find vendors with 3+ active POs
    const vendorCounts = new Map<string, { count: number; late: number; total: number }>();
    for (const a of filtered) {
        const key = a.vendorName.toLowerCase();
        const entry = vendorCounts.get(key) || { count: 0, late: 0, total: 0 };
        entry.count++;
        if (a.isOverdue) entry.late++;
        entry.total += a.total;
        vendorCounts.set(key, entry);
    }

    const multiVendors = [...vendorCounts.entries()]
        .filter(([, v]) => v.count >= 3)
        .sort(([, a], [, b]) => b.total - a.total);

    if (multiVendors.length > 0) {
        console.log("\n  VENDOR PATTERNS (3+ active POs):");
        for (const [name, v] of multiVendors) {
            const displayName = filtered.find(a => a.vendorName.toLowerCase() === name)?.vendorName || name;
            const flag = v.late >= 2 ? " ⚠️ REPEAT OFFENDER" : "";
            console.log(`    ${displayName.padEnd(30)} ${v.count} POs · ${v.late} late · ${fmtDollar(v.total)}${flag}`);
        }
    }

    // ── Detailed Assessment ───────────────────────────────────────────────────

    for (const [risk, icon, label] of [
        ["critical", "🔴", "CRITICAL — Immediate Action Required"],
        ["at_risk", "🟡", "AT RISK — Needs Attention Soon"],
        ["on_track", "🟢", "ON TRACK — Monitor"],
        ["long_lead", "🔵", "LONG LEAD — Future Delivery"],
    ] as [RiskLevel, string, string][]) {
        const pos = byRisk.get(risk) || [];
        if (pos.length === 0) continue;

        const total = pos.reduce((s, p) => s + p.total, 0);
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`  ${icon} ${label}  —  ${pos.length} POs · ${fmtDollar(total)}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        for (const po of pos) {
            const overdueTag = po.isOverdue ? ` ⚠ overdue ${po.daysOverdue}d` : "";
            const trackingTag = po.hasTracking
                ? po.hasTrackingDelivery ? " 📦 DELIVERED" : ` 📍 ${po.trackingCount} tracking`
                : " ❌ NO TRACKING";
            const vendorTag = po.vendorLateCount >= 3 ? " 🔁 repeat" : "";
            const confTag = po.etaConfidence === "low" ? " (low conf)" : "";

            console.log(`  ${po.orderId.padEnd(8)} ${po.vendorName.padEnd(28)} ${fmtDollar(po.total).padStart(10)}`);
            console.log(`            Ordered ${po.daysSinceOrder}d ago · ETA ${po.expectedDate}${confTag}${overdueTag}${trackingTag}${vendorTag}`);
            console.log(`            ${po.riskReason}`);
            console.log(`            → ${po.action}`);
            console.log();
        }
    }

    // ── Action Checklist ──────────────────────────────────────────────────────

    const critical = byRisk.get("critical") || [];
    const atRisk = byRisk.get("at_risk") || [];
    const trackingGaps = filtered.filter(a => !a.hasTracking && a.daysSinceOrder > 14);

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  ACTION CHECKLIST");
    console.log("═══════════════════════════════════════════════════════════════");

    if (critical.length > 0) {
        console.log(`  🔴 Email vendors for ${critical.length} critical POs:`);
        const byVendor = new Map<string, string[]>();
        for (const po of critical) {
            const list = byVendor.get(po.vendorName) || [];
            list.push(po.orderId);
            byVendor.set(po.vendorName, list);
        }
        for (const [vendor, orders] of byVendor) {
            console.log(`     ${vendor}: ${orders.join(", ")}`);
        }
    }

    if (trackingGaps.length > 0) {
        console.log(`\n  ❌ ${trackingGaps.length} POs ordered 14+d ago with ZERO tracking:`);
        for (const po of trackingGaps) {
            console.log(`     ${po.orderId} ${po.vendorName} — ordered ${po.daysSinceOrder}d ago, ${fmtDollar(po.total)}`);
        }
    }

    if (atRisk.length > 0) {
        console.log(`\n  🟡 ${atRisk.length} POs need attention this week:`);
        const checkThisWeek = atRisk.filter(a => !a.hasTrackingDelivery);
        console.log(`     ${checkThisWeek.length} need tracking verification or ETA follow-up`);
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log(`  Total: ${filtered.length} active POs · ${fmtDollar(filtered.reduce((s, p) => s + p.total, 0))}`);
    console.log("═══════════════════════════════════════════════════════════════\n");

    process.exit(0);
})().catch((err) => {
    console.error("❌", err);
    process.exit(1);
});
