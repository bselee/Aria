/**
 * @file    src/lib/purchasing/overbill-grace.ts
 * @purpose Same-day grace for the overbill flag. A bill lands at 10am and
 *          the warehouse enters the receipt at 2pm — a mid-day flag that
 *          clears by evening is noise. The hard flag waits until the
 *          delivery day has settled; the row shows the soft comparison
 *          in the meantime.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    none
 */

/** True when the timestamp falls on the same Denver calendar day as `now`. */
export function isSameDenverDay(isoLike: string | null | undefined, now: Date = new Date()): boolean {
    if (!isoLike) return false;
    const d = new Date(isoLike);
    if (Number.isNaN(d.getTime())) return false;
    return (
        d.toLocaleDateString("en-CA", { timeZone: "America/Denver" }) ===
        now.toLocaleDateString("en-CA", { timeZone: "America/Denver" })
    );
}

/**
 * True when the overbill must be held back from the hard flag: the receipt
 * is stamped today, so the delivery day has not settled yet.
 */
export function overbillGracePending(
    receiveDateTime: string | null | undefined,
    now: Date = new Date(),
): boolean {
    return isSameDenverDay(receiveDateTime, now);
}
