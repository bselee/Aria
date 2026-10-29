/**
 * @file bag-families.ts
 * @purpose Derive printed-bag variant families from SKU naming and build the
 *          "variant check" summaries the ordering board shows whenever one
 *          variant is actionable — so a bag order never misses a sibling that
 *          will need ordering soon (Bill, 2026-10-28: "always check all
 *          variants of these bags to make sure nothing else is needed at
 *          time of order").
 * @author Hermia
 * @created 2026-10-28
 * @deps none (pure functions; no Finale/DB access)
 */

/** One member row inside a variant-family check. */
export interface BagFamilyMember {
    sku: string;
    name: string;
    urgency: 'critical' | 'warning' | 'watch' | 'ok' | string;
    /** Assessment decision: order / reduce / hold / manual_review. */
    decision: string;
    suggestedQty: number;
    runwayDays: number | null;
    /** Days until this member crosses the order window (lead + 30). Null when unknown. */
    triggerInDays: number | null;
    /** Triggers within the fold-in window while a sibling is being ordered. */
    foldInNow: boolean;
    /** Already covered by an open/draft PO — never a fold-in candidate. */
    covered: boolean;
}

/** A family-level check attached to a vendor group on the ordering board. */
export interface BagFamilyCheck {
    family: string;
    members: BagFamilyMember[];
}

/** Input shape the route maps from assessed items. */
export interface BagFamilyInput {
    productId: string;
    productName?: string | null;
    urgency?: string;
    decision?: string | null;
    suggestedQty?: number;
    runwayDays?: number | null;
    leadTimeDays?: number | null;
    covered?: boolean;
}

/** Window used by the assessment service: lead + 30d buffer. */
const ORDER_WINDOW_BUFFER_DAYS = 30;
/** A sibling that triggers within this many days rides the current order. */
export const FOLD_IN_WINDOW_DAYS = 30;

const BAG_SUFFIX_RE = /BAG(?:CP)?$/i;
/** Trailing size/unit tokens: digits with an optional short unit suffix (01, 100G, 1LB, 1KG). */
const SIZE_TOKEN_RE = /[0-9.]+[A-Z]{0,4}$/i;

/**
 * Curated families for stems that themselves contain digits, where the
 * size-token regex cannot separate family digits from size digits
 * ("BIG6100G" = family BIG6 + size 100G). Add here, don't bend the regex.
 */
const FAMILY_OVERRIDES: Record<string, string> = {
    BIG6100GBAG: 'BIG6',
    BIG6300GBAG: 'BIG6',
    BIG61KGBAG: 'BIG6',
};

/**
 * Derive the variant family key for a printed-bag SKU.
 *
 * Rules: only SKUs whose name ends in a bag suffix participate; the family is
 * the SKU stem with the trailing bag suffix and size token stripped. A stem
 * that is all digits/dots (e.g. "3.0BAGCP") keeps its full stem as the family.
 * Stems that contain digits ("BIG6100GBAG") resolve via FAMILY_OVERRIDES.
 *
 * Examples: GnarBar01BAG → GNARBAR · CWP02BAG → CWP · BBV101BAG → BBV ·
 * BIG6100GBAG → BIG6 · QUE215BAG → QUE · 3.0BAGCP → 3.0 · S-4128 → null.
 *
 * @param sku - The Finale productId.
 * @returns Uppercase family key, or null when the SKU is not a printed bag.
 */
export function deriveBagFamily(sku: string): string | null {
    const trimmed = (sku ?? '').trim();
    if (!trimmed || !BAG_SUFFIX_RE.test(trimmed)) return null;
    const overridden = FAMILY_OVERRIDES[trimmed];
    if (overridden) return overridden;
    const base = trimmed.replace(BAG_SUFFIX_RE, '');
    if (!base) return null;
    const stripped = base.replace(SIZE_TOKEN_RE, '').toUpperCase();
    if (!stripped || /^[0-9.]+$/.test(stripped)) return base.toUpperCase();
    return stripped;
}

/**
 * Build family checks for a vendor group's assessed items.
 *
 * A family is emitted only when it has 2+ bag-variant members AND at least one
 * member is actionable (decision order/reduce). Members are sorted by runway
 * ascending (shortest first). A member already covered by an open or draft PO
 * is never flagged foldInNow.
 *
 * @param items - Assessed items from the dashboard route.
 * @returns One check per actionable bag family, sorted by family key.
 */
export function buildBagFamilyChecks(items: BagFamilyInput[]): BagFamilyCheck[] {
    const byFamily = new Map<string, BagFamilyInput[]>();
    for (const it of items ?? []) {
        const fam = deriveBagFamily(it.productId);
        if (!fam) continue;
        const arr = byFamily.get(fam) ?? [];
        arr.push(it);
        byFamily.set(fam, arr);
    }

    const out: BagFamilyCheck[] = [];
    for (const [family, members] of byFamily) {
        if (members.length < 2) continue;
        const actionable = members.some(
            m => m.decision === 'order' || m.decision === 'reduce',
        );
        if (!actionable) continue;

        const rows: BagFamilyMember[] = members
            .map(m => {
                const runway = Number.isFinite(m.runwayDays) ? (m.runwayDays as number) : null;
                const lead = Number.isFinite(m.leadTimeDays) ? (m.leadTimeDays as number) : null;
                const orderWindow = lead != null ? lead + ORDER_WINDOW_BUFFER_DAYS : null;
                const triggerInDays =
                    runway != null && orderWindow != null ? Math.max(0, runway - orderWindow) : null;
                const needsOrder = m.decision === 'order' || m.decision === 'reduce';
                const covered = !!m.covered;
                const foldInNow =
                    !needsOrder && !covered && triggerInDays != null && triggerInDays <= FOLD_IN_WINDOW_DAYS;
                return {
                    sku: m.productId,
                    name: m.productName ?? '',
                    urgency: m.urgency ?? 'ok',
                    decision: m.decision ?? 'hold',
                    suggestedQty: m.suggestedQty ?? 0,
                    runwayDays: runway,
                    triggerInDays,
                    foldInNow,
                    covered,
                };
            })
            .sort((a, b) => (a.runwayDays ?? Infinity) - (b.runwayDays ?? Infinity));

        out.push({ family, members: rows });
    }
    return out.sort((a, b) => a.family.localeCompare(b.family));
}
