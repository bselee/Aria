/**
 * @file    src/lib/purchasing/cover-floor.ts
 * @purpose Pure 30/45d cover floor for small SKUs. Raises tiny recommender
 *          quantities to a sensible days-of-supply floor and consults purchase
 *          history (with corruption sanity caps) so a small reorder matches what
 *          the vendor actually ships. MTO/powder exclusions are the CALLER's job
 *          via targetCoverDaysOverride — this module never imports policy.
 *
 *          Gap semantics (R1): the floor raises POST-RECEIPT cover to the
 *          minimum. It never adds a flat 30d on top of existing stock, so a
 *          line with 40d of existing cover gets ~0 from the floor.
 *
 * @author  Hermia
 * @created 2026-08-24
 * @deps    none (pure module — no finale/db/network imports)
 * @env     none
 */

/** Minimum days of supply the floor guarantees post-receipt. */
export const MIN_COVER_DAYS = 30;

/** Days of supply the recommender should aim for (targetQty reporting only). */
export const TARGET_COVER_DAYS = 45;

/** Above this many days of post-receipt cover, floor-induced overbuy is flagged. */
export const SMALL_MAX_COVER_DAYS = 60;

/** Single-entry histories are trusted but capped at this many days of supply —
 *  a one-off promo order must not become a permanent floor for a slow SKU. */
export const SINGLE_ENTRY_HISTORY_MAX_COVER_DAYS = 90;

export interface CoverFloorInput {
    sku: string;
    rawNeedQty: number;
    dailyRate: number;
    stockOnHand: number;
    stockOnOrder: number;
    skuPurchaseHistory?: number[] | null;
    minimumOrderEaches?: number | null;
    unitPrice?: number | null;
    targetCoverDaysOverride?: number | null;
}

export interface CoverFloorResult {
    qty: number;
    floorQty: number;
    targetQty: number;
    historyFloor: number | null;
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
 * Most frequent value. Ties break to the value closest to the history median
 * ("most recent median"), then to the one most recently ordered.
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

interface ReasonArgs {
    rawNeedQty: number;
    qty: number;
    dailyRate: number;
    existingCoverDays: number;
    floorQty: number;
    historyFloor: number | null;
    lastOrder: number | null;
    moq: number;
    flags: string[];
}

/**
 * Prose reason citing the numbers: what was raised, what drove it (history
 * mode / MOQ / gap floor), and the resulting days of supply, e.g.
 * "raised 5 to 50: purchase history consistently 50 (last order 50); 50 = 72.5d
 * of supply at 0.69/day".
 */
function buildReason(args: ReasonArgs): string {
    const { rawNeedQty, qty, dailyRate, existingCoverDays, floorQty, historyFloor, lastOrder, moq, flags } = args;
    const rate = Math.round(dailyRate * 100) / 100;
    const supplyDays = Math.round((qty / dailyRate) * 10) / 10;
    const existingDays = Math.round(existingCoverDays * 10) / 10;

    const rawRounded = Math.ceil(rawNeedQty);
    const floorRounded = Math.ceil(floorQty);
    const histRounded = historyFloor == null ? null : Math.ceil(historyFloor);
    const moqRounded = Math.ceil(moq);

    const driver: "raw" | "floor" | "history" | "moq" =
        histRounded != null &&
        qty === histRounded &&
        histRounded >= rawRounded &&
        histRounded >= floorRounded &&
        histRounded >= moqRounded
            ? "history"
            : qty === moqRounded &&
                moqRounded > 0 &&
                moqRounded >= rawRounded &&
                moqRounded >= floorRounded &&
                moqRounded >= (histRounded ?? 0)
              ? "moq"
              : qty === floorRounded &&
                  floorRounded > rawRounded &&
                  floorRounded >= moqRounded &&
                  floorRounded >= (histRounded ?? 0)
                ? "floor"
                : "raw";

    const bits: string[] = [];
    if (driver === "raw") {
        bits.push(`need ${rawNeedQty} kept (${existingDays}d existing cover)`);
    } else {
        bits.push(`raised ${rawNeedQty} to ${qty}`);
        if (driver === "history") {
            bits.push(`purchase history consistently ${historyFloor} (last order ${lastOrder ?? historyFloor})`);
        } else if (driver === "moq") {
            bits.push(`minimum order ${moq} units`);
        } else {
            bits.push(`30d cover gap floor (existing ${existingDays}d)`);
        }
    }
    bits.push(`${qty} = ${supplyDays}d of supply at ${rate}/day`);
    if (flags.includes("history_over_60d")) {
        bits.push(`history floor pushes cover past ${SMALL_MAX_COVER_DAYS}d`);
    }
    if (flags.includes("moq_forced_overbuy")) {
        bits.push(`MOQ pushes cover past ${SMALL_MAX_COVER_DAYS}d`);
    }
    if (flags.includes("single_entry_history_capped")) {
        bits.push(`lone history entry capped at ${SINGLE_ENTRY_HISTORY_MAX_COVER_DAYS}d of supply`);
    }
    return bits.join("; ");
}

/**
 * Apply the 30/45d cover floor to one ordering line.
 *
 * @param input Line inputs: raw need, velocity, stock, purchase history, MOQ.
 * @returns The floored quantity plus diagnostics (floorQty, targetQty,
 *          historyFloor, flags, prose reason).
 */
export function applyCoverFloor(input: CoverFloorInput): CoverFloorResult {
    const {
        rawNeedQty,
        dailyRate,
        stockOnHand,
        stockOnOrder,
        skuPurchaseHistory,
        minimumOrderEaches,
        targetCoverDaysOverride,
    } = input;
    const moq = minimumOrderEaches ?? 0;

    // Rule 0 — a floor must never CREATE an order. Held lines (rawNeedQty <= 0)
    // pass through as zero: MOQ/history floors must not force a purchase the
    // core math said is unnecessary.
    if (!(rawNeedQty > 0)) {
        return {
            qty: 0,
            floorQty: 0,
            targetQty: 0,
            historyFloor: null,
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
            flags: [],
            reason: "no usable daily rate - floor skipped",
        };
    }

    // Rule 3 — gap semantics (R1): raise POST-RECEIPT cover to the minimum.
    const existingCoverDays = (stockOnHand + stockOnOrder) / dailyRate;
    const floorQty = Math.max(0, MIN_COVER_DAYS - existingCoverDays) * dailyRate;
    const targetQty = Math.max(0, TARGET_COVER_DAYS - existingCoverDays) * dailyRate;

    // Rule 4 — history floor: sanity-cap first, then mode of the consistent set.
    let historyFloor: number | null = null;
    let lastOrder: number | null = null;
    let flagsSingleEntryCapped = false;
    if (skuPurchaseHistory != null && skuPurchaseHistory.length > 0) {
        const cleaned = sanitizeHistory(skuPurchaseHistory);
        if (cleaned.length > 0) {
            const mode = modeOf(cleaned);
            if (historyIsConsistent(cleaned, mode)) {
                historyFloor = mode;
                // Single-entry guard: a lone record (e.g. a one-off 10,000-unit
                // promo) must not become a permanent floor. Cap at 90 days of
                // supply; still generous (Bill: "even 60 days is usually OK").
                if (cleaned.length === 1) {
                    const capQty = Math.max(1, Math.ceil(SINGLE_ENTRY_HISTORY_MAX_COVER_DAYS * dailyRate));
                    if (historyFloor > capQty) {
                        historyFloor = capQty;
                        flagsSingleEntryCapped = true;
                    }
                }
            }
            lastOrder = cleaned[cleaned.length - 1];
        }
    }

    // Rule 5 — final qty: max of raw need, gap floor, history floor, MOQ; round up.
    const qty = Math.ceil(Math.max(rawNeedQty, floorQty, historyFloor ?? 0, moq));

    // Rule 6 — over-60d cover is only flagged when a FLOOR caused the overage
    // (a raw need that already exceeds 60d is the recommender's business).
    const flags: string[] = [];
    const postReceiptCoverDays = (stockOnHand + stockOnOrder + qty) / dailyRate;
    if (postReceiptCoverDays > SMALL_MAX_COVER_DAYS) {
        const qtyWithoutHistory = Math.ceil(Math.max(rawNeedQty, floorQty, moq));
        const overWithoutHistory =
            (stockOnHand + stockOnOrder + qtyWithoutHistory) / dailyRate > SMALL_MAX_COVER_DAYS;
        const qtyWithoutMoq = Math.ceil(Math.max(rawNeedQty, floorQty, historyFloor ?? 0));
        const overWithoutMoq =
            (stockOnHand + stockOnOrder + qtyWithoutMoq) / dailyRate > SMALL_MAX_COVER_DAYS;
        if (historyFloor != null && !overWithoutHistory) {
            flags.push("history_over_60d");
        } else if (moq > 0 && !overWithoutMoq) {
            flags.push("moq_forced_overbuy");
        }
    }
    if (flagsSingleEntryCapped) {
        flags.push("single_entry_history_capped");
    }

    // Rule 7 — prose reason citing the numbers.
    const reason = buildReason({
        rawNeedQty,
        qty,
        dailyRate,
        existingCoverDays,
        floorQty,
        historyFloor,
        lastOrder,
        moq,
        flags,
    });

    return { qty, floorQty, targetQty, historyFloor, flags, reason };
}
