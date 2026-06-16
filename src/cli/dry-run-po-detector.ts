/**
 * @file    dry-run-po-detector.ts
 * @purpose Dry-run / read-only scan for older unresponsive POs (L2/L3).
 *          Runs po-stuck-detector (reads Supabase) and po-overdue-followup's
 *          Finale query (reads Finale API). Does NOT draft emails or write
 *          anything. Reports POs >10 days old with no ack / no tracking.
 *
 * Usage:
 *   node --import tsx src/cli/dry-run-po-detector.ts [--min-days 7]
 *
 * Env (via .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { detectStuckPOs, summariseStuck, type StuckPO } from "@/lib/purchasing/po-stuck-detector";

// ── Config ────────────────────────────────────────────────────────────────

const MIN_DAYS = parseInt(process.argv.find(a => a.startsWith("--min-days="))?.split("=")[1] ?? "10", 10);

// ── Main ──────────────────────────────────────────────────────────────────

async function runDetectStuck(): Promise<StuckPO[]> {
    console.log(`\n─── po-stuck-detector (read-only Supabase scan) ───`);
    const rows = await detectStuckPOs();
    const summary = summariseStuck(rows);
    console.log(`Total stuck: ${summary.total}  |  by stage:`, summary.byStage);
    return rows;
}

async function runOverdueFinaleScan(): Promise<any[]> {
    console.log(`\n─── po-overdue-followup Finale scan (read-only) ───`);

    const apiKey = process.env.FINALE_API_KEY || "";
    const apiSecret = process.env.FINALE_API_SECRET || "";
    const accountPath = process.env.FINALE_ACCOUNT_PATH || "";
    const baseUrl = process.env.FINALE_BASE_URL || "https://app.finaleinventory.com";

    if (!apiKey || !apiSecret) {
        console.warn("  ⚠  FINALE_API_KEY / FINALE_API_SECRET not set — skipping Finale scan");
        return [];
    }

    const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    const url = `${baseUrl}/${accountPath}/api/query.json`;
    const body = JSON.stringify({
        sql: `SELECT orderId, vendor, expectedReceiveDate, orderDate, statusId FROM PurchaseOrder WHERE statusId = 'ORDER_LOCKED' ORDER BY expectedReceiveDate ASC LIMIT 50`,
    });

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" },
            body,
        });
        if (!res.ok) {
            console.warn(`  ⚠  Finale query failed: ${res.status} ${res.statusText}`);
            return [];
        }

        const data = await res.json() as any;
        const rows = (data.results || []).filter((r: any) => r.expectedReceiveDate);
        const now = Date.now();

        // Filter to overdue POs only
        const overdue = rows
            .map((r: any) => {
                const expDate = new Date(r.expectedReceiveDate).getTime();
                const daysOverdue = Math.floor((now - expDate) / 86_400_000);
                return { ...r, daysOverdue };
            })
            .filter((r: any) => r.daysOverdue >= 3) // MIN_OVERDUE_DAYS
            .sort((a: any, b: any) => b.daysOverdue - a.daysOverdue);

        console.log(`  Found ${overdue.length} overdue PO(s) in Finale (past expected receive date)`);
        return overdue;
    } catch (err: any) {
        console.warn(`  ⚠  Finale scan error: ${err.message}`);
        return [];
    }
}

function formatTable(rows: StuckPO[], minDays: number): void {
    // Filter to relevant: acked_no_tracking (unresponsive POs) + any >minDays
    const relevant = rows.filter(r => r.daysStuck >= minDays || r.stage === "acked_no_tracking");
    if (relevant.length === 0) {
        console.log(`\n  ✅ No POs ≥${minDays} days old with issues found.`);
        return;
    }

    // Group by stage
    const byStage: Record<string, StuckPO[]> = {};
    for (const r of relevant) {
        if (!byStage[r.stage]) byStage[r.stage] = [];
        byStage[r.stage].push(r);
    }

    for (const [stage, items] of Object.entries(byStage)) {
        console.log(`\n  ── ${stage} (${items.length}) ──`);

        // Sort by most stuck first
        items.sort((a, b) => b.daysStuck - a.daysStuck);

        // Header
        console.log(`  ${"PO #".padEnd(18)} ${"Vendor".padEnd(22)} ${"Days".padEnd(6)} ${"Summary"}`);
        console.log(`  ${"─".repeat(17)}  ${"─".repeat(21)}  ${"─".repeat(5)}  ${"─".repeat(40)}`);

        for (const po of items) {
            const poNum = po.poNumber.substring(0, 16);
            const vendor = (po.vendorName || "?").substring(0, 20);
            const flag = po.daysStuck >= minDays ? " ⚠" : "  ";
            console.log(`  ${poNum.padEnd(18)} ${vendor.padEnd(22)} ${String(po.daysStuck).padEnd(4)}d${flag}  ${po.summary}`);
        }
    }
}

function formatFinaleTable(rows: any[], minDays: number): void {
    const relevant = rows.filter((r: any) => r.daysOverdue >= minDays);
    if (relevant.length === 0) {
        console.log(`  ✅ No Finale POs ≥${minDays} days overdue`);
        return;
    }

    console.log(`\n  ── overdue POs (past expected receive date, 0 received) ──`);
    console.log(`  ${"Order ID".padEnd(18)} ${"Vendor".padEnd(22)} ${"Overdue".padEnd(8)} ${"Expected".padEnd(14)}`);
    console.log(`  ${"─".repeat(17)}  ${"─".repeat(21)}  ${"─".repeat(7)}  ${"─".repeat(13)}`);

    for (const r of relevant) {
        const oid = (r.orderId || "?").substring(0, 16);
        const v = (r.vendor || "?").substring(0, 20);
        const exp = (r.expectedReceiveDate || "").substring(0, 10);
        console.log(`  ${oid.padEnd(18)} ${v.padEnd(22)} ${String(r.daysOverdue).padEnd(5)}d${" ".repeat(1)} ${exp}`);
    }
}

async function main(): Promise<void> {
    console.log(`🔍 PO Dry-Run Detector — min days: ${MIN_DAYS}`);
    console.log(`   Mode: READ-ONLY — no drafts, no writes.`);

    // 1. Stuck POs from Supabase (po-stuck-detector)
    const stuckRows = await runDetectStuck();
    formatTable(stuckRows, MIN_DAYS);

    // 2. Overdue POs from Finale (po-overdue-followup Finale scan)
    const overduePOs = await runOverdueFinaleScan();
    formatFinaleTable(overduePOs, MIN_DAYS);

    // ── Combined summary ─────────────────────────────────────────────
    const unresponsive = stuckRows.filter(
        r => r.stage === "acked_no_tracking" && r.daysStuck >= MIN_DAYS
    );
    const trackingStale = stuckRows.filter(
        r => r.stage === "tracking_stale" && r.daysStuck >= MIN_DAYS
    );

    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`📋 SUMMARY (≥${MIN_DAYS}d)`);
    console.log(`   Unresponsive (acked, no tracking): ${unresponsive.length}`);
    console.log(`   Tracking stale:                    ${trackingStale.length}`);
    console.log(`   Finale overdue (L2/L3):            ${overduePOs.filter((r: any) => r.daysOverdue >= MIN_DAYS).length}`);
    console.log(`   Total flagged:                     ${unresponsive.length + trackingStale.length + overduePOs.filter((r: any) => r.daysOverdue >= MIN_DAYS).length}`);
    console.log(`────────────────────────────────────────────────────────`);
    console.log(`   Dry-run complete. No emails drafted, no data written.`);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});