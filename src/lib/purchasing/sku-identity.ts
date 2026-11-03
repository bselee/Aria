/**
 * @file    src/lib/purchasing/sku-identity.ts
 * @purpose ONE rule for deciding when two SKUs name the same product.
 *
 * Vendors mangle part numbers in predictable ways and every matching surface
 * used to handle that differently — or not at all. ULINE's OCR glues the case
 * count onto the SKU (`S-4738` → `S-473824`, `S-1667` → `S-166712`) and drops
 * variant suffixes (`S-23343BL-M` → `S-23343`). Two separate matchers therefore
 * accused correct bills of overbilling $2,430 and $2,420 while a third read the
 * same rows as clean.
 *
 * This module is the single source of truth for that question. It is
 * deliberately conservative: it only says two SKUs are *plausibly* the same
 * product family. Callers must still require supporting evidence (matching
 * quantity or unit price, and a unique candidate) before treating them as
 * identical. `sameProductFamily` never decides identity on its own.
 *
 * DECISION(2026-11-03, Bill): "Were we over billed? Under delivered?" must give
 * the same answer wherever it is asked, so there is one rule, in one place.
 *
 * @author  Hermia
 * @created 2026-11-03
 * @deps    none (pure)
 */

/**
 * The stable stem of a SKU: everything before a trailing all-digit run.
 *
 * ULINE glues the case count onto the part number, so `S-4738` appears as
 * `S-473824`. The stem strips that debris.
 *
 * @param sku Raw SKU from any document.
 */
export function skuStem(sku: string): string {
    return String(sku || "")
        .trim()
        .toUpperCase()
        .replace(/\d+$/, "");
}

/**
 * Do two SKUs plausibly name the same product family?
 *
 * True when the SKUs are equal, share an identical non-trivial stem, or one is
 * a prefix of the other (covers both an appended pack count and a truncated
 * variant suffix).
 *
 * This is a CANDIDATE test only. It must be paired with a quantity or price
 * check, and the caller must require the candidate to be unique, before the
 * lines are treated as the same product.
 *
 * @param a One SKU.
 * @param b The other SKU.
 */
export function sameProductFamily(a: string, b: string): boolean {
    const A = String(a || "").trim().toUpperCase();
    const B = String(b || "").trim().toUpperCase();
    if (!A || !B) return false;
    if (A === B) return true;

    // Letter stems must be long enough to be meaningful — "S-" matches nothing.
    const stemA = skuStem(A);
    const stemB = skuStem(B);
    if (stemA.length >= 5 && stemB.length >= 5 && stemA === stemB) return true;

    // Prefix in either direction: debris appended, or suffix dropped.
    if (A.startsWith(B) && B.length >= 5) return true;
    if (B.startsWith(A) && A.length >= 5) return true;

    return false;
}

/**
 * Find the single delivered SKU that a mangled bill SKU most likely names.
 *
 * Returns the match only when exactly one unclaimed candidate is plausible AND
 * its unit price agrees with the bill. Ambiguity returns null on purpose: when
 * two items fit equally well the bill cannot say which one it means, and the
 * honest answer is "we cannot tell", not a guess.
 *
 * @param billSku    SKU as printed on the bill.
 * @param billPrice  Billed unit price.
 * @param delivered  Delivered lines to search (caller excludes claimed ones).
 * @param priceToleranceFn Tolerance for unit-price agreement.
 */
export function resolveMangledSku<T extends { sku: string; poUnitPrice: number }>(
    billSku: string,
    billPrice: number,
    delivered: T[],
    priceToleranceFn: (poUnitPrice: number) => number,
): T | null {
    const candidates = delivered.filter((d) => sameProductFamily(billSku, d.sku));
    if (candidates.length === 0) return null;

    const proven = candidates.filter(
        (d) => Math.abs(d.poUnitPrice - billPrice) <= priceToleranceFn(d.poUnitPrice),
    );
    if (candidates.length === 1 && proven.length === 1) return proven[0];
    return null;
}
