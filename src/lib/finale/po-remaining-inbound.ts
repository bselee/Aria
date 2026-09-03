/**
 * @file    src/lib/finale/po-remaining-inbound.ts
 * @purpose Single source of truth for "how much of this PO line is genuinely
 *          still inbound?" — the fix for phantom on-order supply.
 *
 *          BACKGROUND (2026-08-21): Finale never transitions a purchase order
 *          away from `status: "Committed"` after receipt. Receipt state lives in
 *          `order.statusExtended` ("Committed · Fully received") and, definitively,
 *          on the line itself. Aria's `getProductActivity()` filtered on `status`
 *          and credited `quantity` (ORDERED), so fully-received POs kept counting
 *          as inbound supply forever.
 *
 *          Measured live: 80 phantom line-credits / 106,472 units across 19 SKUs;
 *          32 of 73 credited POs were "Committed · Fully received". Worst cases —
 *          S-4122 showed 1,004d runway (real 32d) and S-3902 showed 98d (real 43d),
 *          both sitting on `hold`. Phantom supply SUPPRESSES real purchases, so this
 *          bug causes stockouts, which is more expensive than the over-buy it looks like.
 *
 *          WHY NOT PO AGE: an age cutoff fails both ways. PO#125169 was fully
 *          received 15 days after ordering (phantom but young); PO#125215 is
 *          genuinely open with 50 units inbound at a similar age. `remaining` is
 *          the fact, age is only a proxy.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    none (pure — unit-testable without Finale)
 * @env     none
 */

/** Shape of the Finale `orderItem` fields this module reads. All may be "--"/null. */
export interface FinalePoLineReceiptFields {
    /** Legacy ordered quantity — what Aria used to credit (the bug). */
    quantity?: string | number | null;
    /** Units originally ordered on this line. */
    productUnitsOrdered?: string | number | null;
    /** Units actually received against this line. */
    productUnitsReceived?: string | number | null;
    /** Units still to be packed/shipped/received — the authoritative inbound figure. */
    productUnitsRemainingToBePackedShippedOrReceived?: string | number | null;
}

/**
 * Parse a Finale numeric field. Finale returns numbers as comma-formatted
 * strings and uses the literal `"--"` for "not tracked".
 *
 * @param val Raw Finale field value.
 * @returns   Parsed number, or null when absent/untracked/unparseable.
 */
export function parseFinaleQty(val: string | number | null | undefined): number | null {
    if (val === null || val === undefined || val === "") return null;
    if (typeof val === "number") return Number.isFinite(val) ? val : null;
    const trimmed = String(val).trim();
    if (trimmed === "" || trimmed === "--" || trimmed === "null") return null;
    const n = parseFloat(trimmed.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
}

/**
 * How many units of a PO line are genuinely still inbound.
 *
 * Resolution order:
 *  1. `productUnitsRemainingToBePackedShippedOrReceived` — Finale's own answer.
 *  2. `productUnitsOrdered − productUnitsReceived` — when remaining is untracked
 *     but both sides are known (floored at 0).
 *  3. `quantity` — last-resort fallback for Draft lines, where Finale reports
 *     `"--"` for every receipt field. A Draft PO has by definition received
 *     nothing, so the ordered quantity IS the outstanding quantity.
 *
 * @param line Finale `orderItem` node.
 * @returns    Units still expected to arrive; 0 when the line is settled.
 */
export function remainingInboundQty(line: FinalePoLineReceiptFields): number {
    const remaining = parseFinaleQty(line.productUnitsRemainingToBePackedShippedOrReceived);
    if (remaining !== null) return Math.max(0, remaining);

    const ordered = parseFinaleQty(line.productUnitsOrdered);
    const received = parseFinaleQty(line.productUnitsReceived);
    if (ordered !== null && received !== null) return Math.max(0, ordered - received);

    // Draft PO: every receipt field reads "--". Nothing can have been received yet.
    const qty = parseFinaleQty(line.quantity);
    if (qty !== null) return Math.max(0, qty);

    return 0;
}

/**
 * True when a PO's `statusExtended` says every line has been received.
 * Advisory only — line-level `remainingInboundQty` is the authority, since a
 * multi-line PO can be "Partially received" overall while THIS line is settled.
 *
 * @param statusExtended e.g. "Committed · Fully received".
 */
export function isFullyReceivedStatus(statusExtended: string | null | undefined): boolean {
    if (!statusExtended) return false;
    return /fully\s+received/i.test(statusExtended);
}
