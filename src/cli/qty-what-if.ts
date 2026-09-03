/**
 * @file    src/cli/qty-what-if.ts
 * @purpose Read-only comparison of the deployed recommender (v2.8, still live)
 *          against the new v2.9 code (freight-aware sizing + 30/45d cover floor)
 *          on today's actionable ordering lines. Prints a before/after table so
 *          Bill can approve quantity changes before anything is deployed or
 *          drafted. Never writes, never touches a PO, exit 0.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    finale/client, purchasing/assessment-service, qty-recommender
 * @env     FINALE_API_URL, FINALE_AUTH_TOKEN (via .env.local)
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { FinaleClient } from "../lib/finale/client";
import { assessPurchasingGroups } from "../lib/purchasing/assessment-service";

interface BeforeRow {
    recSuggested: number;
    unitPrice: number | null;
    vendorName: string;
    decision: string;
}

interface LiveItem {
    productId?: string;
    sku?: string;
    suggestedQty?: number;
    unitPrice?: number | null;
    vendorName?: string;
    recommendation?: { suggestedQty?: number };
    assessment?: { decision?: string };
}
interface LiveGroup { vendorName?: string; items?: LiveItem[]; }
interface CalRow {
    vendor_name?: string | null;
    median_error_pct?: number | string | null;
    sample_count?: number | string | null;
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    return (await res.json()) as T;
}

async function main() {
    // ── BEFORE: live dashboard (v2.8 build still deployed) ─────────────────
    const live = await fetchJson<{ groups?: LiveGroup[] }>("http://127.0.0.1:3001/api/dashboard/purchasing?mode=all");
    const before = new Map<string, BeforeRow>();
    for (const g of live.groups ?? []) {
        for (const it of g.items ?? []) {
            const pid = it.productId ?? it.sku;
            if (!pid) continue;
            before.set(pid, {
                recSuggested: it.suggestedQty ?? it.recommendation?.suggestedQty ?? 0,
                unitPrice: it.unitPrice ?? null,
                vendorName: g.vendorName ?? it.vendorName ?? "",
                decision: it.assessment?.decision ?? "",
            });
        }
    }

    // ── AFTER: local pipeline running the NEW (v2.9) code ───────────────────
    const client = new FinaleClient();
    const groups = await client.getPurchasingIntelligence();
    const assessment = assessPurchasingGroups(groups);

    interface Row {
        sku: string;
        vendor: string;
        before: number;
        after: number;
        delta: number;
        unitPrice: number | null;
        detail: string;
    }
    const rows: Row[] = [];

    for (const g of assessment.groups) {
        for (const line of g.items) {
            const decision = line.assessment?.decision;
            if (decision !== "order") continue;
            const pid = line.item.productId;
            // Same display logic as the route: recommendedQty wins, else item.suggestedQty.
            const after = line.assessment?.recommendedQty > 0
                ? line.assessment.recommendedQty
                : (line.item.suggestedQty ?? 0);
            if (!(after > 0)) continue;
            const b = before.get(pid);
            if (!b) continue; // only compare SKUs the live screen also shows
            let detail = "";
            const prov = line.item.recommendation?.provenance ?? [];
            for (const p of prov) {
                if (p.step === "freight_sizing" || p.step === "cover_floor") {
                    detail = String(p.detail ?? "").slice(0, 120);
                    break;
                }
            }
            rows.push({
                sku: pid,
                vendor: g.vendorName,
                before: b.recSuggested,
                after,
                delta: after - b.recSuggested,
                unitPrice: b.unitPrice,
                detail,
            });
        }
    }

    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    // ── Render ──────────────────────────────────────────────────────────────
    console.log(`\nWHAT-IF: v2.8 (deployed) vs v2.9 (freight-aware + cover floor)\n`);
    console.log(
        `${"SKU".padEnd(18)} ${"vendor".padEnd(22)} ${"v2.8".padStart(8)} ${"v2.9".padStart(8)} ` +
        `${"Δ".padStart(7)} ${"Δ%".padStart(6)} ${"$ line".padStart(10)}  why`,
    );
    console.log("-".repeat(150));
    for (const r of rows) {
        const pct = r.before > 0 ? Math.round((r.delta / r.before) * 100) : (r.delta > 0 ? Infinity : 0);
        const pctS = r.before > 0 ? `${pct >= 0 ? "+" : ""}${pct}%` : "new";
        const dollars = r.unitPrice != null && r.unitPrice > 0 ? `$${(r.after * r.unitPrice).toFixed(0)}` : "?";
        const marker = r.delta === 0 ? " " : r.delta > 0 ? "▲" : "▼";
        console.log(
            `${r.sku.slice(0, 17).padEnd(18)} ${r.vendor.slice(0, 21).padEnd(22)} ` +
            `${String(r.before).padStart(8)} ${String(r.after).padStart(8)} ` +
            `${`${r.delta >= 0 ? "+" : ""}${r.delta}`.padStart(7)} ${pctS.padStart(6)} ${dollars.padStart(10)}  ${marker} ${r.detail}`,
        );
    }

    const changed = rows.filter((r) => r.delta !== 0);
    const newlyActionable = changed.filter((r) => r.before === 0);
    const floorChanged = changed.filter((r) => r.before > 0);
    const up = floorChanged.filter((r) => r.delta > 0);
    const down = floorChanged.filter((r) => r.delta < 0);
    const estFloorDelta = floorChanged.reduce((s, r) => {
        const up = r.unitPrice != null && r.unitPrice > 0 ? r.unitPrice : 0;
        return s + (r.after - r.before) * up;
    }, 0);
    console.log("-".repeat(150));
    console.log(
        `SUMMARY: ${rows.length} actionable lines | ${up.length} raised, ${down.length} lowered, ` +
        `${rows.length - changed.length} unchanged | ${newlyActionable.length} newly actionable (not floor-caused)`,
    );
    console.log(
        `FLOOR EFFECT on existing lines: $ delta ${estFloorDelta >= 0 ? "+" : ""}$${estFloorDelta.toFixed(0)}`,
    );

    // ── R4: calibration poisoning check ─────────────────────────────────────
    console.log("\nR4 CHECK: vendor_calibration_stats");
    try {
        const cal = await fetchJson<CalRow[]>("http://localhost:5434/vendor_calibration_stats?select=*");
        const suspect = (Array.isArray(cal) ? cal : []).filter(
            (c: CalRow) => Math.abs(Number(c.median_error_pct) || 0) > 50 || (Number(c.sample_count) || 0) > 200,
        );
        if (suspect.length === 0) console.log("  clean — no extreme bias or sample spikes");
        else for (const s of suspect) console.log(`  SUSPECT ${s.vendor_name}: err ${s.median_error_pct}% n=${s.sample_count}`);
    } catch (e) {
        console.log(`  unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
    console.log("");
}

main().then(() => process.exit(0)).catch((e) => {
    console.error("WHAT-IF FAILED:", e?.message ?? e);
    process.exit(1);
});
