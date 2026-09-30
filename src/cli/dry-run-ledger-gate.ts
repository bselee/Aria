/**
 * @file    src/cli/dry-run-ledger-gate.ts
 * @purpose Dry-run the stock-ledger admission + velocity change across the full
 *          catalog WITHOUT touching the dashboard's served snapshot. Prints a
 *          before/after summary and the SKUs the ledger newly surfaces, so the
 *          blast radius is known before anything ships.
 *
 *          Matches the rule: dry-run a heuristic across the full catalog before
 *          shipping it.
 *
 *          Read-only against Finale. Writes only data/dry-run-ledger-gate.json.
 *
 * @author  Hermia
 * @created 2026-09-30
 * @deps    src/lib/finale/purchasing, src/lib/finale/stock-ledger, dotenv
 * @env     .env.local (FINALE_*), LEDGER_DAYS (default 90)
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { FinaleClient } from "@/lib/finale/client";
import { getLedgerSnapshot, ledgerRateFor } from "@/lib/finale/stock-ledger";

interface Lite { productId: string; supplierName: string; urgency: string; decision: string; dailyRate: number; rateSource: string; stockOnHand: number; leadTime: number; suggestedQty: number }

/** Minimal shapes for the disk snapshot this CLI compares against. */
interface SnapshotItem {
    productId: string;
    supplierName?: string;
    urgency?: string;
    dailyRate?: number | string | null;
    dailyRateSource?: string | null;
    stockOnHand?: number | string | null;
    effectiveLeadTimeDays?: number | null;
    leadTimeDays?: number | null;
    suggestedQty?: number | string | null;
    assessment?: { decision?: string } | null;
}
interface SnapshotGroup { items?: SnapshotItem[] | null }

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function main() {
    const days = process.env.LEDGER_DAYS ? Number(process.env.LEDGER_DAYS) : 90;

    console.log("[dry-run] loading stock ledger…");
    const ledger = await getLedgerSnapshot(days, {
        onProgress: p => { if (p.page % 20 === 0) console.log(`  page ${p.page}, ${p.skus} SKUs`); },
    });
    const burning = Object.values(ledger.bySku).filter(s => s.net > 0);
    console.log(`[dry-run] ledger: ${burning.length} SKUs with net consumption over ${days}d`);

    // "Before" = what the dashboard is currently serving.
    const before: Lite[] = [];
    // The route persists resale and BOM snapshots separately.
    const cacheDir = process.env.ARIA_PURCHASING_CACHE_DIR || join(process.cwd(), ".aria-cache", "purchasing");
    for (const file of ["purchasing-resale.json", "purchasing-bom.json"]) {
        const snap = join(cacheDir, file);
        if (!existsSync(snap)) { console.warn(`[dry-run] no baseline snapshot at ${snap}`); continue; }
        try {
            const d = JSON.parse(readFileSync(snap, "utf-8")) as { groups?: SnapshotGroup[] | null };
            for (const g of d.groups || []) {
                for (const i of g.items || []) {
                    before.push({
                        productId: i.productId, supplierName: i.supplierName || "", urgency: i.urgency || "",
                        decision: i.assessment?.decision || "", dailyRate: num(i.dailyRate),
                        rateSource: i.dailyRateSource || "", stockOnHand: num(i.stockOnHand),
                        leadTime: num(i.effectiveLeadTimeDays ?? i.leadTimeDays), suggestedQty: num(i.suggestedQty),
                    });
                }
            }
            console.log(`[dry-run] baseline ${file}: ${before.length} cumulative lines`);
        } catch (err) {
            console.warn(`[dry-run] could not read ${snap}: ${(err as Error).message}`);
        }
    }

    console.log("[dry-run] running full purchasing scan with the ledger gate…");
    const client = new FinaleClient();
    const groups = await client.getPurchasingIntelligence(365);

    const after: Lite[] = [];
    for (const g of groups) {
        for (const i of g.items || []) {
            after.push({
                productId: i.productId, supplierName: g.vendorName ?? i.supplierName,
                urgency: i.urgency,
                // getPurchasingIntelligence() returns the raw engine items; the
                // order/hold decision is added later by the route's assessment
                // layer, so there is nothing to read here yet.
                decision: "",
                dailyRate: num(i.dailyRate), rateSource: i.dailyRateSource || "",
                stockOnHand: num(i.stockOnHand),
                leadTime: num(i.effectiveLeadTimeDays ?? i.leadTimeDays),
                suggestedQty: num(i.suggestedQty),
            });
        }
    }

    const beforeIds = new Set(before.map(b => b.productId));
    const afterIds = new Set(after.map(a => a.productId));
    const added = after.filter(a => !beforeIds.has(a.productId));
    const removed = before.filter(b => !afterIds.has(b.productId));
    const ledgerSourced = after.filter(a => a.rateSource === "ledger");

    console.log("\n================ DRY RUN RESULT ================");
    console.log(`before (dashboard snapshot) : ${before.length} lines`);
    console.log(`after  (ledger gate)        : ${after.length} lines`);
    console.log(`newly surfaced              : ${added.length}`);
    console.log(`dropped                     : ${removed.length}`);
    console.log(`rate sourced from ledger    : ${ledgerSourced.length}`);
    console.log(`order decisions: before=${before.filter(b => b.decision === "order").length} after=${after.filter(a => a.decision === "order").length}`);

    console.log("\ntop 40 newly surfaced by daily rate:");
    console.log("SKU".padEnd(18), "VENDOR".padEnd(26), "RATE/D".padStart(9), "SOH".padStart(9), "LEAD".padStart(5), " URGENCY");
    for (const a of added.sort((x, y) => y.dailyRate - x.dailyRate).slice(0, 40)) {
        console.log(
            a.productId.padEnd(18), String(a.supplierName || "").slice(0, 26).padEnd(26),
            a.dailyRate.toFixed(3).padStart(9), String(Math.round(a.stockOnHand)).padStart(9),
            String(a.leadTime).padStart(5), ` ${a.urgency}`,
        );
    }

    if (removed.length) {
        console.log("\nDROPPED (investigate before shipping):");
        for (const r of removed.slice(0, 30)) {
            const ir = ledgerRateFor(ledger, r.productId);
            console.log(`  ${r.productId.padEnd(18)} was=${r.urgency}/${r.decision} rate=${r.dailyRate} ledger=${ir.toFixed(3)}`);
        }
    }

    mkdirSync("data", { recursive: true });
    writeFileSync("data/dry-run-ledger-gate.json", JSON.stringify({
        generatedAt: new Date().toISOString(),
        days,
        beforeCount: before.length, afterCount: after.length,
        added, removed, ledgerSourced,
    }, null, 2));
    console.log("\nwrote data/dry-run-ledger-gate.json");
}

main().catch(e => { console.error(e); process.exit(1); });
