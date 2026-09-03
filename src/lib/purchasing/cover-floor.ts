/**
 * @file    src/lib/purchasing/cover-floor.ts
 * @purpose Pure 30/45d cover floor for small (non-freight) SKUs. Raises tiny
 *          recommender quantities to a sensible days-of-supply floor and
 *          consults purchase history (with corruption sanity caps) so a small
 *          reorder matches what the vendor actually ships.
 *
 *          Bill's rule (2026-08-24): "must at least purchase 30-45 days
 *          otherwise too much shipping and waste of vendor time." The ORDER
 *          itself must cover >= 30 days of supply (target 45, 60 is usually
 *          OK), and when the order is small, history decides. This module is
 *          the single enforcement point for non-freight SKUs. MTO/powder
 *          exclusions are the CALLER's job via targetCoverDaysOverride.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    none (pure module — no finale/db/network imports)
 * @env     none
 */

/** Minimum days of supply every small-SKU order must cover. */
export const MIN_COVER_DAYS = 30;

/** Days of supply the recommender should aim for (advisory, reported). */
export const TARGET_COVER_DAYS = 45;

/** Above this many days of supply, floor-induced overbuy is flagged. */
export const SMALL_MAX_COVER_DAYS = 60;

/** Corruption guard: a history/last-order floor more than this multiple of the
 *  raw need is treated as corrupt and rejected (e.g. a one-off 4,501,447-unit
 *  line, or a 10,000-unit promo). A real print run of 250 vs a 20-unit raw
 *  need (12.5x) passes; the corrupt 4.5M vs ~400 raw need (~11,000x) does not. */
export const MAX_HISTORY_FLOOR_RATIO = 1000;

export interface CoverFloorInput {
    sku: string;
    rawNeedQty: number;
    dailyRate: number;
    stockOnHand: number;
    stockOnOrder: number;
    skuPurchaseHistory?: number[] | null;
    lastPurchaseQty?: number | null;
    minimumOrderEaches?: number | null;
    unitPrice?: number | null;
    targetCoverDaysOverride?: number | null;
}

export interface CoverFloorResult {
    qty: number;
    floorQty: number;
    targetQty: number;
    historyFloor: number | null;
    lastOrderFloor: number | null;
    flags: string[];
    reason: string;
}

/**
 * Sanity-cap purchase history BEFORE any mode/consistency logic: drop
 * non-finite / non-positive entries, then iteratively drop entries more than
 * 100x the median of the remaining set. Kills corrupt rows like the
 * RAWRICEBRAN 4501447 quantity without touching the real pattern (order of the
 * surviving entries is preserved, so "last order" stays meaningful).
 */
function sanitizeHistory(history: number[]): number[] {
    let values = history.filter((v) => Number.isFinite(v) && v > 0);
    let changed = true;
    while (changed && values.length > 1) {
        changed = false;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median =
            sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        const cap = median * 100;
        const kept = values.filter((v) => v <= cap);
        if (kept.length !== values.length) {
            values = kept;
            changed = true;
        }
    }
    return values;
}

/**
 * Most frequent value. Ties break to the value closest to the history median,
 * then to the one most recently ordered.
 */
function modeOf(values: number[]): number {
    const counts = new Map<number, number>();
    const lastIndex = new Map<number, number>();
    values.forEach((v, i) => {
        counts.set(v, (counts.get(v) ?? 0) + 1);
        lastIndex.set(v, i);
    });
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    let best = values[0];
    let bestCount = -1;
    let bestDist = Infinity;
    let bestLast = -1;
    for (const [v, count] of counts) {
        const dist = Math.abs(v - median);
        const last = lastIndex.get(v) ?? -1;
        if (
            count > bestCount ||
            (count === bestCount && dist < bestDist) ||
            (count === bestCount && dist === bestDist && last > bestLast)
        ) {
            best = v;
            bestCount = count;
            bestDist = dist;
            bestLast = last;
        }
    }
    return best;
}

/**
 * "Consistent" history = same value or within 20%. Small histories (1-2
 * entries) qualify when every entry is within 20% of each other; 3+ entries
 * qualify when the mode dominates (>= 3 occurrences) or every entry sits
 * within 20% of the mode.
 */
function historyIsConsistent(cleaned: number[], mode: number): boolean {
    const min = Math.min(...cleaned);
    const max = Math.max(...cleaned);
    if (cleaned.length < 3) {
        return min > 0 && max <= min * 1.2;
    }
    const modeCount = cleaned.filter((v) => v === mode).length;
    return modeCount >= 3 || (max <= mode * 1.2 && min >= mode * 0.8);
}

/** A floor candidate is corrupt when it exceeds this multiple of the raw need. */
function isCorruptFloor(value: number, rawNeedQty: number): boolean {
    return rawNeedQty > 0 && value > MAX_HISTORY_FLOOR_RATIO * rawNeedQty;
}

interface ReasonArgs {
    rawNeedQty: number;
    qty: number;
    dailyRate: number;
    floorQty: number;
    historyFloor: number | null;
    lastOrderFloor: number | null;
    moq: number;
    flags: string[];
}

/**
 * Prose reason citing the numbers: what was raised and what drove it (history
 * mode / last order / supply floor / MOQ), plus the resulting days of supply.
 */
function buildReason(args: ReasonArgs): string {
    const { rawNeedQty, qty, dailyRate, floorQty, historyFloor, lastOrderFloor, moq, flags } = args;
    const rate = Math.round(dailyRate * 100) / 100;
    const supplyDays = Math.round((qty / dailyRate) * 10) / 10;

    const rawRounded = Math.ceil(rawNeedQty);
    const floorRounded = Math.ceil(floorQty);
    const histRounded = historyFloor == null ? null : Math.ceil(historyFloor);
    const lastRounded = lastOrderFloor == null ? null : Math.ceil(lastOrderFloor);
    const moqRounded = Math.ceil(moq);

    const driver: "raw" | "floor" | "history" | "last_order" | "moq" =
        qty === lastRounded && lastRounded != null && lastRounded >= Math.max(rawRounded, floorRounded, histRounded ?? 0, moqRounded)
            ? "last_order"
            : histRounded != null && qty === histRounded && histRounded >= Math.max(rawRounded, floorRounded, moqRounded)
              ? "history"
              : qty === moqRounded && moqRounded > 0 && moqRounded >= Math.max(rawRounded, floorRounded, histRounded ?? 0)
                ? "moq"
                : qty === floorRounded && floorRounded > rawRounded
                  ? "floor"
                  : "raw";

    const bits: string[] = [];
    if (driver === "raw") {
        bits.push(`need ${rawNeedQty} kept`);
    } else {
        bits.push(`raised ${rawNeedQty} to ${qty}`);
        if (driver === "last_order") {
            bits.push(`last order was ${lastOrderFloor} units (${Math.round(((lastOrderFloor! - rawNeedQty) / lastOrderFloor!) * 100)}% below)`);
        } else if (driver === "history") {
            bits.push(`purchase history consistently ${historyFloor}`);
        } else if (driver === "moq") {
            bits.push(`minimum order ${moq} units`);
        } else {
            bits.push(`30d order-supply floor`);
        }
    }
    bits.push(`${qty} = ${supplyDays}d of supply at ${rate}/day`);
    if (flags.includes("history_over_60d")) {
        bits.push(`history floor pushes cover past ${SMALL_MAX_COVER_DAYS}d`);
    }
    if (flags.includes("moq_forced_overbuy")) {
        bits.push(`MOQ pushes cover past ${SMALL_MAX_COVER_DAYS}d`);
    }
    if (flags.includes("history_floor_rejected")) {
        bits.push(`history floor rejected as corrupt (>${MAX_HISTORY_FLOOR_RATIO}x need)`);
    }
    return bits.join("; ");
}

/**
 * Apply the 30/45d cover floor to one ordering line.
 *
 * @param input Line inputs: raw need, velocity, stock, purchase history, MOQ.
 * @returns The floored quantity plus diagnostics (floorQty, targetQty,
 *          historyFloor, lastOrderFloor, flags, prose reason).
 */
export function applyCoverFloor(input: CoverFloorInput): CoverFloorResult {
    const {
        rawNeedQty,
        dailyRate,
        stockOnHand,
        stockOnOrder,
        skuPurchaseHistory,
        lastPurchaseQty,
        minimumOrderEaches,
        targetCoverDaysOverride,
    } = input;
    const moq = minimumOrderEaches ?? 0;

    // Rule 0 — a floor must never CREATE an order. Held lines (rawNeedQty <= 0)
    // pass through as zero: floors must not force a purchase the core math
    // said is unnecessary.
    if (!(rawNeedQty > 0)) {
        return {
            qty: 0,
            floorQty: 0,
            targetQty: 0,
            historyFloor: null,
            lastOrderFloor: null,
            flags: [],
            reason: "no need - floor skipped",
        };
    }

    // Rule 1 — MTO/powder exclusions are the caller's job via the override.
    if (targetCoverDaysOverride != null) {
        return {
            qty: rawNeedQty,
            floorQty: 0,
            targetQty: 0,
            historyFloor: null,
            lastOrderFloor: null,
            flags: [],
            reason: "vendor target cover override present - floor skipped",
        };
    }

    // Rule 2 — no usable velocity, nothing to floor against.
    if (!(dailyRate > 0)) {
        return {
            qty: rawNeedQty,
            floorQty: 0,
            targetQty: 0,
            historyFloor: null,
            lastOrderFloor: null,
            flags: [],
            reason: "no usable daily rate - floor skipped",
        };
    }

    // Rule 3 — the ORDER must cover >= MIN_COVER_DAYS of supply. Bill: "must at
    // least purchase 30-45 days otherwise too much shipping and waste of
    // vendor time." This is a floor on the order size, independent of existing
    // runway (a SKU inside the order window still buys a meaningful amount).
    const floorQty = Math.ceil(MIN_COVER_DAYS * dailyRate);
    const targetQty = Math.ceil(TARGET_COVER_DAYS * dailyRate);

    // Rule 4 — history floor: sanity-cap first, then mode of the consistent set.
    let historyFloor: number | null = null;
    let flagsHistoryRejected = false;
    if (skuPurchaseHistory != null && skuPurchaseHistory.length > 0) {
        const cleaned = sanitizeHistory(skuPurchaseHistory);
        if (cleaned.length > 0) {
            const mode = modeOf(cleaned);
            if (historyIsConsistent(cleaned, mode)) {
                if (isCorruptFloor(mode, rawNeedQty)) {
                    flagsHistoryRejected = true;
                } else {
                    historyFloor = mode;
                }
            }
        }
    }

    // Rule 4b — last-order floor. When the recommended order is >= 50% below
    // the most recent actual purchase (Bill: "when a small order, look at
    // history and decide"), floor to that last order. Catches the inconsistent
    // multi-entry case (THC101 [50,30,20,25,45,30] -> mode is noisy but the
    // last order was a clean 50) that the mode path intentionally rejects.
    let lastOrderFloor: number | null = null;
    if (lastPurchaseQty != null && lastPurchaseQty > 0 && !isCorruptFloor(lastPurchaseQty, rawNeedQty)) {
        const base = Math.max(rawNeedQty, floorQty, historyFloor ?? 0, moq);
        if (lastPurchaseQty > base && (lastPurchaseQty - base) / lastPurchaseQty >= 0.5) {
            lastOrderFloor = lastPurchaseQty;
        }
    }

    // Rule 5 — final qty: max of raw need, supply floor, history floor,
    // last-order floor, MOQ; round up.
    const qty = Math.ceil(Math.max(rawNeedQty, floorQty, historyFloor ?? 0, lastOrderFloor ?? 0, moq));

    // Rule 6 — over-60d cover is flagged when a FLOOR caused the overage.
    const flags: string[] = [];
    const postReceiptCoverDays = (stockOnHand + stockOnOrder + qty) / dailyRate;
    if (postReceiptCoverDays > SMALL_MAX_COVER_DAYS) {
        const drivenByHistory =
            (historyFloor != null && historyFloor === qty) || (lastOrderFloor != null && lastOrderFloor === qty);
        const qtyWithoutHistory = Math.ceil(Math.max(rawNeedQty, floorQty, moq));
        const overWithoutHistory =
            (stockOnHand + stockOnOrder + qtyWithoutHistory) / dailyRate > SMALL_MAX_COVER_DAYS;
        const qtyWithoutMoq = Math.ceil(Math.max(rawNeedQty, floorQty, historyFloor ?? 0, lastOrderFloor ?? 0));
        const overWithoutMoq =
            (stockOnHand + stockOnOrder + qtyWithoutMoq) / dailyRate > SMALL_MAX_COVER_DAYS;
        if (drivenByHistory && !overWithoutHistory) {
            flags.push("history_over_60d");
        } else if (moq > 0 && !overWithoutMoq) {
            flags.push("moq_forced_overbuy");
        }
    }
    if (flagsHistoryRejected) {
        flags.push("history_floor_rejected");
    }

    // Rule 7 — prose reason citing the numbers.
    const reason = buildReason({
        rawNeedQty,
        qty,
        dailyRate,
        floorQty,
        historyFloor,
        lastOrderFloor,
        moq,
        flags,
    });

    return { qty, floorQty, targetQty, historyFloor, lastOrderFloor, flags, reason };
}
