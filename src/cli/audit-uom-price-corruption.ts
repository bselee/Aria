/**
 * @file    audit-uom-price-corruption.ts
 * @purpose READ-ONLY audit. Finds Finale PO lines whose unit price sits at a clean
 *          integer multiple of the SKU's supplier cost — the signature of the
 *          case/each write bug (raw per-case invoice price written onto a per-EA line).
 * @author  Hermia
 * @created 2026-07-29
 *
 * SAFETY: performs only GET (Finale) and SELECT (PostgREST). Never writes.
 *
 * Usage:
 *   node --import tsx src/cli/audit-uom-price-corruption.ts
 *   node --import tsx src/cli/audit-uom-price-corruption.ts --days 180
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { FinaleClient } from "@/lib/finale/client";
import { createClient } from "@/lib/db";

const PACK_FACTORS = [2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 25, 36, 48, 50];
const TOLERANCE = 0.02;

function fmtUSD(n: number): string {
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Nearest clean pack factor for a ratio, or null when it is not pack-shaped. */
function cleanFactor(ratio: number): number | null {
    for (const f of PACK_FACTORS) {
        if (Math.abs(ratio - f) / f < TOLERANCE) return f;
    }
    return null;
}

(async () => {
    const args = process.argv.slice(2);
    const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) || 120 : 120;

    console.log("UOM Price-Corruption Audit  (READ-ONLY — no writes)");
    console.log("=".repeat(72));

    const db = createClient();
    if (!db) {
        console.error("PostgREST unavailable — cannot read ap_activity_log.");
        process.exit(1);
    }

    // 1. Which POs actually had a reconciliation applied? Only those were exposed.
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data: rows, error } = await db
        .from("ap_activity_log")
        .select("intent, created_at, metadata")
        .in("intent", ["RECONCILIATION", "RECONCILIATION_AUTO_APPLIED"])
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1000);

    if (error) {
        console.error("Query failed:", (error as any).message ?? error);
        process.exit(1);
    }

    // Keep only lines that were APPLIED (auto_approve / no_change) — skipped
    // lines never reached Finale and cannot have corrupted anything.
    type Susp = { orderId: string; productId: string; invoicePrice: number; effectivePrice: number | null; vendor: string; at: string };
    const applied = new Map<string, Susp>();

    for (const r of (rows ?? []) as any[]) {
        const m = r.metadata || {};
        const orderId = m.orderId ?? m.poId;
        if (!orderId) continue;
        const verdict = (m.verdict ?? m.overallVerdict ?? "").toLowerCase();
        if (!["auto_approve", "no_change"].includes(verdict)) continue;

        for (const pc of (m.priceChanges ?? []) as any[]) {
            const pcVerdict = (pc.verdict ?? "").toLowerCase();
            if (!["auto_approve", "no_change"].includes(pcVerdict)) continue;
            const productId = pc.productId;
            if (!productId) continue;
            const invoicePrice = pc.to ?? pc.invoicePrice ?? 0;
            if (!invoicePrice) continue;
            const key = `${orderId}::${productId}`;
            if (applied.has(key)) continue;
            applied.set(key, {
                orderId: String(orderId),
                productId: String(productId),
                invoicePrice,
                effectivePrice: Number.isFinite(pc.effectivePrice) ? pc.effectivePrice : null,
                vendor: m.vendorName ?? m.vendor ?? "Unknown",
                at: r.created_at,
            });
        }
    }

    console.log(`Applied price-changes in last ${days}d: ${applied.size}`);
    if (applied.size === 0) {
        console.log("\nNothing was auto-applied in this window — no exposure to the bug.");
        process.exit(0);
    }

    // 2. For each affected PO, read the CURRENT Finale line price and the SKU
    //    supplier cost, and look for a clean-integer relationship.
    const finale = new FinaleClient();
    const byOrder = new Map<string, Susp[]>();
    for (const s of applied.values()) {
        if (!byOrder.has(s.orderId)) byOrder.set(s.orderId, []);
        byOrder.get(s.orderId)!.push(s);
    }

    console.log(`Distinct POs to inspect: ${byOrder.size}\n`);

    const findings: Array<Susp & { linePrice: number; supplierPrice: number; factor: number; qty: number; overstated: number }> = [];
    const supplierCache = new Map<string, { price: number } | null>();
    let inspected = 0;

    for (const [orderId, lines] of byOrder) {
        let po: any = null;
        try {
            po = await finale.getOrderSummary(orderId);   // GET only
        } catch {
            continue;
        }
        if (!po) continue;
        inspected++;

        for (const s of lines) {
            const poLine = (po.items ?? []).find((i: any) => i.productId === s.productId);
            if (!poLine) continue;

            let sup = supplierCache.get(s.productId);
            if (sup === undefined) {
                try {
                    sup = await finale.getProductSupplierInfo(s.productId);  // GET only
                } catch {
                    sup = null;
                }
                supplierCache.set(s.productId, sup as any);
            }
            if (!sup || !sup.price || sup.price <= 0) continue;

            const linePrice = poLine.unitPrice ?? 0;
            if (linePrice <= 0) continue;

            const ratio = linePrice > sup.price ? linePrice / sup.price : sup.price / linePrice;
            if (ratio <= 1.5) continue;

            const factor = cleanFactor(ratio);
            if (!factor) continue;

            const qty = poLine.quantity ?? 0;
            const correct = linePrice > sup.price ? linePrice / factor : linePrice * factor;
            findings.push({
                ...s,
                linePrice,
                supplierPrice: sup.price,
                factor,
                qty,
                overstated: (linePrice - correct) * qty,
            });
        }
    }

    // 3. Report
    console.log("=".repeat(72));
    console.log(`Inspected ${inspected} POs. Suspicious lines: ${findings.length}`);
    console.log("=".repeat(72));

    if (findings.length === 0) {
        console.log("\nNo pack-shaped price anomalies found on applied lines.");
        console.log("No evidence of case/each corruption in this window.\n");
        process.exit(0);
    }

    findings.sort((a, b) => Math.abs(b.overstated) - Math.abs(a.overstated));
    let net = 0;
    for (const f of findings) {
        net += f.overstated;
        console.log(`\nPO ${f.orderId}  ${f.vendor}`);
        console.log(`  SKU ${f.productId}`);
        console.log(`  PO line price  : ${fmtUSD(f.linePrice)}   qty ${f.qty}`);
        console.log(`  Supplier cost  : ${fmtUSD(f.supplierPrice)}`);
        console.log(`  Ratio          : ${f.factor}x  <-- clean pack factor`);
        console.log(`  Invoice showed : ${fmtUSD(f.invoicePrice)}` +
            (f.effectivePrice !== null ? `   (normalized ${fmtUSD(f.effectivePrice)})` : "   (no normalized price recorded — pre-fix row)"));
        console.log(`  Line impact    : ${fmtUSD(f.overstated)}`);
    }

    console.log("\n" + "=".repeat(72));
    console.log(`Net line-value impact across ${findings.length} lines: ${fmtUSD(net)}`);
    console.log("NOTE: pack-shaped ratios can be legitimate (vendor genuinely sells");
    console.log("by the case). Treat these as REVIEW CANDIDATES, not confirmed errors.");
    console.log("=".repeat(72) + "\n");

    process.exit(0);
})().catch((e) => {
    console.error("Audit failed:", e);
    process.exit(1);
});
