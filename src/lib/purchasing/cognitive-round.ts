// src/lib/purchasing/cognitive-round.ts
/**
 * @file    cognitive-round.ts
 * @purpose Snap recommended PO quantities to clean numbers so Will never sees
 *          591 or 817 on a draft. Three layers: cognitive ladder (magnitude-
 *          aware floor), historical favorites (cluster detected from past PO
 *          line qtys), and explicit per-vendor override.
 *
 *          Pure function — no I/O. Composed by qty-recommender after pack
 *          rounding and before MOQ enforcement.
 *
 *          Spec: .agents/plans/2026-05-06-cognitive-rounding-design.md
 */

export interface CognitiveRoundInput {
    rawQty: number;
    packIncrement?: number | null;
    historicalQtys?: number[];
    explicitFavorites?: number[] | null;
}

export interface CognitiveRoundResult {
    snappedQty: number;
    delta: number;
    method: "cognitive" | "historical" | "vendor_explicit" | "noop";
    detail: string;
    alternatives: number[];
}

/**
 * Magnitude-aware cognitive ladder. Returns the step size for the tier
 * containing `qty`. Higher tiers use coarser steps so 591 snaps to 600 (step 50)
 * but 5,591 snaps to 5,500 (step 500) — the absolute snap distance scales
 * roughly with magnitude so the result reads cleanly at every order of magnitude.
 */
function ladderStepFor(qty: number): number {
    if (qty < 30) return 5;
    if (qty < 100) return 10;
    if (qty < 250) return 25;
    if (qty < 750) return 50;
    if (qty < 2500) return 100;
    if (qty < 10_000) return 500;
    return 1_000;
}

/**
 * Snap to the nearest multiple of `step`, with equidistant rounding up
 * (Will's "usually up" preference).
 */
function snapToLadder(qty: number, step: number): number {
    if (qty <= 0) return 0;
    const lower = Math.floor(qty / step) * step;
    const upper = lower + step;
    // Smallest tier (qty <30) always rounds up — at this magnitude every unit
    // matters and we never want to under-buy a near-empty SKU. Higher tiers
    // use nearest-with-equidistant-up.
    if (qty < 30) return qty === lower ? lower : upper;
    const dLower = qty - lower;
    const dUpper = upper - qty;
    return dUpper <= dLower ? upper : lower;
}

/**
 * Snap to the nearest favorite in `favorites`. Equidistant prefers higher.
 * Returns null when raw is grossly out of range (>10× max favorite, or
 * <0.1× min favorite) — caller falls back to the cognitive ladder.
 */
function snapToFavorites(qty: number, favorites: number[]): number | null {
    if (favorites.length === 0) return null;
    const sorted = [...favorites].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (qty < min * 0.1 || qty > max * 10) return null;

    let best = sorted[0];
    let bestDelta = Math.abs(qty - best);
    for (const f of sorted) {
        const delta = Math.abs(qty - f);
        if (delta < bestDelta || (delta === bestDelta && f > best)) {
            best = f;
            bestDelta = delta;
        }
    }
    return best;
}

/**
 * Detect cluster favorites in `historical` — values that appear ≥2 times.
 * Returns sorted ascending. Empty when no clustering exists.
 */
function detectFavorites(historical: number[]): number[] {
    if (!historical || historical.length === 0) return [];
    const counts = new Map<number, number>();
    for (const v of historical) {
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count >= 2)
        .map(([v]) => v)
        .sort((a, b) => a - b);
}

/**
 * After picking a snap target, ensure it's a multiple of packIncrement.
 * If it isn't, round up to the nearest pack-multiple at-or-above the snap
 * (we never round below an explicit snap target — that would defeat the
 * point of the snap). If pack alone is already clean (e.g. pack=60), the
 * snap target is the pack-aligned value.
 */
function honorPack(snapTarget: number, packIncrement: number | null | undefined): number {
    if (!packIncrement || packIncrement <= 1) return snapTarget;
    if (snapTarget % packIncrement === 0) return snapTarget;
    // Find pack-multiples adjacent to the snap target; pick the nearest.
    const lower = Math.floor(snapTarget / packIncrement) * packIncrement;
    const upper = lower + packIncrement;
    const dLower = snapTarget - lower;
    const dUpper = upper - snapTarget;
    return dUpper <= dLower ? upper : lower;
}

export function roundToCleanQty(input: CognitiveRoundInput): CognitiveRoundResult {
    const raw = Math.max(0, Math.floor(input.rawQty || 0));

    // Edge: zero or negative → no work.
    if (raw <= 0) {
        return {
            snappedQty: 0,
            delta: 0,
            method: "noop",
            detail: "No order needed.",
            alternatives: [],
        };
    }

    // Edge: tiny qty (<5) → smallest cognitive tier.
    if (raw < 5) {
        const result = honorPack(5, input.packIncrement);
        return {
            snappedQty: result,
            delta: result - raw,
            method: "cognitive",
            detail: `Bumped tiny qty ${raw} to smallest clean tier (5)${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
            alternatives: [],
        };
    }

    // ─── Layer 3 — explicit override ────────────────────────────────────
    const explicit = (input.explicitFavorites && input.explicitFavorites.length > 0)
        ? input.explicitFavorites
        : null;
    if (explicit) {
        const snap = snapToFavorites(raw, explicit);
        if (snap != null) {
            const result = honorPack(snap, input.packIncrement);
            const sorted = [...explicit].sort((a, b) => a - b);
            const idx = sorted.indexOf(snap);
            const alternatives = [
                idx > 0 ? sorted[idx - 1] : null,
                idx < sorted.length - 1 ? sorted[idx + 1] : null,
            ].filter((x): x is number => x != null);
            return {
                snappedQty: result,
                delta: result - raw,
                method: "vendor_explicit",
                detail: `Snapped ${raw} to ${result} (vendor policy favorite_batches=[${sorted.join(", ")}])${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
                alternatives,
            };
        }
        // Out of range — fall through to historical/cognitive.
    }

    // ─── Layer 2 — historical favorites (cluster ≥2×) ───────────────────
    const learned = detectFavorites(input.historicalQtys ?? []);
    if (learned.length > 0) {
        const snap = snapToFavorites(raw, learned);
        if (snap != null) {
            const result = honorPack(snap, input.packIncrement);
            const idx = learned.indexOf(snap);
            const alternatives = [
                idx > 0 ? learned[idx - 1] : null,
                idx < learned.length - 1 ? learned[idx + 1] : null,
            ].filter((x): x is number => x != null);
            const occurrences = (input.historicalQtys ?? []).filter(v => v === snap).length;
            return {
                snappedQty: result,
                delta: result - raw,
                method: "historical",
                detail: `Snapped ${raw} to ${result} (matches ${occurrences} of last ${input.historicalQtys?.length ?? 0} POs at ${snap}; nearest of [${learned.join(", ")}])${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
                alternatives,
            };
        }
        // Out of range — fall through to cognitive.
    }

    // ─── Layer 1 — cognitive ladder (always-on floor) ───────────────────
    const step = ladderStepFor(raw);
    const snap = snapToLadder(raw, step);
    const result = honorPack(snap, input.packIncrement);
    // Two alternatives: the next tier-step below and above the snap (or the rounded raw if below).
    const alts: number[] = [];
    if (snap - step > 0) alts.push(snap - step);
    alts.push(snap + step);
    return {
        snappedQty: result,
        delta: result - raw,
        method: "cognitive",
        detail: `Snapped ${raw} to ${result} (nearest ${step}; tier ${
            raw < 30 ? "<30" : raw < 100 ? "30-99" : raw < 250 ? "100-249"
            : raw < 750 ? "250-749" : raw < 2500 ? "750-2499"
            : raw < 10000 ? "2500-9999" : "≥10000"
        })${input.packIncrement && input.packIncrement > 1 ? `, pack ${input.packIncrement}` : ""}.`,
        alternatives: alts,
    };
}
