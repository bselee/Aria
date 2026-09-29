/**
 * @file    reconcile-amazon.ts
 * @purpose Reconcile an Amazon Business order-history export against the Finale
 *          purchase orders those orders were placed under, the same way
 *          reconcile-uline.ts reconciles Uline invoices: line prices, freight,
 *          tax, and junk/zero-cost lines. Amazon's export already carries the
 *          PO number per order, so the join is exact — no OCR, no scraping.
 *
 *          Read-only unless --fix is given. --fix prints the correction plan;
 *          --fix --live applies it: every paired line takes the price actually
 *          paid (Amazon subtotal plus its discount, shipping excluded), and
 *          shipping that Amazon charged lands as a bare `Freight` 10007 line
 *          with ADJ_BY_WEIGHT and a full allocation list. Tax lines are left
 *          alone (the account is resale exempt, so Amazon charges none).
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-amazon.ts                      # newest orders_from_*.csv, dry run
 *   node --import tsx src/cli/reconcile-amazon.ts --csv <path.csv>     # explicit export
 *   node --import tsx src/cli/reconcile-amazon.ts --po 125338,125302   # subset of POs
 *   node --import tsx src/cli/reconcile-amazon.ts --report <out.csv>   # findings CSV path
 *   node --import tsx src/cli/reconcile-amazon.ts --lines              # print the line-level diff too
 *   node --import tsx src/cli/reconcile-amazon.ts --fix                # print the correction plan
 *   node --import tsx src/cli/reconcile-amazon.ts --fix --live         # apply it to Finale
 *
 * Checks:
 *   order variance   booked (goods + tax adj + freight adj) vs Amazon order net total
 *   line variance    Finale unit price vs the Amazon unit price that line was bought at
 *   shipping         Amazon charged shipping but the PO carries none, folded or as a 10007 line
 *   tax              Amazon charged tax although the account is resale exempt
 *   junk lines       order items with no product id / zero quantity
 *   zero-cost lines  order items with a quantity but a $0 unit price
 *   no-PO spend      Amazon orders with a blank PO field (card spend outside Finale)
 *
 * @author  Hermia
 * @created 2026-09-29
 * @deps    finale/client, finale/freight-adjustment
 * @env     FINALE_API_KEY, FINALE_API_SECRET
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FinaleClient } from "../lib/finale/client";

// ── Config ───────────────────────────────────────────────────────────────────

/** Finale product promo URLs that carry tax and freight. */
const TAX_PROMO = "/10008";
const FREIGHT_PROMO = "/10007";
/**
 * Reviewed ASIN -> Finale SKU conversions (2026-09-29, one line at a time against both
 * exports). Price-pairing can name a SKU but cannot be trusted to divide quantities: a
 * name-matched ASIN once turned 10 free mailer packs into 1,000 phantom units. Anything
 * not in this table falls back to what a price-verified pair can prove, and an ASIN whose
 * link is only guessed stays out of purchase totals — that is a decision for Bill, not
 * something to invent.
 */
const ASIN_SKU_UNITS: Record<string, { sku: string; unitsPerPack: number }> = {
    B01MAZEN5X: { sku: "DASH101", unitsPerPack: 4 }, // Dasher thermal labels, 4 rolls/pack
    B0BX248NJ2: { sku: "TN830", unitsPerPack: 2 }, // Brother TN830XL, 2 cartridges/pack
    B00NMH29PM: { sku: "S-11481", unitsPerPack: 100 }, // ABC gusseted poly mailers 11x13, 100/pack
    B07M6QP7Y9: { sku: "S-11481", unitsPerPack: 100 }, // PSBM expansion poly mailers 11x13 — Bill books these to S-11481 too (PO 125059, 125150)
    B0DHXN386Z: { sku: "LR44BATT", unitsPerPack: 60 }, // NICEBATT LR44, 60/pack
    B0FT21HKZ6: { sku: "MONI101", unitsPerPack: 1 }, // Sceptre 22" monitor
    // Amazon "1 Pair" is exactly the S-12527 "(2 Pk)" unit, so the ratio is 1:1
    B00AEFCP0E: { sku: "S-12527", unitsPerPack: 1 }, // 3M 6006 respirator cartridges
    B0CPMDDTGX: { sku: "DR830", unitsPerPack: 1 }, // Brother DR830 drum unit (SKU already existed)
    B09P2WVQ65: { sku: "S-16160", unitsPerPack: 10 }, // MUNBYN receipt paper, 10 rolls/pack -> S-16160 (Bill, 2026-09-29)
};

/** Party id Finale holds Amazon orders against (partygroup "Amazon"). */
const AMAZON_PARTY_ID = "10154";
/** Every Amazon PO in Finale destinates to the soil facility; a PO without one cannot be received. */
const DESTINATION_FACILITY = "10005";
/** A pair matches when the unit prices agree to within this much (pack rounding). */
const UNIT_TOLERANCE = 0.15;
/** An order is clean when booked and charged agree to within this much. */
const ORDER_TOLERANCE = 0.05;

const ATTACHMENT_DIRS = [
    path.join(os.homedir(), "AppData", "Local", "hermes", "attachments"),
    path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox"),
];

// ── Types ────────────────────────────────────────────────────────────────────

interface AmazonLine {
    orderId: string;
    orderDate: string;
    orderStatus: string;
    po: string;
    asin: string;
    title: string;
    seller: string;
    category: string;
    quantity: number;
    ppu: number;
    subtotal: number;
    shipping: number;
    promotion: number;
    tax: number;
    net: number;
}

interface AmazonOrder {
    orderId: string;
    orderDate: string;
    orderStatus: string;
    po: string;
    lines: AmazonLine[];
    subtotal: number;
    shipping: number;
    promotion: number;
    tax: number;
    net: number;
}

interface FinaleLine {
    productId: string;
    quantity: number;
    unitPrice: number;
    total: number;
}

interface FinaleFreightLine {
    amount: number;
    description: string;
    allocationEnum: string;
    allocation: number[] | null;
    skipsLandedCost: boolean;
}

interface FinalePo {
    po: string;
    statusId: string;
    orderDate: string;
    supplierPartyId: string | null;
    lines: FinaleLine[];
    freight: FinaleFreightLine[];
    tax: number;
    goods: number;
    booked: number;
}

type PairBasis = "ppu" | "net" | "sub" | "unit";

interface PairResult {
    finale: FinaleLine;
    amazon: AmazonLine;
    /** Amazon unit price scaled onto the Finale line's unit of measure. */
    expectedUnit: number;
    /** Total dollars the Finale line differs from the Amazon charge. */
    variance: number;
    qtyRatio: number;
    note: string;
    /** True when one quantity is a whole multiple of the other (a pack conversion). */
    dividesEvenly: boolean;
    basis: PairBasis;
    /** True when the PO buys more/fewer units than Amazon shipped at that price. */
    qtyMismatch: boolean;
    /** True when the pairing came from the relaxed pass and needs a human eye. */
    candidate: boolean;
}

interface PoFinding {
    po: string;
    statusId: string;
    orderDate: string;
    orders: AmazonOrder[];
    finale: FinalePo | null;
    amazonNet: number;
    amazonShipping: number;
    amazonPromotion: number;
    amazonTax: number;
    delta: number;
    pairs: PairResult[];
    /** Relaxed pairings: plausible but unconfirmed, never summed into variance. */
    candidates: PairResult[];
    /** SKU-name pairings used to price lines that carried no price at all. */
    titleMatches: PairResult[];
    unpairedFinale: FinaleLine[];
    unpairedAmazon: AmazonLine[];
    flags: string[];
    reasons: string[];
}

interface Report {
    csvPath: string;
    generatedAt: string;
    findings: PoFinding[];
    noPoOrders: AmazonOrder[];
    noPoTotal: number;
    cancelledLines: number;
    error?: string;
}

// ── CSV parsing (RFC 4180 — Amazon quotes fields and prefixes ="...") ─────────

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    const src = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\r") {
            // handled with \n
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }
    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** Amazon exports wrap identifiers as ="value" to stop Excel eating the zeros. */
function clean(value: string | undefined): string {
    let v = (value ?? "").trim();
    if (v.startsWith('="') && v.endsWith('"')) v = v.slice(2, -1);
    else if (v.startsWith("=")) v = v.slice(1);
    return v.trim();
}

function num(value: string | undefined): number {
    const v = clean(value);
    if (!v || v.toUpperCase() === "N/A") return 0;
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : 0;
}

// ── Amazon export ────────────────────────────────────────────────────────────

function readAmazonExport(csvPath: string): {
    orders: Map<string, AmazonOrder>;
    lines: AmazonLine[];
    cancelledLines: number;
} {
    const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
    const header = rows[0].map((h) => h.trim());
    const col = (name: string) => header.indexOf(name);
    const idx = {
        orderDate: col("Order Date"),
        orderId: col("Order ID"),
        po: col("PO Number"),
        qty: col("Item Quantity"),
        asin: col("ASIN"),
        title: col("Title"),
        seller: col("Seller Name"),
        category: col("Amazon-Internal Product Category"),
        orderStatus: col("Order Status"),
        ppu: col("Purchase PPU"),
        subtotal: col("Item Subtotal"),
        shipping: col("Item Shipping & Handling"),
        promotion: col("Item Promotion"),
        tax: col("Item Tax"),
        net: col("Item Net Total"),
    };
    for (const [key, value] of Object.entries(idx)) {
        if (value < 0) throw new Error(`Amazon export is missing the "${key}" column`);
    }

    const orders = new Map<string, AmazonOrder>();
    const lines: AmazonLine[] = [];
    let cancelledLines = 0;
    for (const r of rows.slice(1)) {
        if (!r.length || !clean(r[idx.orderId])) continue;
        const line: AmazonLine = {
            orderId: clean(r[idx.orderId]),
            orderDate: clean(r[idx.orderDate]),
            orderStatus: clean(r[idx.orderStatus]),
            po: clean(r[idx.po]),
            asin: clean(r[idx.asin]),
            title: clean(r[idx.title]),
            seller: clean(r[idx.seller]),
            category: clean(r[idx.category]),
            quantity: num(r[idx.qty]),
            ppu: num(r[idx.ppu]),
            subtotal: num(r[idx.subtotal]),
            shipping: num(r[idx.shipping]),
            promotion: num(r[idx.promotion]),
            tax: num(r[idx.tax]),
            net: num(r[idx.net]),
        };
        // A cancelled line is not spend — it must not move a PO's expected total.
        if (/cancell?ed/i.test(line.orderStatus)) {
            cancelledLines++;
            continue;
        }
        lines.push(line);
        const existing = orders.get(line.orderId);
        if (existing) {
            existing.lines.push(line);
            existing.subtotal += line.subtotal;
            existing.shipping += line.shipping;
            existing.promotion += line.promotion;
            existing.tax += line.tax;
            existing.net += line.net;
        } else {
            orders.set(line.orderId, {
                orderId: line.orderId,
                orderDate: line.orderDate,
                orderStatus: line.orderStatus,
                po: line.po,
                lines: [line],
                subtotal: line.subtotal,
                shipping: line.shipping,
                promotion: line.promotion,
                tax: line.tax,
                net: line.net,
            });
        }
    }
    return { orders, lines, cancelledLines };
}

// ── Finale read ──────────────────────────────────────────────────────────────

/** The slice of a raw Finale order document this reconciler reads. */
interface RawFinaleOrder {
    orderId?: unknown;
    statusId?: unknown;
    orderDate?: unknown;
    orderItemList?: Array<{ productId?: unknown; quantity?: unknown; unitPrice?: unknown }>;
    orderAdjustmentList?: Array<{
        amount?: unknown;
        description?: unknown;
        productPromoUrl?: unknown;
        adjustmentAllocationEnumId?: unknown;
        orderAdjustmentAllocationList?: unknown;
    }>;
    orderRoleList?: Array<{ roleTypeId?: unknown; partyId?: unknown }>;
}

function readFinalePo(raw: RawFinaleOrder): FinalePo {
    const lines: FinaleLine[] = (raw.orderItemList || []).map((it) => {
        const quantity = Number(it.quantity) || 0;
        const unitPrice = Number(it.unitPrice) || 0;
        return {
            productId: String(it.productId || "").trim(),
            quantity,
            unitPrice,
            total: Math.round(quantity * unitPrice * 100) / 100,
        };
    });
    const lineCount = lines.length;
    const adjustments = raw.orderAdjustmentList || [];
    const freight: FinaleFreightLine[] = [];
    let tax = 0;
    for (const a of adjustments) {
        const promo = String(a.productPromoUrl || "");
        const amount = Number(a.amount) || 0;
        const allocation: number[] | null = Array.isArray(a.orderAdjustmentAllocationList)
            ? a.orderAdjustmentAllocationList.map((n) => Number(n) || 0)
            : null;
        if (promo.endsWith(TAX_PROMO)) {
            tax += amount;
            continue;
        }
        if (promo.endsWith(FREIGHT_PROMO) || /^freight\b/i.test(String(a.description || ""))) {
            const description = String(a.description ?? "").trim();
            freight.push({
                amount,
                description,
                allocationEnum: String(a.adjustmentAllocationEnumId || ""),
                allocation,
                skipsLandedCost:
                    description !== "Freight" ||
                    a.adjustmentAllocationEnumId !== "ADJ_BY_WEIGHT" ||
                    !allocation ||
                    allocation.length !== lineCount,
            });
        }
    }
    const supplierRole = (raw.orderRoleList || []).find((r) => r.roleTypeId === "SUPPLIER");
    const goods = lines.reduce((sum, l) => sum + l.total, 0);
    return {
        po: String(raw.orderId),
        statusId: String(raw.statusId || ""),
        orderDate: String(raw.orderDate || "").slice(0, 10),
        supplierPartyId: supplierRole ? String(supplierRole.partyId) : null,
        lines,
        freight,
        tax: Math.round(tax * 100) / 100,
        goods: Math.round(goods * 100) / 100,
        booked:
            Math.round(
                (goods + tax + freight.reduce((sum, f) => sum + f.amount, 0)) * 100,
            ) / 100,
    };
}

// ── Line matching ────────────────────────────────────────────────────────────

/**
 * Match a Finale line to an Amazon line by unit price.
 *
 * Amazon sells packs, Finale stocks eaches (80 rolls vs 20 packs of 4), so the
 * Amazon unit price is scaled onto the Finale unit of measure before comparing.
 * Four bases are tried, because Amazon POs are written by hand several ways:
 *   ppu      raw Amazon PPU scaled by the pack ratio (freight sits on a 10007 line)
 *   net      net ÷ line qty — shipping and discount folded into the unit price
 *   sub      subtotal ÷ line qty — shipping billed separately by the carrier
 *   unit     the raw Amazon PPU compared 1:1, which means the PO quantity is
 *            wrong rather than the price (Amazon shipped fewer units than the PO)
 * The closest basis wins; anything further than UNIT_TOLERANCE from every basis
 * is not a pair at all, so a messy PO cannot invent a match.
 */
function scorePair(
    finale: FinaleLine,
    amazon: AmazonLine,
    freightOnPo: boolean,
    relaxed: boolean,
): PairResult | null {
    if (finale.quantity <= 0 || amazon.quantity <= 0) return null;
    const ratio = amazon.quantity / finale.quantity;
    const perFinaleUnit = (total: number) => total / finale.quantity;

    const candidates: Array<{ expected: number; note: string; basis: PairBasis }> = [];
    const lineHasShipOrPromo = Math.abs(amazon.shipping) > 0.005 || Math.abs(amazon.promotion) > 0.005;
    if (freightOnPo) {
        candidates.push({
            expected: perFinaleUnit(amazon.ppu * amazon.quantity),
            note: "amazon PPU, freight on a PO line",
            basis: "ppu",
        });
    }
    if (lineHasShipOrPromo) {
        candidates.push({
            expected: perFinaleUnit(amazon.net),
            note: "amazon net, shipping and discount folded",
            basis: "net",
        });
    }
    candidates.push({
        expected: perFinaleUnit(amazon.subtotal),
        note: lineHasShipOrPromo ? "amazon subtotal" : "amazon unit price, no shipping or discount",
        basis: "sub",
    });
    candidates.push({ expected: amazon.ppu, note: "amazon PPU, quantity differs", basis: "unit" });

    let best: { expected: number; note: string; basis: PairBasis } | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        const gap = Math.abs(c.expected - finale.unitPrice);
        if (gap < bestGap) {
            bestGap = gap;
            best = c;
        }
    }
    if (!best) return null;
    const limit = relaxed ? Math.max(0.5, 0.35 * Math.abs(best.expected)) : UNIT_TOLERANCE;
    if (bestGap > limit) return null;

    const dividesEvenly =
        Math.abs(finale.quantity - amazon.quantity) < 1e-9 ||
        Math.abs(finale.quantity / amazon.quantity - Math.round(finale.quantity / amazon.quantity)) < 1e-6 ||
        Math.abs(amazon.quantity / finale.quantity - Math.round(amazon.quantity / finale.quantity)) < 1e-6;
    const qtyMismatch = !dividesEvenly && Math.abs(finale.quantity - amazon.quantity) > 1e-9;

    return {
        finale,
        amazon,
        expectedUnit: Math.round(best.expected * 100000) / 100000,
        variance: round2(finale.total - best.expected * finale.quantity),
        qtyRatio: ratio,
        note: best.note,
        dividesEvenly,
        basis: best.basis,
        qtyMismatch,
        candidate: relaxed,
    };
}

/**
 * Greedy best-first pairing so each Amazon line is used once.
 *
 * Pass 1 pairs lines whose unit prices agree inside UNIT_TOLERANCE — those are
 * facts. Pass 2 offers the leftovers to each other with a 35% window and marks
 * them `candidate`, because on a PO with unpriced or miscounted lines the
 * nearest Amazon line is usually the right one but only a human can say so.
 */
function pairLines(finaleLines: FinaleLine[], amazonLines: AmazonLine[], freightOnPo: boolean): {
    pairs: PairResult[];
    candidates: PairResult[];
    unpairedFinale: FinaleLine[];
    unpairedAmazon: AmazonLine[];
} {
    const run = (
        fList: FinaleLine[],
        aList: AmazonLine[],
        relaxed: boolean,
    ): { pairs: PairResult[]; usedF: Set<number>; usedA: Set<number> } => {
        const scored: Array<{ f: number; a: number; gap: number; result: PairResult }> = [];
        fList.forEach((f, fi) => {
            aList.forEach((a, ai) => {
                const result = scorePair(f, a, freightOnPo, relaxed);
                if (!result) return;
                scored.push({ f: fi, a: ai, gap: Math.abs(result.variance), result });
            });
        });
        scored.sort((x, y) => x.gap - y.gap);
        const usedF = new Set<number>();
        const usedA = new Set<number>();
        const pairs: PairResult[] = [];
        for (const c of scored) {
            if (usedF.has(c.f) || usedA.has(c.a)) continue;
            usedF.add(c.f);
            usedA.add(c.a);
            pairs.push(c.result);
        }
        return { pairs, usedF, usedA };
    };

    const strict = run(finaleLines, amazonLines, false);
    const leftF = finaleLines.filter((_, i) => !strict.usedF.has(i));
    const leftA = amazonLines.filter((_, i) => !strict.usedA.has(i));
    const loose = run(leftF, leftA, true);
    return {
        pairs: strict.pairs,
        candidates: loose.pairs,
        unpairedFinale: leftF.filter((_, i) => !loose.usedF.has(i)),
        unpairedAmazon: leftA.filter((_, i) => !loose.usedA.has(i)),
    };
}

// ── Findings ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function analyse(
    po: string,
    orders: AmazonOrder[],
    finale: FinalePo | null,
): PoFinding {
    const amazonNet = round2(orders.reduce((s, o) => s + o.net, 0));
    const amazonShipping = round2(orders.reduce((s, o) => s + o.shipping, 0));
    const amazonPromotion = round2(orders.reduce((s, o) => s + o.promotion, 0));
    const amazonTax = round2(orders.reduce((s, o) => s + o.tax, 0));
    const amazonLines = orders.flatMap((o) => o.lines);

    const finding: PoFinding = {
        po,
        statusId: finale?.statusId ?? "(PO not found)",
        orderDate: finale?.orderDate ?? orders[0]?.orderDate ?? "",
        orders,
        finale,
        amazonNet,
        amazonShipping,
        amazonPromotion,
        amazonTax,
        delta: finale ? round2(finale.booked - amazonNet) : 0,
        pairs: [],
        candidates: [],
        titleMatches: [],
        unpairedFinale: [],
        unpairedAmazon: amazonLines,
        flags: [],
        reasons: [],
    };
    if (!finale) {
        finding.flags.push("PO_NOT_FOUND");
        finding.reasons.push("Amazon order names a PO that does not resolve in Finale");
        return finding;
    }

    const freightOnPo = finale.freight.some((f) => !f.skipsLandedCost);
    const freightTotal = round2(finale.freight.reduce((s, f) => s + f.amount, 0));
    // Blank lines carry nothing to match; zero-cost lines are real purchases the
    // PO never priced, so they stay in the pairing to be reported as variance.
    const matchable = finale.lines.filter((l) => l.productId && l.quantity > 0);
    const { pairs, candidates, unpairedFinale, unpairedAmazon } = pairLines(
        matchable,
        amazonLines,
        freightOnPo,
    );
    finding.pairs = pairs;
    finding.candidates = candidates;
    finding.unpairedFinale = unpairedFinale;
    finding.unpairedAmazon = unpairedAmazon;
    // Lines still unmatched after the price passes may be zero-cost; price those
    // from the Amazon line whose title carries the SKU.
    finding.titleMatches = titleMatchPairs(
        unpairedFinale.filter((l) => l.unitPrice === 0),
        unpairedAmazon,
    );
    for (const tm of finding.titleMatches) {
        finding.reasons.push(
            `${tm.finale.productId} x${tm.finale.quantity} carries no price; ${tm.amazon.asin} names it at ` +
                `${(tm.amazon.subtotal + tm.amazon.promotion).toFixed(2)}`,
        );
    }
    const titleMatchedSkus = new Set(finding.titleMatches.map((p) => p.finale.productId));
    finding.unpairedFinale = finding.unpairedFinale.filter((l) => !titleMatchedSkus.has(l.productId));
    const titleMatchedAsins = new Set(finding.titleMatches.map((p) => p.amazon.asin));
    finding.unpairedAmazon = finding.unpairedAmazon.filter((l) => !titleMatchedAsins.has(l.asin));

    const pairVariance = round2(pairs.reduce((s, p) => s + p.variance, 0));
    finding.reasons.push(`line variances total ${pairVariance.toFixed(2)}`);
    const balances = Math.abs(finding.delta) <= ORDER_TOLERANCE;
    if (candidates.length && !balances) {
        finding.flags.push("UNIT_PRICE_MISMATCH");
        for (const c of candidates) {
            finding.reasons.push(
                `closest Amazon line for ${c.finale.productId} x${c.finale.quantity} is ${c.amazon.asin} ` +
                    `at ${c.amazon.ppu.toFixed(2)} — line differs by ${c.variance.toFixed(2)} (verify)`,
            );
        }
    }

    if (Math.abs(finding.delta) <= ORDER_TOLERANCE) {
        finding.flags.push("MATCHED");
    } else if (finding.delta < 0) {
        finding.flags.push("UNDERBOOKED");
    } else {
        finding.flags.push("OVERBOOKED");
    }

    // Shipping charged but absent from the PO, whether folded into the line
    // prices or carried as a 10007 line. A PO that matched on the net basis has
    // the shipping inside its unit prices.
    const shippingFolded = pairs.some((p) => p.basis === "net");
    if (amazonShipping > 0.05 && Math.abs(freightTotal) < 0.01) {
        if (shippingFolded) {
            finding.flags.push("SHIPPING_FOLDED");
        } else {
            finding.flags.push("SHIPPING_NOT_ON_PO");
            finding.reasons.push(
                `Amazon charged ${amazonShipping.toFixed(2)} shipping; the PO carries no freight line and no folded shipping`,
            );
        }
    }

    // Amazon discounts not reflected in the PO price.
    if (amazonPromotion < -0.05 && !balances) {
        finding.flags.push("PROMO_ON_ORDER");
        finding.reasons.push(`Amazon discounted ${Math.abs(amazonPromotion).toFixed(2)} on these orders`);
    }

    if (amazonTax > 0.05) {
        finding.flags.push("TAX_CHARGED");
        finding.reasons.push(`Amazon charged ${amazonTax.toFixed(2)} tax on a resale-exempt account`);
    }
    if (finale.tax !== 0) {
        finding.reasons.push(`PO carries a tax adjustment of ${finale.tax.toFixed(2)}`);
    }

    const zeroCost = finale.lines.filter((l) => l.quantity > 0 && l.unitPrice === 0);
    if (zeroCost.length) {
        finding.flags.push("ZERO_COST_LINE");
        finding.reasons.push(
            `${zeroCost.length} line(s) with a quantity but $0 unit price: ` +
                zeroCost.map((l) => `${l.productId} x${l.quantity}`).join(", "),
        );
    }
    const blank = finale.lines.filter((l) => !l.productId || l.quantity <= 0);
    if (blank.length) {
        finding.flags.push("JUNK_LINE");
        finding.reasons.push(
            `${blank.length} order item(s) with no product id or zero quantity: ` +
                blank.map((l) => `${l.productId || "(blank)"} x${l.quantity}`).join(", "),
        );
    }
    const skipping = finale.freight.filter((f) => f.skipsLandedCost);
    if (skipping.length) {
        finding.flags.push("FREIGHT_SKIPS_LANDED_COST");
        finding.reasons.push(
            `${skipping.length} freight line(s) will not roll into unit cost: ` +
                skipping.map((f) => `"${f.description}" ${f.amount.toFixed(2)}`).join(", "),
        );
    }
    if (orders.length > 1) {
        finding.flags.push("MULTI_ORDER_PO");
        finding.reasons.push(`${orders.length} Amazon orders share this PO`);
    }
    if (pairs.some((p) => !p.dividesEvenly && !p.qtyMismatch)) {
        finding.flags.push("QTY_UNIT_MISMATCH");
        finding.reasons.push(
            "quantity ratio between PO line and Amazon line is not a whole pack conversion — check the UOM",
        );
    }
    const qtyOff = pairs.filter((p) => p.qtyMismatch);
    if (qtyOff.length) {
        finding.flags.push("QTY_MISMATCH");
        for (const p of qtyOff) {
            finding.reasons.push(
                `PO buys ${p.finale.quantity} x ${p.finale.productId}, Amazon shipped ${p.amazon.quantity} ` +
                    `at ${p.amazon.ppu.toFixed(2)} — ${Math.abs(p.finale.quantity - p.amazon.quantity)} unit(s) ` +
                    `(${(Math.abs(p.finale.quantity - p.amazon.quantity) * p.amazon.ppu).toFixed(2)}) not backed by this order`,
            );
        }
    }
    if (unpairedFinale.length) {
        finding.flags.push("PO_LINE_NOT_ON_EXPORT");
        finding.reasons.push(
            `PO line(s) with no Amazon counterpart: ` +
                unpairedFinale.map((l) => `${l.productId} x${l.quantity}`).join(", "),
        );
        // A PO bought from Amazon across a month boundary carries orders older
        // than the export start, so its goods will always exceed this file.
        if (finding.delta > ORDER_TOLERANCE) {
            finding.reasons.push(
                `PO total exceeds these orders — the PO may carry Amazon orders dated before the export window`,
            );
        }
    }
    if (unpairedAmazon.length) {
        finding.flags.push("AMAZON_LINE_NOT_ON_PO");
        finding.reasons.push(
            `Amazon line(s) with no PO counterpart: ` +
                unpairedAmazon.map((l) => `${l.asin} x${l.quantity}`).join(", "),
        );
    }
    return finding;
}

// ── Report output ────────────────────────────────────────────────────────────

function money(n: number): string {
    return n.toFixed(2).padStart(9);
}

function printReport(report: Report, showLines: boolean): void {
    console.log(`\nAmazon export: ${report.csvPath}`);
    console.log(`Generated:     ${report.generatedAt}`);
    console.log(
        `\n${"PO".padEnd(7)} ${"status".padEnd(9)} ${"orders".padStart(6)} ${"amzNet".padStart(9)} ${"amzShip".padStart(8)} ` +
            `${"amzPromo".padStart(9)} ${"finGoods".padStart(9)} ${"finFrt".padStart(7)} ${"booked".padStart(9)} ${"delta".padStart(8)}  flags`,
    );
    for (const f of report.findings) {
        const frt = f.finale ? f.finale.freight.reduce((s, x) => s + x.amount, 0) : 0;
        console.log(
            `${f.po.padEnd(7)} ${f.statusId.slice(0, 9).padEnd(9)} ${String(f.orders.length).padStart(6)} ` +
                `${money(f.amazonNet)} ${money(f.amazonShipping).padStart(8)} ${money(f.amazonPromotion).padStart(9)} ` +
                `${money(f.finale?.goods ?? 0)} ${money(frt).padStart(7)} ${money(f.finale?.booked ?? 0)} ${money(f.delta).padStart(8)}  ` +
                f.flags.filter((x) => x !== "MATCHED").join(",") || `${f.po} MATCHED`,
        );
    }

    const clean = report.findings.filter((f) => f.flags.includes("MATCHED")).length;
    const variance = round2(
        report.findings.reduce((s, f) => s + (f.finale ? f.delta : 0), 0),
    );
    console.log(
        `\n${report.findings.length} POs — ${clean} matched within $${ORDER_TOLERANCE.toFixed(2)}, ` +
            `net variance ${variance >= 0 ? "+" : ""}${variance.toFixed(2)}`,
    );
    console.log(
        `Amazon card spend with no PO number: ${report.noPoOrders.length} orders, ` +
            `$${report.noPoTotal.toFixed(2)}` +
            (report.cancelledLines ? ` (${report.cancelledLines} cancelled line(s) excluded)` : ""),
    );

    if (showLines) {
        for (const f of report.findings) {
            console.log(`\n── ${f.po} (${f.statusId}) ──────────────────────────────────────────`);
            for (const r of f.reasons) console.log(`   · ${r}`);
            if (!f.finale) continue;
            for (const p of f.pairs) {
                const flag = Math.abs(p.variance) > ORDER_TOLERANCE ? " <== variance" : "";
                console.log(
                    `   ${(p.finale.productId || "(blank)").padEnd(14)} q${String(p.finale.quantity).padStart(5)} ` +
                        `po ${p.finale.unitPrice.toFixed(4).padStart(10)} | amazon ${p.amazon.asin} q${String(p.amazon.quantity).padStart(4)} ` +
                        `@ ${p.expectedUnit.toFixed(4).padStart(10)} (${p.note}) | var ${p.variance.toFixed(2).padStart(8)}${flag}`,
                );
            }
            for (const c of f.candidates) {
                console.log(
                    `   ${(c.finale.productId || "(blank)").padEnd(14)} q${String(c.finale.quantity).padStart(5)} ` +
                        `po ${c.finale.unitPrice.toFixed(4).padStart(10)} | ~candidate~ ${c.amazon.asin} q${String(c.amazon.quantity).padStart(4)} ` +
                        `@ ${c.amazon.ppu.toFixed(4).padStart(10)} | var ${c.variance.toFixed(2).padStart(8)}`,
                );
            }
            for (const l of f.unpairedFinale) {
                console.log(`   ${(l.productId || "(blank)").padEnd(14)} q${String(l.quantity).padStart(5)} po ${l.unitPrice.toFixed(4).padStart(10)} | no Amazon line`);
            }
            for (const l of f.unpairedAmazon) {
                console.log(`   ${"(no PO line)".padEnd(14)} q${String(l.quantity).padStart(5)} ${" ".repeat(14)} | ${l.asin} @ ${l.ppu.toFixed(2)} net ${l.net.toFixed(2)} ${l.title.slice(0, 42)}`);
            }
        }
    }
}

function writeFindingsCsv(report: Report, outPath: string): void {
    const header = [
        "po", "status", "amazon_orders", "amazon_net", "amazon_shipping", "amazon_promotion", "amazon_tax",
        "finale_goods", "finale_freight", "finale_tax", "finale_booked", "delta", "flags", "reasons",
    ];
    const rows = report.findings.map((f) =>
        [
            f.po,
            f.statusId,
            String(f.orders.length),
            f.amazonNet.toFixed(2),
            f.amazonShipping.toFixed(2),
            f.amazonPromotion.toFixed(2),
            f.amazonTax.toFixed(2),
            (f.finale?.goods ?? 0).toFixed(2),
            (f.finale?.freight.reduce((s, x) => s + x.amount, 0) ?? 0).toFixed(2),
            (f.finale?.tax ?? 0).toFixed(2),
            (f.finale?.booked ?? 0).toFixed(2),
            f.delta.toFixed(2),
            f.flags.join(" "),
            f.reasons.join(" | "),
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","),
    );
    const noPo = [
        "",
        "NO_PO_SPEND",
        String(report.noPoOrders.length),
        report.noPoTotal.toFixed(2),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "NO_PO_SPEND",
        "Amazon orders with a blank PO field — card spend outside Finale",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, [header.join(","), ...rows, noPo].join("\n"), "utf8");
}

// ── Entry point ──────────────────────────────────────────────────────────────

function newestExport(): string | null {
    let best: { file: string; mtime: number } | null = null;
    for (const dir of ATTACHMENT_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (!/^orders_from_.*\.csv$/i.test(name) && !/amazon.*orders.*\.csv$/i.test(name)) continue;
            const file = path.join(dir, name);
            const mtime = fs.statSync(file).mtimeMs;
            if (!best || mtime > best.mtime) best = { file, mtime };
        }
    }
    return best?.file ?? null;
}

function defaultReportPath(): string {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const sandbox = path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox");
    const dir = fs.existsSync(sandbox) ? sandbox : (process.env.TMPDIR || os.tmpdir());
    return path.join(dir, `amazon-reconciliation-${stamp}.csv`);
}

// ── Correction plan ──────────────────────────────────────────────────────────

/**
 * Name-based pairing, used only by the correction planner.
 *
 * A zero-cost line has no price to match on, so the only handle left is the SKU
 * itself: `TN830` appears inside "Brother Genuine TN830XL 2PK", `LR44BATT`
 * splits to `LR44` and appears inside "NICEBATT LR44 Batteries". Tokens must be
 * four characters or more and contain a digit, which keeps generic SKUs from
 * matching a title by accident.
 */
function titleMatchPairs(finaleLines: FinaleLine[], amazonLines: AmazonLine[]): PairResult[] {
    // Normalize the SKU, then pull "letters followed by digits" runs: TN830 out of
    // TN830, LR44 out of LR44BATT. Both keep a digit and reach four characters.
    const tokens = (sku: string): string[] => {
        const flat = sku.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
        const found = flat.match(/[A-Z]{1,6}\d{2,}[A-Z]{0,4}/g) || [];
        return found.filter((t) => t.length >= 4 && /\d/.test(t));
    };

    const scored: Array<{ f: number; a: number; token: string; result: PairResult }> = [];
    finaleLines.forEach((f, fi) => {
        const skuTokens = tokens(f.productId);
        if (!skuTokens.length) return;
        amazonLines.forEach((a, ai) => {
            const title = a.title.toUpperCase();
            const hit = skuTokens.find((t) => title.includes(t));
            if (!hit) return;
            const expected = (a.subtotal + a.promotion) / f.quantity;
            scored.push({
                f: fi,
                a: ai,
                token: hit,
                result: {
                    finale: f,
                    amazon: a,
                    expectedUnit: Math.round(expected * 1e6) / 1e6,
                    variance: round2(f.total - expected * f.quantity),
                    qtyRatio: a.quantity / f.quantity,
                    note: `matched by name (${hit})`,
                    dividesEvenly: true,
                    basis: "sub",
                    qtyMismatch: false,
                    candidate: false,
                },
            });
        });
    });

    scored.sort((x, y) => Math.abs(x.result.variance) - Math.abs(y.result.variance));
    const usedF = new Set<number>();
    const usedA = new Set<number>();
    const pairs: PairResult[] = [];
    for (const c of scored) {
        if (usedF.has(c.f) || usedA.has(c.a)) continue;
        usedF.add(c.f);
        usedA.add(c.a);
        pairs.push(c.result);
    }
    return pairs;
}

type ChangeType = "price" | "freight" | "quantity-needs-call";

interface PoChange {
    type: ChangeType;
    sku?: string;
    oldValue?: number;
    newValue?: number;
    note: string;
}

interface PoPlan {
    po: string;
    statusId: string;
    changes: PoChange[];
    /** Σ(price × qty) after the plan, plus the target freight. */
    projectedTotal: number;
    amazonNet: number;
    residual: number;
}

/**
 * Build the correction plan for one PO.
 *
 * Price: every paired line takes the price actually paid, `(subtotal + discount)`
 * per Finale unit, so the discount is inside the price rather than an adjustment.
 * Freight: Amazon's shipping for the orders this PO actually covers, written as a
 * bare `Freight` line. Tax: never touched, Amazon charges none on this account.
 * A line whose quantity exceeds what Amazon sold is never repriced — the unit
 * price only looks wrong because the quantity is wrong — so it becomes a single
 * "quantity needs a call" line and the PO is left alone.
 */
function buildPlan(finding: PoFinding): PoPlan | null {
    const { finale } = finding;
    if (!finale) return null;

    const changes: PoChange[] = [];
    const targets = new Map<string, number>();
    const qtyCalls = new Set<string>();

    // A quantity mismatch is a quantity question, not a price question.
    for (const p of finding.pairs) {
        if (!p.qtyMismatch) continue;
        qtyCalls.add(p.finale.productId);
        changes.push({
            type: "quantity-needs-call",
            sku: p.finale.productId,
            oldValue: p.finale.quantity,
            newValue: p.amazon.quantity,
            note:
                `Amazon sold ${p.amazon.quantity} at ${p.amazon.ppu.toFixed(2)}, the PO carries ${p.finale.quantity}; ` +
                `lowering a received PO is your call`,
        });
    }

    // Candidate pairs count when the rest of the PO is spoken for: on these POs
    // the nearest Amazon line is the only candidate left, and it is the right one
    // (MSI101 against a 99.99 Amazon line, copy paper against 51.99).
    const planPairs = [...finding.pairs, ...finding.titleMatches];
    for (const c of finding.candidates) {
        if (qtyCalls.has(c.finale.productId)) continue;
        const tolerance = Math.max(5, 0.25 * Math.abs(c.finale.total));
        if (Math.abs(c.variance) > tolerance) continue;
        planPairs.push(c);
    }

    for (const p of planPairs) {
        if (qtyCalls.has(p.finale.productId)) continue;
        const perUnit = (p.amazon.subtotal + p.amazon.promotion) / p.finale.quantity;
        targets.set(p.finale.productId, Math.round(perUnit * 1e6) / 1e6);
    }

    for (const line of finale.lines) {
        const target = targets.get(line.productId);
        if (target === undefined || line.quantity <= 0) continue;
        if (Math.abs(target - line.unitPrice) < 0.0000005) continue;
        changes.push({
            type: "price",
            sku: line.productId,
            oldValue: line.unitPrice,
            newValue: target,
            note: `old total ${(line.unitPrice * line.quantity).toFixed(2)} -> ${(target * line.quantity).toFixed(2)}`,
        });
    }

    // Freight, only for the orders this PO actually covers. A PO whose lines
    // reach outside the export window would otherwise take a partial amount.
    const coveredOrderIds = new Set(planPairs.map((p) => p.amazon.orderId));
    const coveredShipping = round2(
        finding.orders.filter((o) => coveredOrderIds.has(o.orderId)).reduce((s, o) => s + o.shipping, 0),
    );
    const existingFreight = round2(finale.freight.reduce((s, f) => s + f.amount, 0));
    if (coveredShipping > 0.005 && Math.abs(coveredShipping - existingFreight) > 0.005) {
        changes.push({
            type: "freight",
            oldValue: existingFreight,
            newValue: coveredShipping,
            note:
                existingFreight > 0
                    ? `replace ${existingFreight.toFixed(2)} with the shipping actually charged`
                    : "Amazon charged shipping; the PO carries none",
        });
    }

    const pricedGoods = round2(
        finale.lines.reduce((sum, l) => {
            const target = targets.get(l.productId);
            return sum + (target !== undefined ? target * l.quantity : l.total);
        }, 0),
    );
    const freightAfter = changes.some((c) => c.type === "freight") ? coveredShipping : existingFreight;
    const projectedTotal = round2(pricedGoods + freightAfter + finale.tax);

    if (!changes.length && Math.abs(finding.delta) <= ORDER_TOLERANCE) return null;
    return {
        po: finding.po,
        statusId: finale.statusId,
        changes,
        projectedTotal,
        amazonNet: finding.amazonNet,
        residual: round2(projectedTotal - finding.amazonNet),
    };
}

function printPlans(plans: PoPlan[], live: boolean): void {
    console.log(`\n${live ? "APPLYING" : "CORRECTION PLAN (dry run)"} — ${plans.length} PO(s)\n`);
    for (const plan of plans) {
        console.log(`${plan.po} (${plan.statusId})  amazon ${plan.amazonNet.toFixed(2)}`);
        for (const c of plan.changes) {
            if (c.type === "price") {
                console.log(
                    `   price    ${c.sku.padEnd(14)} ${c.oldValue?.toFixed(6).padStart(12)} -> ${c.newValue?.toFixed(6).padStart(12)}   ${c.note}`,
                );
            } else if (c.type === "freight") {
                console.log(
                    `   freight  ${"Freight".padEnd(14)} ${c.oldValue?.toFixed(2).padStart(12)} -> ${c.newValue?.toFixed(2).padStart(12)}   ${c.note}`,
                );
            } else {
                console.log(
                    `   QTY?     ${String(c.sku).padEnd(14)} ${c.oldValue?.toFixed(0).padStart(12)} -> ${c.newValue?.toFixed(0).padStart(12)}   ${c.note}`,
                );
            }
        }
        console.log(
            `   projected ${plan.projectedTotal.toFixed(2)} vs amazon ${plan.amazonNet.toFixed(2)}  residue ${plan.residual >= 0 ? "+" : ""}${plan.residual.toFixed(2)}\n`,
        );
    }
}

/** A Finale order document as the writer mutates it. */
type WritableOrderItem = { productId?: unknown; quantity?: unknown; unitPrice?: number };
type WritablePo = RawFinaleOrder & {
    orderItemList?: WritableOrderItem[];
    statusId?: string;
    /** Present on every PO read back from Finale; used to derive the API prefix. */
    orderUrl?: string;
    /** Every Amazon PO destinates to the soil facility (10005). */
    destinationFacilityUrl?: string;
};


/** Writes through the Finale client's own GET -> unlock -> POST -> restore pattern. */
class FinaleWriter extends FinaleClient {
    /** Fetch a PO document. */
    async fetchPo(po: string): Promise<WritablePo> {
        return this.getOrderDetails(po) as Promise<WritablePo>;
    }
    /**
     * Create an empty PURCHASE_ORDER and return its id.
     * Finale assigns the 6-digit number; the caller then POSTs the document with
     * the supplier, date, lines and status, the same GET -> POST path every other
     * writer in this repo uses.
     */
    async createEmptyPo(): Promise<string> {
        const created = await this.post(`/${this.accountPath}/api/order`, {
            orderTypeId: "PURCHASE_ORDER",
        });
        const id = String(created?.orderId || "");
        if (!id) throw new Error("Finale did not return an orderId for the new PO");
        return id;
    }
    /**
     * Units already booked by capture POs from earlier runs. Only the export's POs are
     * visible to the reconciler; a capture PO carries no Amazon PO number, so it has to be
     * read back by id or the next run books the same stock again.
     */
    async capturePoUnits(pos: string[]): Promise<Map<string, number>> {
        const units = new Map<string, number>();
        for (const po of pos) {
            try {
                const doc = await this.fetchPo(po);
                if (String(doc.statusId ?? "").toUpperCase().includes("CANCEL")) continue;
                for (const l of doc.orderItemList ?? []) {
                    const sku = l.productId ? String(l.productId).trim() : "";
                    if (!sku) continue;
                    units.set(sku, (units.get(sku) ?? 0) + Number(l.quantity ?? 0));
                }
            } catch {
                // a deleted or unreadable PO simply contributes nothing
            }
            await new Promise((r) => setTimeout(r, 700));
        }
        return units;
    }

    /** Unlock a committed/completed PO; returns the status to restore. */
    async unlock(doc: WritablePo, po: string): Promise<string> {
        return this.unlockForEditing(doc, po);
    }
    /** POST a modified order document back. */
    async postOrder(po: string, doc: WritablePo): Promise<unknown> {
        return this.post(`/${this.accountPath}/api/order/${encodeURIComponent(po)}`, doc);
    }
    /** Restore the pre-edit status (ORDER_LOCKED / ORDER_COMPLETED). */
    async restore(po: string, status: string): Promise<void> {
        return this.restoreOrderStatus(po, status);
    }
    /** Upsert the Freight 10007 line with ADJ_BY_WEIGHT and a full allocation list. */
    async setFreight(po: string, amount: number): Promise<unknown> {
        return this.addOrderAdjustment(po, "FREIGHT", amount);
    }
    /**
     * Mark a PO completed again.
     * `restoreOrderStatus` deliberately never re-completes (no reception, no
     * complete), so a PO that was COMPLETED before the edit has to be completed
     * on purpose or it silently drops back to Committed.
     */
    async complete(po: string): Promise<unknown> {
        return this.completeOrder(po);
    }
}

/**
 * Apply one plan: prices first (one POST), then the freight line, then restore
 * the original status, then read the PO back and report what it holds now.
 */
async function applyPlan(writer: FinaleWriter, plan: PoPlan): Promise<string> {
    const priceChanges = plan.changes.filter((c) => c.type === "price");
    if (priceChanges.length) {
        const doc = await writer.fetchPo(plan.po);
        const originalStatus = await writer.unlock(doc, plan.po);
        const fresh = await writer.fetchPo(plan.po);
        const items = fresh.orderItemList || [];
        for (const change of priceChanges) {
            const item = items.find((it) => String(it.productId) === change.sku);
            if (!item) throw new Error(`${change.sku} is not on PO ${plan.po}`);
            item.unitPrice = change.newValue;
        }
        await writer.postOrder(plan.po, { ...fresh, orderItemList: items });
        await writer.restore(plan.po, originalStatus);
    }
    const freightChange = plan.changes.find((c) => c.type === "freight");
    if (freightChange) {
        await writer.setFreight(plan.po, freightChange.newValue ?? 0);
        await writer.restore(plan.po, plan.statusId);
    }
    if (plan.statusId === "ORDER_COMPLETED") {
        await writer.complete(plan.po);
    }

    const after = await writer.fetchPo(plan.po);
    const read = readFinalePo(after);
    return (
        `   wrote  ${plan.po} ${read.statusId} goods ${read.goods.toFixed(2)} ` +
        `freight ${read.freight.map((f) => f.amount.toFixed(2)).join("+") || "0.00"} ` +
        `tax ${read.tax.toFixed(2)} total ${read.booked.toFixed(2)}`
    );
}

// ── Capture worksheet (spend with no PO) ─────────────────────────────────────

/**
 * Every ASIN this export proved belongs to a Finale SKU, from all three pairing
 * passes. An Amazon line whose ASIN is in here is stock we already buy, so a
 * purchase of it without a PO is a capture gap rather than a new item.
 */
function asinSkuMap(
    findings: PoFinding[],
): Map<string, { sku: string; po: string; unitsPerPack: number; verified: boolean; source?: string }> {
    const map = new Map<
        string,
        { sku: string; po: string; unitsPerPack: number; verified: boolean; source?: string }
    >();
    // Verified pairs first: they are price-matched against a real PO line and give the only
    // pack ratio worth trusting. A name-matched or candidate link may still name a SKU, but
    // its quantity cannot be converted, so it is flagged and kept out of purchase totals.
    for (const [asin, conv] of Object.entries(ASIN_SKU_UNITS)) {
        map.set(asin, { sku: conv.sku, po: "", unitsPerPack: conv.unitsPerPack, verified: true, source: "table" });
    }
    const ordered: Array<{ p: PairResult; verified: boolean }> = [];
    for (const f of findings) {
        for (const p of f.pairs) ordered.push({ p, verified: true });
        for (const p of [...f.titleMatches, ...f.candidates]) ordered.push({ p, verified: false });
    }
    {
        for (const { p, verified } of ordered) {
            if (!p.amazon.asin || p.amazon.quantity <= 0) continue;
            // Finale units per Amazon pack, the ratio Bill's own POs already use
            // (20 label packs -> 80 rolls, 10 mailer packs -> 1000 mailers). A
            // quantity-mismatch pair carries no usable ratio, and where the POs
            // disagree (TN830 booked both as packs and as cartridges) the larger
            // ratio wins, which is the cartridge-level reading.
            const usable = verified && !p.qtyMismatch && p.dividesEvenly && p.amazon.quantity > 0;
            const ratio = usable ? Math.round((p.finale.quantity / p.amazon.quantity) * 1e4) / 1e4 : 0;
            const existing = map.get(p.amazon.asin);
            if (existing) {
                if (existing.verified) continue; // the reviewed table wins
                if (ratio > existing.unitsPerPack) existing.unitsPerPack = ratio;
                if (verified) existing.verified = true;
                continue;
            }
            map.set(p.amazon.asin, {
                sku: p.finale.productId,
                po: findings.find((f) => f.pairs.includes(p) || f.titleMatches.includes(p) || f.candidates.includes(p))?.po ?? "",
                unitsPerPack: ratio > 0 ? ratio : 1,
                verified,
            });
        }
    }
    return map;
}

type CaptureClass =
    | "STOCK-CONSUMABLE"
    | "PRODUCTION-CONSUMABLE"
    | "REPAIR-ONE-OFF"
    | "NON-INVENTORY"
    | "REVIEW";

/**
 * Hand classification of every ASIN that showed up with no PO number, reviewed
 * one line at a time on 2026-09-29. A keyword rule can misfire on these (a
 * "cartridge" is both 3M PPE and printer toner; a "fan" is both a PC part and a
 * break-room appliance), so the ASIN decides and the rules only cover new ones.
 */
const ASIN_CLASS: Record<string, [CaptureClass, string]> = {
    // Shipping and print consumables we buy over and over
    B00AEFCP0E: ["STOCK-CONSUMABLE", "3M 6006 respirator cartridges, 50 pairs over two lines, shop PPE"],
    B0CPMDDTGX: ["STOCK-CONSUMABLE", "Brother DR830 drum unit, same family as the TN830 we stock"],
    B07MF1598K: [
        "NON-INVENTORY",
        "PSBM 10x13 poly mailers ordered in error 07/06/2026; staff consumed them instead of " +
            "sending them back, so it is a one-off expense — no SKU, no PO (Bill, 2026-09-29)",
    ],
    B09P2WVQ65: ["STOCK-CONSUMABLE", "MUNBYN thermal receipt paper, check against S-16160 (2.25x85)"],
    // Small use-it-up production supplies
    B07571T12F: ["PRODUCTION-CONSUMABLE", "hygienic wipes"],
    B0064O7Y64: ["PRODUCTION-CONSUMABLE", "Star San acid sanitizer"],
    B08HL7VHTV: ["PRODUCTION-CONSUMABLE", "fermentation pH test strips"],
    // Repair and maintenance of buildings and equipment, one-offs by nature
    B0F7XF2M16: ["REPAIR-ONE-OFF", "garage door lock"],
    B0BYNVQRRT: ["REPAIR-ONE-OFF", "garage door side locks, 4 pack"],
    B0GRTW6FCZ: ["REPAIR-ONE-OFF", "garage door deadlock"],
    B09NYLJ1FZ: ["REPAIR-ONE-OFF", "toilet fill valve"],
    B0BZX4BY85: ["REPAIR-ONE-OFF", "LED high bay fixtures, 10 pack"],
    B09GTYXGB1: ["REPAIR-ONE-OFF", "solar motion lights"],
    B0GFJKKT51: ["REPAIR-ONE-OFF", "15 outdoor power strips, confirm it is not a stocked item"],
    B0D47J76HR: ["REPAIR-ONE-OFF", "hex key wrenches"],
    B0G13M8CQJ: ["REPAIR-ONE-OFF", "nail magnetic sweeper"],
    B0BDCKFJJT: ["REPAIR-ONE-OFF", "500W PSU, PC repair"],
    B0FH26SQ8V: ["REPAIR-ONE-OFF", "ARGB case fans, bought twice"],
    B0D1VGZP7Z: ["REPAIR-ONE-OFF", "RGB case fans, bought twice"],
    B0DGTDGWV1: ["REPAIR-ONE-OFF", "replacement 12V cord for the Sceptre monitor"],
    B0D2VVX6HP: ["REPAIR-ONE-OFF", "USB hub"],
    B0D5ZHG8JX: ["REPAIR-ONE-OFF", "ethernet couplers"],
    B07K14NR8P: ["REPAIR-ONE-OFF", "VGA to HDMI adapter"],
    B097SVQ2S5: ["REPAIR-ONE-OFF", "camlock fittings"],
    B0CRB56GZP: ["REPAIR-ONE-OFF", "PVC suction hose"],
    B08L4XTB2G: ["REPAIR-ONE-OFF", "IBC vented lid"],
    B0F83XBSPC: ["REPAIR-ONE-OFF", "IBC tote drain adapter"],
    B0GHYFSDCY: ["REPAIR-ONE-OFF", "IBC tote hose adapter"],
    B01MQIN56L: ["REPAIR-ONE-OFF", "rain barrel inlet adapter"],
    B08FSMYWZ3: ["REPAIR-ONE-OFF", "garden hose adapter"],
    // Admin, facility, breakroom, and equipment
    B0G69256FH: ["NON-INVENTORY", "massage chair, one-off, disregard"],
    B087ZMJ98M: ["NON-INVENTORY", "diaper bag, one-off, disregard"],
    B0GBVMN3HS: ["NON-INVENTORY", "DVD, not a business purchase"],
    B09MDQ9KD6: ["NON-INVENTORY", "standing desk"],
    B0BY4JVXPL: ["NON-INVENTORY", "desk organizers"],
    B0BZ7F34CX: ["NON-INVENTORY", "whiteboards, bought twice"],
    B0BW9L8ZGK: ["NON-INVENTORY", "breakroom fan"],
    B09BXT3J9Z: ["NON-INVENTORY", "facial tissues"],
    B09B1T3ZF7: ["NON-INVENTORY", "dish soap"],
    B0CV9CMWKT: ["NON-INVENTORY", "hand soap"],
    B00WVPIHXY: ["NON-INVENTORY", "3M Cavilon barrier cream, first aid"],
    B0032JLFZK: ["NON-INVENTORY", "3M Duraprep remover, first aid"],
    B0DFMD8RDM: ["NON-INVENTORY", "acrylic drawer organizer"],
    B0C7162144: ["NON-INVENTORY", "kitchen scale"],
    B001CDTLGS: ["NON-INVENTORY", "Winco utility scoop"],
    B002P5RGMI: ["NON-INVENTORY", "compost thermometer, tool"],
    B0897BW3B9: ["NON-INVENTORY", "digital lab scale, tool"],
    B0BL352NXF: ["NON-INVENTORY", "water flow meter, tool"],
};

/** Fallback for an ASIN nobody has classified yet. */
const CLASS_RULES: Array<{ klass: CaptureClass; re: RegExp; why: string }> = [
    { klass: "STOCK-CONSUMABLE", re: /toner|drum unit|ink cartridge|printhead/i, why: "printer consumable" },
    { klass: "STOCK-CONSUMABLE", re: /thermal (label|postage|receipt|paper)|poly (mailer|bag)|mailer/i, why: "shipping consumable" },
    { klass: "STOCK-CONSUMABLE", re: /respirator (cartridge|filter)|particulate|n95/i, why: "shop PPE" },
    { klass: "REPAIR-ONE-OFF", re: /garage door|fill valve|camlock|cam lock|ibc tote|rain barrel|hose|power cord|usb hub|ethernet|adapter|coupler|sweeper|hex key|power strip|high bay|solar/i, why: "repair or site part" },
    { klass: "PRODUCTION-CONSUMABLE", re: /sanitizer|sanitizing|test strip|wipe/i, why: "production supply" },
    { klass: "NON-INVENTORY", re: /desk|organizer|white ?board|chair|diaper|dvd|tissue|soap|scale|meter|thermometer|fan/i, why: "facility, office or tool" },
];

/**
 * Classify one unmatched Amazon line. Known SKUs are stock by definition; an
 * ASIN reviewed by hand wins over the keyword rules; anything else is REVIEW.
 */
function classifyCapture(line: AmazonLine, knownSku?: string): { klass: CaptureClass; why: string } {
    if (knownSku) return { klass: "STOCK-CONSUMABLE", why: `already stocked as ${knownSku}` };
    const hand = ASIN_CLASS[line.asin];
    if (hand) return { klass: hand[0], why: hand[1] };
    for (const rule of CLASS_RULES) {
        if (rule.re.test(line.title)) return { klass: rule.klass, why: rule.why };
    }
    return { klass: "REVIEW", why: "not classified yet, needs a call" };
}

/**
 * Write the capture worksheet: one row per Amazon line bought with no PO number,
 * classified as stock, production consumable, repair one-off, or non-inventory,
 * with the Finale SKU when the ASIN is already known. Nothing is written to
 * Finale from here.
 */
function writeCaptureSheet(
    report: Report,
    map: Map<string, { sku: string; po: string; unitsPerPack: number }>,
    outPath: string,
): number {
    const header = [
        "class", "why", "order_date", "order_id", "asin", "title", "qty", "unit_price", "subtotal",
        "shipping", "promotion", "tax", "net", "category", "seller", "known_finale_sku", "seen_on_po",
        "DECIDE (po / expense / new-sku)", "FINE_SKU_TO_USE", "notes",
    ];
    const sorted = [...report.noPoOrders].sort((a, b) => (a.orderDate > b.orderDate ? 1 : -1));
    const lines: Array<{ line: AmazonLine; klass: CaptureClass; why: string; sku?: string; po?: string }> = [];
    for (const order of sorted) {
        for (const line of order.lines) {
            const hit = map.get(line.asin);
            const cls = classifyCapture(line, hit?.sku);
            lines.push({ line, klass: cls.klass, why: cls.why, sku: hit?.sku, po: hit?.po });
        }
    }
    const order: CaptureClass[] = ["STOCK-CONSUMABLE", "PRODUCTION-CONSUMABLE", "REPAIR-ONE-OFF", "NON-INVENTORY", "REVIEW"];
    lines.sort((a, b) => {
        const byClass = order.indexOf(a.klass) - order.indexOf(b.klass);
        if (byClass !== 0) return byClass;
        return b.line.net - a.line.net;
    });

    const totals = new Map<CaptureClass, { n: number; net: number }>();
    const rows = lines.map(({ line, klass, why, sku, po }) => {
        const acc = totals.get(klass) || { n: 0, net: 0 };
        acc.n += 1;
        acc.net += line.net;
        totals.set(klass, acc);
        const suggestion =
            klass === "STOCK-CONSUMABLE"
                ? sku
                    ? `we stock this as ${sku} (PO ${po}) - needs a PO`
                    : "stock consumable - needs a SKU before a PO"
                : klass === "REPAIR-ONE-OFF"
                  ? "one-off repair or site part - no PO"
                  : klass === "NON-INVENTORY"
                    ? "not inventory - expense it"
                    : klass === "PRODUCTION-CONSUMABLE"
                      ? "small production supply - expense or SKU"
                      : "needs a call";
        return [
            klass,
            why,
            line.orderDate,
            line.orderId,
            line.asin,
            line.title,
            line.quantity,
            line.ppu.toFixed(2),
            line.subtotal.toFixed(2),
            line.shipping.toFixed(2),
            line.promotion.toFixed(2),
            line.tax.toFixed(2),
            line.net.toFixed(2),
            line.category,
            line.seller,
            sku ?? "",
            po ?? "",
            suggestion,
            "",
            "",
        ]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(",");
    });

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, [header.join(","), ...rows].join("\n"), "utf8");

    console.log(`\nCapture worksheet: ${rows.length} line(s) with no PO number, by class`);
    for (const klass of order) {
        const acc = totals.get(klass);
        if (!acc) continue;
        console.log(`  ${klass.padEnd(22)} ${String(acc.n).padStart(3)} line(s)  $${acc.net.toFixed(2).padStart(9)}`);
    }
    console.log(`Worksheet: ${outPath}`);
    return rows.length;
}

/**
 * Create the capture PO from a plan: empty PO, then one POST carrying the
 * supplier, the Amazon order date, the lines at the price actually paid, and a
 * committed status so it can be received. Shipping goes on afterwards as a bare
 * Freight line so it rolls into landed cost.
 */
async function createCapturePo(writer: FinaleWriter, plan: CapturePoPlan): Promise<{ po: string; log: string }> {
    const po = await writer.createEmptyPo();
    const doc = await writer.fetchPo(po);
    const items = plan.lines.map((l) => ({
        productId: l.sku,
        productUrl: `/${(writer as unknown as { accountPath: string }).accountPath}/api/product/${encodeURIComponent(l.sku)}`,
        quantity: l.finaleqty,
        unitPrice: Math.round((l.unitPrice + Number.EPSILON) * 1e6) / 1e6,
    }));
    const facilityUrl = (doc.orderUrl ?? "").replace(/\/api\/order\/.*$/, "") + `/api/facility/${DESTINATION_FACILITY}`;
    await writer.postOrder(po, {
        ...doc,
        orderDate: `${plan.isoDate}T18:00:00`,
        orderRoleList: [{ roleTypeId: "SUPPLIER", partyId: AMAZON_PARTY_ID }],
        destinationFacilityUrl: facilityUrl,
        orderItemList: items,
        statusId: "ORDER_LOCKED",
    });
    if (plan.freight > 0.005) {
        await writer.setFreight(po, plan.freight);
    }
    await writer.restore(po, "ORDER_LOCKED");

    const after = await writer.fetchPo(po);
    const read = readFinalePo(after);
    const lines = read.lines.map((l) => `${l.productId} x${l.quantity}@${l.unitPrice.toFixed(5)}`).join(" ");
    return {
        po,
        log:
            `   created PO ${po} ${read.statusId} ${read.orderDate} | ${lines} | ` +
            `freight ${read.freight.map((f) => f.amount.toFixed(2)).join("+") || "0.00"} | total ${read.booked.toFixed(2)} ` +
            `(amazon ${plan.amazonNet.toFixed(2)})`,
    };
}

// ── Capture POs (spend with no PO, stock consumables only) ────────────────────

interface CapturePoLine {
    sku: string;
    /** Finale units, converted from Amazon packs using the ratio the POs already use. */
    finaleqty: number;
    unitPrice: number;
    asin: string;
    title: string;
    amazonNet: number;
}

interface CapturePoPlan {
    order: AmazonOrder;
    isoDate: string;
    lines: CapturePoLine[];
    freight: number;
    amazonNet: number;
    notes: string[];
}

/** "06/19/2026" (Amazon) -> "2026-06-19" (Finale). */
function amazonDateToIso(date: string): string {
    const m = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : date;
}

/**
 * One PO per Amazon order, carrying only the stock consumables that order held.
 * Units come from the pack ratio the existing POs already established (4 rolls
 * per label pack, 100 mailers per pack), so a capture PO books the same unit of
 * measure Bill's own POs use. Lines with no money and no quantity (free
 * replacements) are listed as notes instead.
 */
/**
 * Per-SKU coverage: how many Finale units Amazon actually sold, versus how many are
 * already booked on a PO. Bill writes one PO that covers several Amazon orders and
 * often leaves the PO field blank on the later ones, so a blank PO field does NOT
 * mean the goods were never booked — purchase orders must be compared as SKU totals,
 * never order by order, or the capture run double-books stock the shelf already has.
 */
function skuCoverage(
    report: Report,
    map: Map<string, { sku: string; po: string; unitsPerPack: number; verified: boolean; source?: string }>,
    allOrders: AmazonOrder[],
    extraBooked?: Map<string, number>,
): Map<string, { sku: string; bought: number; booked: number }> {
    const cover = new Map<string, { sku: string; bought: number; booked: number }>();
    /** For --debug-cover: which ASIN/order contributed what. */
    const trace = new Map<string, string[]>();
    const at = (sku: string) => {
        let entry = cover.get(sku);
        if (!entry) {
            entry = { sku, bought: 0, booked: 0 };
            cover.set(sku, entry);
        }
        return entry;
    };
    // Bought units come straight from the export, one count per purchased line: the
    // pairing machinery can surface the same line under several bases.
    // Object identity: the same line can appear under several pairing bases, but two
    // genuinely separate rows of the same item in one order are different objects.
    const seen = new Set<AmazonLine>();
    for (const order of allOrders) {
        for (const line of order.lines) {
            // A $0 line is a free replacement of stock already counted; it is not a purchase.
            if (!line.asin || line.quantity <= 0 || line.net <= 0.005 || /cancel/i.test(line.orderStatus ?? "")) continue;
            const hit = map.get(line.asin);
            // Only the reviewed table may drive purchase totals. A price-verified pair proves
            // two lines cost alike, not that they are the same product — a matched ASIN of a
            // different brand would otherwise invent stock that was never bought.
            if (!hit?.verified || hit.source !== "table") continue;
            if (seen.has(line)) continue;
            seen.add(line);
            const units = line.quantity * (hit.unitsPerPack > 0 ? hit.unitsPerPack : 1);
            at(hit.sku).bought += units;
            trace.set(hit.sku, [...(trace.get(hit.sku) ?? []), `${line.asin} ${order.orderDate} q${line.quantity}x${hit.unitsPerPack}=${units}`]);
        }
    }
    // Booked: every line on a PO the export knows, plus POs this tool created earlier
    // (they carry no Amazon PO number, so the export cannot see them).
    for (const finding of report.findings) {
        for (const l of finding.finale.lines) {
            if (!l.productId) continue;
            at(l.productId.trim()).booked += l.quantity;
        }
    }
    for (const [sku, units] of extraBooked ?? []) at(sku.trim()).booked += units;
    for (const [sku, parts] of trace) {
        if ((cover.get(sku)?.bought ?? 0) > (cover.get(sku)?.booked ?? 0) + 0.005) {
            cover.set(`trace:${sku}`, { sku, bought: 0, booked: 0 });
            trace.set(`trace:${sku}`, parts);
        }
    }
    (cover as unknown as { traces?: Map<string, string[]> }).traces = trace;
    return cover;
}

/** Capture POs created on earlier runs, so their units are never booked twice. */
const CAPTURE_STATE = path.join(process.cwd(), ".hermes", "amazon-capture-pos.json");

function readCapturePoState(): string[] {
    try {
        const parsed = JSON.parse(fs.readFileSync(CAPTURE_STATE, "utf8"));
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

function rememberCapturePo(po: string): void {
    const all = [...new Set([...readCapturePoState(), String(po)])];
    fs.mkdirSync(path.dirname(CAPTURE_STATE), { recursive: true });
    fs.writeFileSync(CAPTURE_STATE, JSON.stringify(all, null, 1), "utf8");
}


function buildCapturePos(
    report: Report,
    map: Map<string, { sku: string; po: string; unitsPerPack: number; verified: boolean }>,
    cover?: Map<string, { sku: string; bought: number; booked: number }>,
): CapturePoPlan[] {
    // Remaining unbooked units per SKU, spent oldest order first as the plans are built.
    const shortfall = new Map<string, number>();
    if (cover) {
        for (const [sku, c] of cover) shortfall.set(sku, c.bought - c.booked);
    }
    const plans: CapturePoPlan[] = [];
    for (const order of [...report.noPoOrders].sort((a, b) => (a.orderDate > b.orderDate ? 1 : -1))) {
        const lines: CapturePoLine[] = [];
        const notes: string[] = [];
        let freight = 0;
        let amazonNet = 0;
        for (const line of order.lines) {
            const hit = map.get(line.asin);
            const cls = classifyCapture(line, hit?.sku);
            if (cls.klass !== "STOCK-CONSUMABLE" || !hit) {
                if (cls.klass === "STOCK-CONSUMABLE") {
                    notes.push(`${line.title.slice(0, 40)} is stock but has no SKU yet`);
                }
                continue;
            }
            if (line.quantity <= 0 || line.net <= 0.005) {
                notes.push(`${hit.sku}: ${line.title.slice(0, 34)} booked no money (replacement), skipped`);
                continue;
            }
            const perPack = hit.unitsPerPack > 0 ? hit.unitsPerPack : 1;
            let finaleqty = Math.round(line.quantity * perPack * 1e4) / 1e4;
            const room = shortfall.get(hit.sku);
            if (room !== undefined) {
                if (room <= 0.005) {
                    notes.push(
                        `${hit.sku}: ${line.title.slice(0, 30)} already booked - SKU total ` +
                            `${cover?.get(hit.sku)?.bought ?? 0} bought vs ${cover?.get(hit.sku)?.booked ?? 0} booked, skipped`,
                    );
                    continue;
                }
                if (finaleqty > room) {
                    notes.push(`${hit.sku}: trimmed ${finaleqty} to the unbooked ${room} units`);
                    finaleqty = room;
                }
                shortfall.set(hit.sku, Math.round((room - finaleqty) * 1e4) / 1e4);
            }
            const goods = line.subtotal + line.promotion;
            // One Finale line per SKU: Amazon splits the same item across rows.
            const merged = lines.find((l) => l.sku === hit.sku);
            if (merged) {
                // Total the dollars first, then re-derive the unit price: using the
                // already-updated quantity here double counts the earlier line.
                const mergedTotal = merged.finaleqty * merged.unitPrice + goods;
                merged.finaleqty = Math.round((merged.finaleqty + finaleqty) * 1e4) / 1e4;
                merged.unitPrice = mergedTotal / merged.finaleqty;
                merged.amazonNet = round2(merged.amazonNet + line.net);
            } else {
                lines.push({
                    sku: hit.sku,
                    finaleqty,
                    unitPrice: goods / finaleqty,
                    asin: line.asin,
                    title: line.title,
                    amazonNet: line.net,
                });
            }
            if (/monitor|standing desk|massage chair|lab scale|handheld inkjet/i.test(line.title)) {
                notes.push(`${hit.sku}: looks like hardware rather than a consumable, include or drop`);
            }
            freight += line.shipping;
            amazonNet += line.net;
        }
        if (!lines.length) continue;
        plans.push({
            order,
            isoDate: amazonDateToIso(order.orderDate),
            lines,
            freight: round2(freight),
            amazonNet: round2(amazonNet),
            notes,
        });
    }
    return plans;
}

function printCapturePlans(plans: CapturePoPlan[], live: boolean): void {
    console.log(`\n${live ? "CREATING" : "CAPTURE PO PLAN (dry run)"} — ${plans.length} PO(s)\n`);
    let total = 0;
    for (const plan of plans) {
        total += plan.amazonNet;
        console.log(
            `${plan.order.orderDate} order ${plan.order.orderId} -> PO dated ${plan.isoDate}, vendor Amazon`,
        );
        for (const l of plan.lines) {
            console.log(
                `   ${l.sku.padEnd(12)} ${String(l.finaleqty).padStart(7)} x ${l.unitPrice.toFixed(5).padStart(10)} = ` +
                    `${(l.finaleqty * l.unitPrice).toFixed(2).padStart(8)}  (${l.asin}) ${l.title.slice(0, 40)}`,
            );
        }
        console.log(`   freight ${plan.freight.toFixed(2)}  total ${(plan.amazonNet).toFixed(2)}\n`);
        for (const note of plan.notes) console.log(`   note: ${note}`);
    }
    console.log(`${plans.length} PO(s), $${total.toFixed(2)} of missed stock consumables.`);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const arg = (name: string): string | undefined => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const fixMode = argv.includes("--fix");
    const live = argv.includes("--live");
    if (live && !fixMode && !argv.includes("--capture-po")) {
        console.error("--live only applies with --fix or --capture-po. Run without --live first to see the plan.");
        process.exit(2);
    }

    // Re-complete POs that an edit dropped back to Committed, or any PO the
    // caller names. Finale's own statuses: ORDER_COMPLETED / ORDER_LOCKED.
    const completeArg = arg("--complete");
    if (completeArg) {
        const writer = new FinaleWriter();
        const pos = completeArg.split(",").map((s) => s.trim()).filter(Boolean);
        for (const po of pos) {
            try {
                await writer.complete(po);
                const doc = await writer.fetchPo(po);
                console.log(`   completed ${po} -> ${doc.statusId}`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`   FAILED ${po} — ${message.split("\n")[0]}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        return;
    }

    const csvPath = arg("--csv") || newestExport();
    if (!csvPath || !fs.existsSync(csvPath)) {
        console.error("No Amazon order export found. Pass --csv <path>.");
        process.exit(1);
    }

    const { orders, cancelledLines } = readAmazonExport(csvPath);
    const byPo = new Map<string, AmazonOrder[]>();
    const noPoOrders: AmazonOrder[] = [];
    for (const order of orders.values()) {
        if (!order.po) {
            noPoOrders.push(order);
            continue;
        }
        const list = byPo.get(order.po) || [];
        list.push(order);
        byPo.set(order.po, list);
    }

    const filter = arg("--po");
    const wanted = filter ? filter.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const poList = [...byPo.keys()].filter((po) => !wanted || wanted.includes(po));

    console.log(
        `Amazon export: ${orders.size} orders, ${poList.length} PO number(s), ` +
            `${noPoOrders.length} order(s) with no PO. Reading Finale…`,
    );

    const finale = new FinaleClient() as unknown as {
        getOrderDetails(id: string): Promise<RawFinaleOrder>;
    };
    const findings: PoFinding[] = [];
    for (const po of poList) {
        let finalePo: FinalePo | null = null;
        // Finale intermittently 404s or throttles a read; a single miss must not
        // be reported as "PO not found" — retry before believing it.
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const raw = await finale.getOrderDetails(po);
                finalePo = readFinalePo(raw);
                if (finalePo.supplierPartyId !== AMAZON_PARTY_ID) {
                    console.warn(
                        `  ${po}: supplier party ${finalePo.supplierPartyId} is not Amazon (${AMAZON_PARTY_ID}) — included anyway`,
                    );
                }
                break;
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                if (attempt === 3) {
                    console.warn(`  ${po}: Finale read failed after 3 tries — ${message.split("\n")[0]}`);
                } else {
                    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
                }
            }
        }
        findings.push(analyse(po, byPo.get(po)!, finalePo));
    }
    findings.sort((a, b) => a.po.localeCompare(b.po));

    const report: Report = {
        csvPath,
        generatedAt: new Date().toISOString(),
        findings,
        noPoOrders,
        noPoTotal: round2(noPoOrders.reduce((s, o) => s + o.net, 0)),
        cancelledLines,
    };

    printReport(report, argv.includes("--lines"));
    const outPath = arg("--report") || defaultReportPath();
    writeFindingsCsv(report, outPath);
    console.log(`\nFindings CSV: ${outPath}`);

    if (argv.includes("--capture")) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const sheet =
            arg("--capture-out") ?? path.join(path.dirname(outPath), `amazon-capture-${stamp}.csv`);
        writeCaptureSheet(report, asinSkuMap(findings), sheet);
    }

    if (argv.includes("--capture-po")) {
        const map = asinSkuMap(findings);
        const writer = new FinaleWriter();
        const priorPos = readCapturePoState();
        const priorUnits = await writer.capturePoUnits(priorPos);
        const cover = skuCoverage(report, map, [...orders.values()], priorUnits);
        if (priorPos.length) console.log(`   counting ${priorPos.length} capture PO(s) from earlier runs: ${priorPos.join(", ")}`);
        if (argv.includes("--debug-cover")) {
            for (const [sku, c] of cover) {
                if (sku.startsWith("trace:")) continue;
                console.log(`   cover ${sku}: bought ${c.bought} booked ${c.booked} short ${c.bought - c.booked}`);
            }
            const tr = (cover as unknown as { traces?: Map<string, string[]> }).traces;
            for (const [sku, parts] of tr ?? []) {
                if (sku.startsWith("trace:")) console.log(`   how ${sku.slice(6)}: ${parts.join(" | ")}`);
            }
        }
        const plans = buildCapturePos(report, map, cover);
        printCapturePlans(plans, live);
        if (!live) {
            console.log("\nDry run. Re-run with --capture-po --live to create these POs in Finale.");
            return;
        }
        for (const plan of plans) {
            try {
                const created = await createCapturePo(writer, plan);
                rememberCapturePo(created.po);
                console.log(created.log);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`   FAILED ${plan.order.orderId} — ${message.split("\n")[0]}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        return;
    }

    if (!fixMode) return;

    const plans = findings
        .map((f) => buildPlan(f))
        .filter((p): p is PoPlan => p !== null)
        .sort((a, b) => a.po.localeCompare(b.po));
    printPlans(plans, live);

    if (plans.every((p) => !p.changes.some((c) => c.type !== "quantity-needs-call"))) {
        console.log("Nothing to write: the remaining gaps are quantity calls for you.");
        return;
    }
    if (!live) {
        console.log("Dry run. Re-run with --fix --live to write these changes to Finale.");
        return;
    }

    const writer = new FinaleWriter();
    for (const plan of plans) {
        if (!plan.changes.some((c) => c.type !== "quantity-needs-call")) {
            console.log(`   skip   ${plan.po} — only a quantity change, needs your call`);
            continue;
        }
        if (plan.changes.some((c) => c.type === "quantity-needs-call")) {
            console.log(
                `   skip   ${plan.po} — POs with an open quantity call stay untouched until you decide ` +
                    `(prices on the other lines are re-planned after)`,
            );
            continue;
        }
        try {
            console.log(await applyPlan(writer, plan));
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`   FAILED ${plan.po} — ${message.split("\n")[0]}`);
        }
        // Finale rate-limits hard; a burst upsets their staff.
        await new Promise((resolve) => setTimeout(resolve, 1500));
    }
}

main().catch((err) => {
    console.error("reconcile-amazon failed:", err);
    process.exit(1);
});
