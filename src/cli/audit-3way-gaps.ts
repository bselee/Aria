/**
 * @file    audit-3way-gaps.ts
 * @purpose Audit script: find POs that need receipt marking, invoice matching,
 *          or reconciliation to reach 3-way complete. Outputs a clear action list.
 * @author  Hermia
 * @created 2026-07-29
 * @deps    @/lib/finale/client, @/lib/purchasing/active-purchases,
 *          @/lib/purchasing/po-receipt-state, @/lib/purchasing/po-completion-state,
 *          @/lib/db
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 *
 * Usage:
 *   cd <project-root>
 *   node --import tsx src/cli/audit-3way-gaps.ts
 *   node --import tsx src/cli/audit-3way-gaps.ts --vendor "Uline"
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { FinaleClient } from "@/lib/finale/client";
import { loadActivePurchases } from "@/lib/purchasing/active-purchases";

// ── Types ──────────────────────────────────────────────────────────────────

interface GapReport {
    /** POs where Finale doesn't show received, but tracking shows delivered */
    trackingDeliveredNotReceived: GapEntry[];
    /** POs where Finale shows received, but no invoice matched */
    receivedNoInvoice: GapEntry[];
    /** POs where received + invoice matched, but reconciliation not complete */
    pendingReconciliation: GapEntry[];
    /** POs fully 3-way complete (will disappear from dashboard) */
    complete: GapEntry[];
    /** POs with no tracking and no receipt — truly in transit */
    genuinelyInTransit: GapEntry[];
    /** All other active POs */
    other: GapEntry[];
    summary: {
        total: number;
        needReceipt: number;
        needInvoice: number;
        needReconciliation: number;
        complete: number;
        inTransit: number;
    };
}

interface GapEntry {
    orderId: string;
    vendorName: string;
    orderDate: string;
    total: number;
    daysSinceOrder: number;
    expectedDate: string;
    isReceived: boolean;
    receiveDate: string | null;
    hasTrackingDelivery: boolean;
    hasInvoice: boolean;
    invoiceStatus: string | null;
    reconciliationVerdict: string | null;
    completionState: string;
    overdue: boolean;
    daysOverdue: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

function daysDiff(a: string, b: string): number {
    return Math.floor(
        (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
    );
}

function fmt(n: number): string {
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDollar(n: number): string {
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
    console.log("🔍 Aria 3-Way Match Gap Audit");
    console.log("═══════════════════════════════\n");

    // Parse args
    const args = process.argv.slice(2);
    const vendorFilter = args.includes("--vendor")
        ? args[args.indexOf("--vendor") + 1]?.toLowerCase()
        : null;

    // Init clients
    const finale = new FinaleClient();

    // Fetch active purchases (already enriched with completion state)
    console.log("📡 Fetching active purchases from Finale + DB...\n");
    const activePos = await loadActivePurchases(finale, 60);

    if (activePos.length === 0) {
        console.log("✅ No active POs found.");
        process.exit(0);
    }

    // Build gap report
    const report: GapReport = {
        trackingDeliveredNotReceived: [],
        receivedNoInvoice: [],
        pendingReconciliation: [],
        complete: [],
        genuinelyInTransit: [],
        other: [],
        summary: { total: 0, needReceipt: 0, needInvoice: 0, needReconciliation: 0, complete: 0, inTransit: 0 },
    };

    for (const po of activePos) {
        const vendorName = (po.vendorName || "").toLowerCase();
        if (vendorFilter && !vendorName.includes(vendorFilter)) continue;

        const hasTrackingDelivery =
            po.shipments.length > 0 &&
            po.shipments.every((s) => s.status_category === "delivered");

        const entry: GapEntry = {
            orderId: po.orderId,
            vendorName: po.vendorName,
            orderDate: po.orderDate || "",
            total: po.total,
            daysSinceOrder: po.orderDate ? daysDiff(TODAY, po.orderDate) : 0,
            expectedDate: po.etaProfile?.expectedDate || po.expectedDate || "",
            isReceived: po.isReceived,
            receiveDate: po.receiveDate,
            hasTrackingDelivery,
            hasInvoice: !!po.invoiceStatus,
            invoiceStatus: po.invoiceStatus || null,
            reconciliationVerdict: null,
            completionState: po.completionState,
            overdue: !po.isReceived && po.etaProfile?.expectedDate
                ? new Date(po.etaProfile.expectedDate).getTime() < Date.now()
                : false,
            daysOverdue: po.etaProfile?.expectedDate
                ? Math.max(0, daysDiff(TODAY, po.etaProfile.expectedDate))
                : 0,
        };

        report.summary.total++;

        // Classify
        if (po.completionState === "complete" && po.isReceived) {
            report.complete.push(entry);
            report.summary.complete++;
        } else if (!po.isReceived && hasTrackingDelivery) {
            report.trackingDeliveredNotReceived.push(entry);
            report.summary.needReceipt++;
        } else if (po.isReceived && !po.invoiceStatus) {
            report.receivedNoInvoice.push(entry);
            report.summary.needInvoice++;
        } else if (po.isReceived && po.completionState === "received_pending_reconciliation") {
            report.pendingReconciliation.push(entry);
            report.summary.needReconciliation++;
        } else if (!po.isReceived && !hasTrackingDelivery && po.shipments.length === 0) {
            report.genuinelyInTransit.push(entry);
            report.summary.inTransit++;
        } else {
            report.other.push(entry);
        }
    }

    // ── Output ──────────────────────────────────────────────────────────────

    const s = report.summary;

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  SUMMARY");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Total active POs:         ${s.total}`);
    console.log(`  ✅ 3-Way Complete:         ${s.complete}  (will auto-disappear)`);
    console.log(`  ⬜ Need Receipt (Finale):  ${s.needReceipt}  (tracking shows delivered)`);
    console.log(`  ⬜ Need Invoice Match:     ${s.needInvoice}`);
    console.log(`  ⬜ Need Reconciliation:    ${s.needReconciliation}`);
    console.log(`  🚚 Genuinely In Transit:   ${s.inTransit}`);
    console.log("");

    // ── SECTION 1: Need Receipt in Finale (highest priority) ──
    if (report.trackingDeliveredNotReceived.length > 0) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("  ⬜ NEED RECEIPT IN FINALE (tracking shows delivered)");
        console.log("  Action: Open Finale → mark these shipments as received");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        const sorted = report.trackingDeliveredNotReceived.sort(
            (a, b) => b.daysOverdue - a.daysOverdue
        );
        let runningTotal = 0;
        for (const e of sorted) {
            runningTotal += e.total;
            console.log(
                `  PO #${e.orderId.padEnd(8)} ${e.vendorName.padEnd(30)} ` +
                `${fmtDollar(e.total).padStart(10)}  overdue ${e.daysOverdue}d  ` +
                `ordered ${e.daysSinceOrder}d ago`
            );
        }
        console.log(`  ── ${sorted.length} POs · ${fmtDollar(runningTotal)} total ──\n`);
    }

    // ── SECTION 2: Need Invoice Match ──
    if (report.receivedNoInvoice.length > 0) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("  ⬜ NEED INVOICE MATCH (received, no invoice linked)");
        console.log("  Action: Run AP pipeline or manually match invoices");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        const sorted = report.receivedNoInvoice.sort(
            (a, b) => b.daysSinceOrder - a.daysSinceOrder
        );
        let runningTotal = 0;
        for (const e of sorted) {
            runningTotal += e.total;
            const rcvd = e.receiveDate ? `rcvd ${e.receiveDate}` : "rcvd (no date)";
            console.log(
                `  PO #${e.orderId.padEnd(8)} ${e.vendorName.padEnd(30)} ` +
                `${fmtDollar(e.total).padStart(10)}  ${rcvd}  ` +
                `ordered ${e.daysSinceOrder}d ago`
            );
        }
        console.log(`  ── ${sorted.length} POs · ${fmtDollar(runningTotal)} total ──\n`);
    }

    // ── SECTION 3: Need Reconciliation ──
    if (report.pendingReconciliation.length > 0) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("  ⬜ NEED RECONCILIATION (invoice matched, pricing unverified)");
        console.log("  Action: Review in Invoice Review dashboard panel");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        const sorted = report.pendingReconciliation.sort(
            (a, b) => b.daysSinceOrder - a.daysSinceOrder
        );
        let runningTotal = 0;
        for (const e of sorted) {
            runningTotal += e.total;
            console.log(
                `  PO #${e.orderId.padEnd(8)} ${e.vendorName.padEnd(30)} ` +
                `${fmtDollar(e.total).padStart(10)}  invoice: ${e.invoiceStatus || "unknown"}  ` +
                `ordered ${e.daysSinceOrder}d ago`
            );
        }
        console.log(`  ── ${sorted.length} POs · ${fmtDollar(runningTotal)} total ──\n`);
    }

    // ── SECTION 4: Complete ──
    if (report.complete.length > 0) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("  ✅ 3-WAY COMPLETE (will disappear from dashboard in 3d)");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        let runningTotal = 0;
        for (const e of report.complete) {
            runningTotal += e.total;
            console.log(
                `  PO #${e.orderId.padEnd(8)} ${e.vendorName.padEnd(30)} ` +
                `${fmtDollar(e.total).padStart(10)}  rcvd ${e.receiveDate || "?"}`
            );
        }
        console.log(`  ── ${report.complete.length} POs · ${fmtDollar(runningTotal)} total ──\n`);
    }

    // ── SECTION 5: Genuinely In Transit ──
    if (report.genuinelyInTransit.length > 0) {
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("  🚚 GENUINELY IN TRANSIT (no delivery, no receipt)");
        console.log("  No action needed — these are truly on the way");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        let runningTotal = 0;
        const sorted = report.genuinelyInTransit.sort(
            (a, b) => b.daysSinceOrder - a.daysSinceOrder
        );
        for (const e of sorted) {
            runningTotal += e.total;
            const overdueTag = e.overdue ? ` ⚠ overdue ${e.daysOverdue}d` : "";
            console.log(
                `  PO #${e.orderId.padEnd(8)} ${e.vendorName.padEnd(30)} ` +
                `${fmtDollar(e.total).padStart(10)}  ETA ${e.expectedDate || "?"}${overdueTag}`
            );
        }
        console.log(`  ── ${report.genuinelyInTransit.length} POs · ${fmtDollar(runningTotal)} total ──\n`);
    }

    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  CLEANUP PATH");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  1. Mark receipts in Finale for the 'Need Receipt' POs above");
    console.log("     → This makes OVERDUE badges disappear immediately");
    console.log("     → Self-healing updates lifecycle_stage to 'received'");
    console.log("");
    console.log("  2. For 'Need Invoice Match' POs, run the AP pipeline:");
    console.log("     node --import tsx src/cli/run-ap-pipeline.ts");
    console.log("     → Or manually match invoices via the Invoice Review panel");
    console.log("");
    console.log("  3. For 'Need Reconciliation' POs, review in dashboard:");
    console.log("     Invoice Review → approve reconciliation → pushes to Finale");
    console.log("");
    console.log("  4. Hit ?bust=1 on the dashboard to verify cleanup");
    console.log("═══════════════════════════════════════════════════════════════\n");

    process.exit(0);
})().catch((err) => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});
