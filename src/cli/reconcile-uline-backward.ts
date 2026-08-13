/**
 * @file    reconcile-uline-backward.ts
 * @purpose Backward Uline freight reconciliation: start from Finale Uline POs
 *          (PurchaseListScreenReport export) that shipped with only the $1.50
 *          house charge, and match them backwards to Billtrust FedEx Freight
 *          COLLECT bills by receive-date window. Report-first; --live applies
 *          matched freight with BOL# + amount.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/reconcile-uline-backward.ts
 *     --pos ".hermes/desktop-attachments/PurchaseListScreenReport (3).csv"
 *     --csv1 ".hermes/desktop-attachments/FEDEX_4174571_20260806105432_0.csv"
 *     --csv2 ".hermes/desktop-attachments/FEDEX_4174571_20260806105409_0.csv"
 *     --report-only | --live
 *
 * @author  Hermia
 * @created 2026-08-06
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { FinaleClient } from "../lib/finale/client";

const FREIGHT_PROMO = "/buildasoilorganics/api/productpromo/10007";
const HOUSE_CHARGE_THRESHOLD = 2.5;
const RECEIVE_WINDOW_DAYS = 10; // ship date → receive date max gap

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const idx = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
};
const POS_CSV = idx("--pos");
const CSV1 = idx("--csv1");
const CSV2 = idx("--csv2");

function findCsv(pattern: RegExp, dirs: string[]): string | null {
    const candidates: string[] = [];
    for (const dir of dirs) {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (pattern.test(f)) candidates.push(path.join(dir, f));
            }
        } catch {}
    }
    candidates.sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
    return candidates[0] || null;
}

const DEFAULT_DIRS = [
    path.join(process.env.USERPROFILE || "~", "Downloads"),
    path.join(process.env.USERPROFILE || "~", "Documents", "Projects", "aria", ".hermes", "desktop-attachments"),
];

// ── CSV helpers ──────────────────────────────────────────────────────────────
function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = false;
            } else current += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ",") { result.push(current.trim()); current = ""; }
            else current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

function readCsv(file: string): Record<string, string>[] {
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return [];
    const header = parseCsvLine(lines[0]);
    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        if (cols.length < header.length) continue;
        const row: Record<string, string> = {};
        for (let j = 0; j < header.length; j++) row[header[j]] = cols[j] || "";
        rows.push(row);
    }
    return rows;
}

interface UlineFreightBill {
    invoiceNumber: string;
    bol: string;
    amount: number;
    shipDate: string;
}

interface UlinePoStatus {
    poId: string;
    status: string;
    receiveDate: string;
    freightNow: number;
    total: string;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n╔════════════════════════════════════════════════════╗");
    console.log("║  Uline Freight — BACKWARD Reconciliation          ║");
    console.log("╚════════════════════════════════════════════════════╝\n");

    // 1. Load Finale Uline PO list (PurchaseListScreenReport)
    const posPath = POS_CSV || findCsv(/^PurchaseListScreenReport.*\.csv$/i, DEFAULT_DIRS);
    if (!posPath || !fs.existsSync(posPath)) {
        console.error("Need --pos <PurchaseListScreenReport.csv>");
        process.exit(1);
    }
    const posRows = readCsv(posPath);
    console.log(`PO report: ${posPath} (${posRows.length} rows)`);

    const ulinePOs: UlinePoStatus[] = posRows
        .filter((r) => (r["Supplier"] || "").toUpperCase().includes("ULINE"))
        .map((r) => ({
            poId: (r["Order ID"] || "").trim(),
            status: (r["Status"] || "").trim(),
            receiveDate: extractDate((r["Shipments"] || "") + " " + (r["Estimated receive date"] || "")),
            freightNow: parseFloat((r["Taxable discount/fee Freight"] || "0").replace(/[$,]/g, "")) || 0,
            total: r["Total"] || "",
        }));

    console.log(`Uline POs: ${ulinePOs.length}`);
    const live = ulinePOs.filter((p) => p.status !== "Canceled");
    console.log(`Live (not canceled): ${live.length}\n`);

    // POs missing real freight
    const missingFreight = live.filter((p) => p.freightNow <= HOUSE_CHARGE_THRESHOLD);
    console.log("Uline POs shipped WITHOUT real freight:");
    for (const p of missingFreight) {
        console.log(`  PO ${p.poId} | ${p.status} | rec ${p.receiveDate || "?"} | freight=$${p.freightNow} | total=$${p.total}`);
    }

    // 2. Load Billtrust freight bills (both CSVs), Uline only
    const csv1 = CSV1 || findCsv(/^FEDEX_\d+.*\.csv$/i, DEFAULT_DIRS);
    let bills: UlineFreightBill[] = [];
    for (const csvPath of [CSV1, CSV2].filter(Boolean)) {
        const rows = readCsv(csvPath!);
        const seen = new Set<string>();
        for (const r of rows) {
            if ((r["TERMS"] || "").toUpperCase() !== "COLLECT") continue;
            if (!(r["SHIP_FROM_ADDRESS"] || "").toUpperCase().includes("ULINE")) continue;
            const inv = (r["INVOICE_NUMBER"] || "").trim();
            if (!inv || seen.has(inv)) continue;
            seen.add(inv);
            bills.push({
                invoiceNumber: inv,
                bol: r["BILL_LADING"] || "",
                amount: parseFloat((r["AMT_DUE"] || "0").replace(/,/g, "")) || 0,
                shipDate: r["SHIP_DATE"] || "",
            });
        }
    }
    bills.sort((a, b) => (a.shipDate || "").localeCompare(b.shipDate || ""));
    console.log(`\nBilltrust Uline COLLECT bills: ${bills.length}`);
    for (const b of bills) {
        console.log(`  $${b.amount.toFixed(2)} | BOL ${b.bol} | ship ${b.shipDate}`);
    }

    // 3. Backward match: bill.shipDate <= PO.receiveDate <= shipDate + WINDOW
    console.log("\n=== BACKWARD MATCH ===");
    const matches: Array<{ bill: UlineFreightBill; po: UlinePoStatus; delta: number }> = [];
    const usedPOs = new Set<string>();
    const usedBills = new Set<string>();

    for (const po of missingFreight) {
        if (!po.receiveDate) continue;
        let best: { bill: UlineFreightBill; delta: number } | null = null;
        for (const bill of bills) {
            if (usedBills.has(bill.invoiceNumber)) continue;
            const delta = daysBetween(bill.shipDate, po.receiveDate);
            if (Number.isNaN(delta) || delta < 0 || delta > RECEIVE_WINDOW_DAYS) continue;
            if (!best || delta < best.delta) best = { bill, delta };
        }
        if (best) {
            matches.push({ bill: best.bill, po, delta: best.delta });
            usedBills.add(best.bill.invoiceNumber);
            usedPOs.add(po.poId);
        }
    }

    for (const m of matches) {
        console.log(
            `🟢 PO ${m.po.poId} ← $${m.bill.amount.toFixed(2)} | BOL ${m.bill.bol} | ship ${m.bill.shipDate} → rec ${m.po.receiveDate} (Δ${m.delta}d)`,
        );
    }

    const unmatchedBills = bills.filter((b) => !usedBills.has(b.invoiceNumber));
    console.log("\nUnmatched bills:");
    for (const b of unmatchedBills) {
        console.log(`  ❓ $${b.amount.toFixed(2)} | BOL ${b.bol} | ship ${b.shipDate}`);
    }

    const unmatchedPOs = missingFreight.filter((p) => !usedPOs.has(p.poId));
    console.log("\nPOs still missing freight:");
    for (const p of unmatchedPOs) {
        console.log(`  ❓ PO ${p.poId} | rec ${p.receiveDate || "?"} | total=$${p.total}`);
    }

    // 4. Apply
    if (LIVE && matches.length > 0) {
        console.log(`\nPHASE 2: Applying ${matches.length} freight line(s)...\n`);
        const fc = new FinaleClient();
        for (const m of matches) {
            try {
                const po = await fc.getOrderDetails(m.po.poId);
                const origStatus = (po as any).statusId;
                await fc.unlockForEditing(po, m.po.poId);
                const adj: any[] = [...(po.orderAdjustmentList || [])];
                const keep = adj.filter(
                    (a: any) =>
                        !(a.productPromoUrl || "").includes("/10007") ||
                        Number(a.amount) <= HOUSE_CHARGE_THRESHOLD,
                );
                keep.push({
                    amount: m.bill.amount,
                    description: `BOL ${m.bill.bol}`,
                    productPromoUrl: FREIGHT_PROMO,
                });
                await fc.post(
                    `/buildasoilorganics/api/order/${encodeURIComponent(m.po.poId)}`,
                    { ...po, orderAdjustmentList: keep },
                );
                await fc.restoreOrderStatus(m.po.poId, origStatus);
                console.log(`   ✅ PO ${m.po.poId}: BOL ${m.bill.bol} +$${m.bill.amount.toFixed(2)}`);
            } catch (err: any) {
                console.log(`   ❌ PO ${m.po.poId}: ${err?.message?.slice(0, 100)}`);
            }
        }
    }
    console.log();
}

function extractDate(text: string): string {
    const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return "";
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function daysBetween(shipDate: string, receiveDateIso: string): number {
    // shipDate: "MM/DD/YYYY" from Billtrust. receiveDateIso: "YYYY-MM-DD".
    try {
        const [m, d, y] = shipDate.split("/");
        const ship = new Date(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`).getTime();
        const rec = new Date(receiveDateIso).getTime();
        if (Number.isNaN(ship) || Number.isNaN(rec)) return Number.NaN;
        return Math.round((rec - ship) / 86400000);
    } catch {
        return Number.NaN;
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
