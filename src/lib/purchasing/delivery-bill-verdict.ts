/**
 * @file    src/lib/purchasing/delivery-bill-verdict.ts
 * @purpose One answer per DELIVERY: did what arrived match the bill the vendor
 *          sent for it, and is that bill safe to load into Bill.com?
 *
 * BILL'S MODEL (2026-11-03, verbatim):
 *   "I/we send PO...Miles makes delivery of some or all of that PO...Who knows
 *    until reception lands. Miles sends invoice for delivery, typically same
 *    day. I want to see on RCV dashboard that it was received and if it in fact
 *    matches the invoice he sent. This would be the same for any vendor really.
 *    Miles and Colorado worm just hand deliver. The process is the same however
 *    the product arrives. Were we over billed? Under delivered? Is it in fact
 *    OK to load invoice into bill.com?"
 *
 * So the unit of truth is the DELIVERY, not the PO. A PO may receive several
 * deliveries; each one gets its own bill, usually same-day. The three questions
 * are always the same regardless of carrier, vendor, or how it arrived:
 *
 *   1. UNDER DELIVERED?  received < billed   (bill claims more than arrived)
 *   2. OVER BILLED?      billed > received × price, beyond tolerance
 *   3. OK TO LOAD?       only when every billed unit is on the shelf at the
 *                        billed price. Otherwise: hold, don't pay.
 *
 * The receipt is the fact. The bill is the claim. The verdict is the claim
 * checked against the fact — never the PO total, which would pay for goods
 * that never arrived simply because they were ordered.
 *
 * @author  Hermia
 * @created 2026-11-03
 * @deps    @/lib/finale/reconciler (pack inference — one pack rule)
 */

import { inferPackMultiplierFromReceipt } from "../finale/reconciler";

/** A delivered line, as recorded by the receiving desk (Finale shipments). */
export interface DeliveredLine {
    sku: string;
    description?: string | null;
    /** Units actually received against this delivery. */
    receivedQty: number;
    /** PO unit price — the price we agreed to pay. */
    poUnitPrice: number;
}

/** A billed line, exactly as the vendor's document reads. */
export interface BilledLine {
    sku?: string | null;
    description?: string | null;
    qty: number;
    unitPrice: number;
    extPrice?: number | null;
    /** Set when this bill line was tied to a PO/delivery line without a printed SKU. */
    matchedSku?: string | null;
}

export type BillDisposition = "load" | "hold" | "review";

/** Per-line head-to-head: what arrived vs what the bill charges for. */
export interface DeliveryBillLine {
    sku: string;
    description?: string | null;
    /** Units received for this delivery. */
    receivedQty: number;
    /** Units the bill charges for. */
    billedQty: number;
    /** received − billed. Negative = under-delivered. */
    qtyDelta: number;
    poUnitPrice: number;
    billedUnitPrice: number;
    /** Dollars the bill charges for this line. */
    billedAmount: number;
    /** Dollars actually received at the PO price. */
    receivedAmount: number;
    /** billedAmount − receivedAmount. Positive = over billed. */
    amountDelta: number;
    /** Billed for a SKU that did not arrive at all. */
    notDelivered: boolean;
    /** Arrived but the bill does not charge for it (vendor forgot to bill). */
    notBilled: boolean;
    /** Bill charges for something the document does not identify precisely
     *  enough to compare (variant suffixes, pack prices). Not an accusation. */
    unmatchedBillLine?: boolean;
}

export interface DeliveryBillVerdict {
    /** The answer Bill asks for: load it into Bill.com, or hold it. */
    disposition: BillDisposition;
    /** One plain sentence for the receiving row. */
    headline: string;
    /** True when goods arrived short of what the bill charges for. */
    underDelivered: boolean;
    /** True when the bill charges more than the delivered goods are worth. */
    overBilled: boolean;
    /** True when every billed unit arrived at the billed price. */
    matches: boolean;
    /** Dollars over billed (0 when none). */
    overBilledAmount: number;
    /** Dollars received but not billed (0 when none). */
    unbilledAmount: number;
    lines: DeliveryBillLine[];
    /** Human-readable reasons the bill is held. Empty when loadable. */
    reasons: string[];
}

/** Round to cents so float drift never reads as a dollar discrepancy. */
function round2(n: number): number {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * The stable stem of a SKU: everything before a trailing all-digit run.
 *
 * ULINE's OCR glues the case count onto the part number, so `S-4738` appears as
 * `S-473824` and `S-1667` as `S-166712`. The stem strips that debris. It is only
 * ever used to CANDIDATE a pairing — never to declare a match on its own.
 *
 * @param sku Raw SKU from either document.
 */
function skuStem(sku: string): string {
    return String(sku || "")
        .trim()
        .toUpperCase()
        .replace(/\d+$/, "");
}

/**
 * Do two SKUs plausibly name the same product?
 *
 * True when one is a prefix of the other after trimming digits (covers both an
 * appended pack count and a truncated suffix), or when they share an identical
 * stem. Identity is never decided here alone — the caller also requires the
 * quantity or the unit price to agree, and the candidate to be unique.
 *
 * @param a One SKU.
 * @param b The other SKU.
 */
function sameProductFamily(a: string, b: string): boolean {
    const A = String(a || "").trim().toUpperCase();
    const B = String(b || "").trim().toUpperCase();
    if (!A || !B) return false;
    if (A === B) return true;
    // Letters-only stems must be long enough to be meaningful.
    const stemA = skuStem(A);
    const stemB = skuStem(B);
    if (stemA.length >= 5 && stemB.length >= 5 && stemA === stemB) return true;
    if (A.startsWith(B) && B.length >= 5) return true;
    if (B.startsWith(A) && A.length >= 5) return true;
    return false;
}

/**
 * Re-express billed quantities in the units the shelf actually counts.
 *
 * ULINE bills "1 CASE", the receiving desk posts 12 units. Comparing those raw
 * numbers is what produced "over billed by $4,220" on correct bills.
 *
 * Uses the reconciler's `inferPackMultiplierFromReceipt` so there is ONE pack
 * rule in the codebase. That inference is conservative on purpose: it converts
 * only on a clean integer ratio (a pack of 12), and refuses on a messy one
 * (7.4 units is a short shipment, never a pack size). Any line it declines
 * stays 1:1, which makes the discrepancy visible instead of hiding it.
 *
 * @param delivered Delivery lines after pack conversion.
 * @param billed    Bill lines, converted in place where a pack is proven.
 */
export function convertPackUnits(
    delivered: DeliveredLine[],
    billed: BilledLine[],
): { lines: DeliveredLine[]; convertedSkus: string[] } {
    const bySku = new Map<string, DeliveredLine>();
    for (const d of delivered) {
        const key = String(d.sku || "").trim().toUpperCase();
        if (key) bySku.set(key, d);
    }

    const convertedSkus: string[] = [];
    for (const line of billed) {
        const key = String(line.matchedSku || line.sku || "")
            .trim()
            .toUpperCase();
        if (!key) continue;
        const d = bySku.get(key);
        if (!d) continue;

        const inference = inferPackMultiplierFromReceipt(
            Number(line.qty) || 0,
            Number(d.receivedQty) || 0,
            Number(d.receivedQty) || 0,
        );
        if (!inference) continue;

        // Billed 1 case, got 12 units → 12 billed units at 1/12 the unit price.
        line.qty = round2((Number(line.qty) || 0) * inference.multiplier);
        line.unitPrice = round2((Number(line.unitPrice) || 0) / inference.multiplier);
        // extPrice is authoritative for the money, so leave it untouched.
        convertedSkus.push(key);
    }

    return { lines: delivered, convertedSkus };
}

/**
 * Per-unit price tolerance, in dollars.
 *
 * A few cents of rounding on a unit price is not an overbill; a dollar is.
 * The absolute floor keeps cheap items (labels at $0.61) from flipping the
 * verdict on a one-cent rounding difference.
 *
 * @param unitPrice The agreed PO unit price.
 */
function priceTolerance(unitPrice: number): number {
    return Math.max(0.02, Math.abs(unitPrice) * 0.02);
}

/**
 * Compare ONE delivery against the bill the vendor sent for it.
 *
 * Pairing rules, in order:
 *   1. Printed SKU on the bill.
 *   2. `matchedSku` stamped by the pool's description+price alignment.
 *   3. A SKU-less bill line pairs to the single delivered line whose qty and
 *      unit price it repeats exactly. Two candidates = the bill cannot say
 *      which one it is, so it stays unpaired and forces review.
 *
 * @param delivered Lines the receiving desk recorded for this delivery.
 * @param billed    Lines the vendor's document charges for.
 * @param opts      Optional header totals for a whole-document cross-check.
 * @returns         The verdict, with the per-line detail behind it.
 */
export function checkDeliveryAgainstBill(
    delivered: DeliveredLine[],
    billed: BilledLine[],
    opts: { billTotal?: number | null } = {},
): DeliveryBillVerdict {
    // ── Pack conversion (2026-11-03) ────────────────────────────────────────
    // ULINE sells by the case and receives by the bottle: 1 case on the bill is
    // 12 units on the shelf. Comparing raw numbers called a correct bill "over
    // billed by $4,220". Use the reconciler's own inference — the receipt is
    // the evidence — and refuse to convert on a messy ratio, because a ratio of
    // 7.4 is a short shipment, not a pack size.
    const converted = convertPackUnits(delivered, billed);
    const delivered2 = converted.lines;

    const deliveredBySku = new Map<string, DeliveredLine>();
    for (const line of delivered2) {
        const key = String(line.sku || "").trim().toUpperCase();
        if (!key) continue;
        const existing = deliveredBySku.get(key);
        // Several receipts of the same SKU on one delivery accumulate.
        deliveredBySku.set(
            key,
            existing
                ? { ...existing, receivedQty: existing.receivedQty + line.receivedQty }
                : { ...line },
        );
    }

    const lines: DeliveryBillLine[] = [];
    const claimed = new Set<string>();
    const unpaired: BilledLine[] = [];

    for (const billLine of billed) {
        const key = String(billLine.matchedSku || billLine.sku || "")
            .trim()
            .toUpperCase();
        if (key && deliveredBySku.has(key)) {
            claimed.add(key);
            const d = deliveredBySku.get(key)!;
            lines.push(buildLine(d, billLine));
            continue;
        }
        if (key) {
            // The bill's SKU may be a mangled form of the real one — ULINE glues
            // the case count on (`S-4738`→`S-473824`, `S-1667`→`S-166712`) or
            // OCR drops a suffix (`S-23343BL-M`→`S-23343`). Pair only on PROOF:
            // the SKUs must plausibly be the same family, the pairing must be
            // UNIQUE among unclaimed delivered lines, and either the quantity or
            // the unit price must agree. Anything weaker stays unpaired so the
            // row shows the real discrepancy instead of hiding it.
            // DECISION(2026-11-03): PO 125429's $2,430 box charge and 125410's
            // $492 read as "over billed" purely from that debris.
            const candidates = [...deliveredBySku.values()].filter(
                (d) =>
                    !claimed.has(String(d.sku).trim().toUpperCase()) &&
                    sameProductFamily(key, String(d.sku)),
            );

            const price = Number(billLine.unitPrice) || 0;
            const proven = candidates.filter(
                (d) => Math.abs(d.poUnitPrice - price) <= priceTolerance(d.poUnitPrice),
            );
            if (candidates.length === 1 && proven.length === 1) {
                const d = proven[0];
                claimed.add(String(d.sku).trim().toUpperCase());
                lines.push(buildLine(d, billLine));
                continue;
            }
            // Several delivered items could equally be what this bill line
            // charges for (variant suffixes). That is a paperwork question, not
            // an overbill — hand it to a human without accusing the vendor.
            const ambiguous = candidates.length >= 2;
            lines.push(buildLine(null, billLine, key, ambiguous));
            continue;
        }
        unpaired.push(billLine);
    }

    // SKU-less bill lines: pair only on an exact qty + price repetition.
    for (const billLine of unpaired) {
        const qty = Number(billLine.qty) || 0;
        const price = Number(billLine.unitPrice) || 0;
        const candidates = [...deliveredBySku.values()].filter(
            (d) =>
                !claimed.has(String(d.sku).trim().toUpperCase()) &&
                d.receivedQty === qty &&
                Math.abs(d.poUnitPrice - price) <= priceTolerance(d.poUnitPrice),
        );
        if (candidates.length !== 1) continue;
        const d = candidates[0];
        claimed.add(String(d.sku).trim().toUpperCase());
        lines.push(buildLine(d, billLine));
    }

    // Delivered but never billed — the vendor owes us a bill, not the reverse.
    for (const [key, d] of deliveredBySku) {
        if (claimed.has(key)) continue;
        if (d.receivedQty <= 0) continue;
        lines.push(buildLine(d, null));
    }

    // ── The three questions ─────────────────────────────────────────────────
    // A line is over billed when the bill charges MORE than the goods received
    // are worth, beyond a small cent-level tolerance. Tolerance scales with the
    // line so 400 labels at a half-cent rounding difference is not an overbill
    // while a $1.51 gap on a $246 line is.
    const lineOverbilled = (l: DeliveryBillLine): number => {
        if (l.unmatchedBillLine) return 0; // unidentified, not proven over
        if (l.notDelivered) return l.billedAmount; // billed for nothing that arrived
        if (l.amountDelta <= 0) return 0;
        // Rounding happens PER UNIT: 400 labels at a half-cent unit-price
        // rounding gap is $2 of noise, not an overbill. Allow a cent per unit,
        // with a percentage floor for cheap low-count lines.
        const tolerance = Math.max(0.05, Math.abs(l.receivedAmount) * 0.005, l.receivedQty * 0.01);
        return l.amountDelta > tolerance ? l.amountDelta : 0;
    };

    const overBilledAmount = round2(
        lines.reduce((sum, l) => sum + lineOverbilled(l), 0),
    );
    // A bill line that names no delivered item has receivedQty 0, so its qty
    // delta is negative by construction. It must NOT be counted as an
    // under-delivery — that is the ambiguity path, handled separately.
    const underDeliveredLines = lines.filter(
        (l) => !l.unmatchedBillLine && (l.qtyDelta < 0 || l.notDelivered),
    );
    const ambiguousLines = lines.filter((l) => l.unmatchedBillLine);
    // Received and never billed: the vendor owes us a bill, we owe no money.
    const unbilledAmount = round2(
        lines.filter((l) => l.notBilled).reduce((sum, l) => sum + l.receivedAmount, 0),
    );

    const reasons: string[] = [];

    for (const l of underDeliveredLines) {
        if (l.notDelivered) {
            reasons.push(`${l.sku} billed ${l.billedQty} but never delivered`);
        } else {
            reasons.push(
                `${l.sku} under delivered — ${l.receivedQty} received, ${l.billedQty} billed (${Math.abs(l.qtyDelta)} short)`,
            );
        }
    }

    for (const l of lines) {
        if (l.notDelivered || l.notBilled) continue;
        const over = lineOverbilled(l);
        if (over > 0) {
            reasons.push(
                `${l.sku} over billed — $${l.billedAmount.toFixed(2)} billed vs $${l.receivedAmount.toFixed(2)} received`,
            );
        }
    }

    // Identified-but-unmatchable bill lines: the bill does not say WHICH item
    // it charges for. That is a paperwork problem to resolve with the vendor,
    // not an accusation of overbilling.
    for (const l of ambiguousLines) {
        reasons.push(
            `bill line "${l.sku}" at $${l.billedUnitPrice.toFixed(2)} × ${l.billedQty} does not identify a delivered item — confirm which SKU it is`,
        );
    }

    // Whole-document cross-check: a bill total that exceeds everything we can
    // account for means there is a charge we could not read as a line.
    const billTotal = opts.billTotal == null ? null : round2(Number(opts.billTotal));
    const accountedBilled = round2(lines.reduce((sum, l) => sum + l.billedAmount, 0));
    let unexplainedCharge = 0;
    if (billTotal != null && billTotal > 0 && accountedBilled > 0) {
        const gap = round2(billTotal - accountedBilled);
        if (gap > Math.max(1, billTotal * 0.01)) {
            unexplainedCharge = gap;
            reasons.push(
                `bill total $${billTotal.toFixed(2)} exceeds its readable lines by $${gap.toFixed(2)}`,
            );
        }
    }

    const overBilled = overBilledAmount > 0;
    const underDelivered = underDeliveredLines.length > 0;

    if (billed.length === 0) {
        return {
            disposition: "review",
            headline:
                delivered.length > 0
                    ? "Delivered — no bill received yet"
                    : "Nothing to compare",
            underDelivered: false,
            overBilled: false,
            matches: false,
            overBilledAmount: 0,
            unbilledAmount,
            lines,
            reasons: delivered.length > 0 ? ["no bill on file for this delivery"] : [],
        };
    }

    const matches = !overBilled && !underDelivered && reasons.length === 0;

    // A bill with no readable amount is UNKNOWN, not clean. "Safe to load $0.00"
    // would wave a blank bill into Bill.com — complete-or-unknown, never a pass.
    const billedTotal = round2(lines.reduce((sum, l) => sum + l.billedAmount, 0));
    if (matches && billedTotal <= 0) {
        return {
            disposition: "review",
            headline: "Bill amount unreadable — check the PDF before loading",
            underDelivered: false,
            overBilled: false,
            matches: false,
            overBilledAmount: 0,
            unbilledAmount,
            lines,
            reasons: ["bill has no readable amount"],
        };
    }

    if (matches) {
        const total = round2(lines.reduce((sum, l) => sum + l.billedAmount, 0));
        // Goods that arrived with no bill are a SEPARATE fact from "this bill is
        // correct". Saying only "safe to load" implies the PO is settled when
        // $1,440 of product is still unbilled (Miles 125408).
        if (unbilledAmount > 0) {
            return {
                disposition: "review",
                headline: `Bill matches $${total.toFixed(2)} — but $${unbilledAmount.toFixed(2)} arrived with no bill`,
                underDelivered: false,
                overBilled: false,
                matches: true,
                overBilledAmount: 0,
                unbilledAmount,
                lines,
                reasons: [
                    `$${unbilledAmount.toFixed(2)} delivered but not billed — the vendor still owes a bill on these lines`,
                ],
            };
        }
        return {
            disposition: "load",
            headline: `Matches — ${lines.length} line${lines.length === 1 ? "" : "s"}, $${total.toFixed(2)}. Safe to load into Bill.com.`,
            underDelivered: false,
            overBilled: false,
            matches: true,
            overBilledAmount: 0,
            unbilledAmount,
            lines,
            reasons: [],
        };
    }

    // A bill that charges for goods we do not have is never loadable.
    if (underDelivered || overBilled || ambiguousLines.length > 0) {
        return {
            disposition: "hold",
            headline: overBilled && underDelivered
                ? `Hold — under delivered and over billed by $${overBilledAmount.toFixed(2)}`
                : underDelivered
                  ? "Hold — bill charges for goods that did not arrive"
                  : overBilled
                    ? `Hold — over billed by $${overBilledAmount.toFixed(2)}`
                    : `Hold — ${ambiguousLines.length} bill line${ambiguousLines.length === 1 ? "" : "s"} do not name a delivered item`,
            underDelivered,
            overBilled,
            matches: false,
            overBilledAmount,
            unbilledAmount,
            lines,
            reasons,
        };
    }

    return {
        disposition: unexplainedCharge > 0 ? "hold" : "review",
        headline:
            unexplainedCharge > 0
                ? `Hold — bill carries $${unexplainedCharge.toFixed(2)} we cannot account for`
                : "Review — see line detail",
        underDelivered: false,
        overBilled: false,
        matches: false,
        overBilledAmount,
        unbilledAmount,
        lines,
        reasons,
    };
}

/**
 * Build one comparison row.
 *
 * @param delivered The delivery line, or null when the bill names a SKU that
 *                  never arrived.
 * @param billed    The bill line, or null when the delivery was never billed.
 * @param fallbackSku SKU to display when there is no delivery line.
 */
function buildLine(
    delivered: DeliveredLine | null,
    billed: BilledLine | null,
    fallbackSku?: string,
    ambiguousLine?: boolean,
): DeliveryBillLine {
    const receivedQty = Number(delivered?.receivedQty ?? 0);
    const poUnitPrice = Number(delivered?.poUnitPrice ?? 0);
    const billedQty = Number(billed?.qty ?? 0);
    const billedUnitPrice = Number(billed?.unitPrice ?? 0);

    const receivedAmount = round2(receivedQty * poUnitPrice);
    const billedAmount = round2(
        billed?.extPrice != null && Number.isFinite(Number(billed.extPrice))
            ? Number(billed.extPrice)
            : billedQty * billedUnitPrice,
    );

    const sku = String(delivered?.sku || billed?.matchedSku || billed?.sku || fallbackSku || "?");
    // `ambiguous` is decided by the CALLER: it is true only when several
    // delivered items could equally be what the bill charges for (ULINE prints
    // `S-23343` for `S-23343BL-M` or `S-23343L-M`). A bill line with no
    // candidate at all is a genuine "never delivered" finding, not ambiguity.
    const ambiguous = ambiguousLine === true;

    return {
        sku,
        description: delivered?.description ?? billed?.description ?? null,
        receivedQty,
        billedQty,
        qtyDelta: round2(receivedQty - billedQty),
        poUnitPrice,
        billedUnitPrice,
        billedAmount,
        receivedAmount,
        amountDelta: round2(billedAmount - receivedAmount),
        notDelivered: !delivered && !ambiguous,
        notBilled: !billed,
        unmatchedBillLine: ambiguous,
    };
}
