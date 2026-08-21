/**
 * @file    src/lib/purchasing/basauto-recon.ts
 * @purpose Deterministic reconciliation of basauto.vercel.app purchasing
 *          recommendations against Aria's purchasing pipeline reality.
 *
 *          basauto measures 90-day NET stock depletion (receipts − builds −
 *          takes) and cannot see committed purchase orders. Aria measures
 *          Finale demand (demandQuantity/90), FG-traceback coverage, and
 *          subtracts committed POs. The two therefore disagree on velocity,
 *          urgency, and quantity — this module classifies WHY, per SKU, so
 *          Bill never has to open basauto himself.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    none (pure functions — unit-testable without Finale/network)
 * @env     none
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Normalized per-product record from basauto /api/orders/getPurchaseOrders. */
export interface BasautoRecord {
    productId: string;
    description: string | null;
    supplier: string | null;
    /** OK | Urgent | Overdue | Soon (or PURCHASE from the DOM-scrape fallback). */
    urgency: string;
    unitsInStock: number | null;
    stockDaysLeft: number | null;
    reorderQty: number | null;
    reorderDate: string | null;
    onOrder: number | null;
    quantityInDrafts: number | null;
    supplierLeadDays: number | null;
    velocity: number | null;
    lastReceived: string | null;
    /** Net 90-day stock change from Finale's transaction ledger (negative = depletion). */
    quantity: number | null;
    averageBuildConsumption: number | null;
    /** True when synthesized from the slim `overduePurchases` section. */
    slim?: boolean;
}

/** Condensed Aria purchasing item — only what reconciliation needs. */
export interface AriaOpenPO {
    orderId: string;
    quantity: number;
    orderDate?: string | null;
}

export interface AriaItemLite {
    productId: string;
    urgency: string | null;
    stockOnHand: number | null;
    stockOnOrder: number | null;
    dailyRate: number | null;
    dailyRateSource: string | null;
    leadTimeDays: number | null;
    effectiveLeadTimeDays: number | null;
    adjustedRunwayDays: number | null;
    runwayDays: number | null;
    openPOs: AriaOpenPO[];
    suggestedQty: number | null;
    assessmentDecision: string | null;
    assessmentRecommendedQty: number | null;
    supplierName: string | null;
}

export type Verdict =
    | "OVERBUY_RISK"        // basauto urgent, but Aria counts a committed PO it can't see
    | "VELOCITY_MISMATCH"   // basauto velocity vs Aria dailyRate differ >2× (depletion vs demand)
    | "FALSE_URGENT"        // basauto urgent/overdue, Aria runway comfortably past order point
    | "BORDERLINE"          // basauto urgent, Aria runway near the order point — review manually
    | "MISSING_IN_ARIA"     // basauto flags it; Aria pipeline has no record (candidate gate / job supply)
    | "QTY_MISMATCH"        // both flag it, but recommended quantities differ >50%
    | "AGREE"               // both flag it and quantities roughly agree
    | "ARIA_ONLY"           // Aria flags it, basauto says OK (BOM/FG demand basauto misses);

export type Severity = "high" | "medium" | "low";

export interface ReconItem {
    sku: string;
    vendor: string | null;
    description: string | null;
    verdict: Verdict;
    severity: Severity;
    reason: string;
    basauto: {
        urgency: string;
        stockDaysLeft: number | null;
        reorderQty: number | null;
        reorderDate: string | null;
        velocity: number | null;
        onOrder: number | null;
        quantityInDrafts: number | null;
        supplierLeadDays: number | null;
        lastReceived: string | null;
    };
    aria: {
        urgency: string | null;
        runwayDays: number | null;
        dailyRate: number | null;
        stockOnHand: number | null;
        stockOnOrder: number | null;
        poQty: number;
        pos: AriaOpenPO[];
        suggestedQty: number | null;
        leadTimeDays: number | null;
    } | null;
}

export interface ReconSummary {
    flagged: number;
    high: number;
    medium: number;
    low: number;
    byVerdict: Record<Verdict, number>;
    basautoItems: number;
    basautoNonOK: number;
    ariaItems: number;
    ariaNonOK: number;
}

export interface ReconReport {
    crawledAt: string;
    source: "api" | "playwright";
    ariaCachedAt: string | null;
    errors: string[];
    summary: ReconSummary;
    items: ReconItem[];
}

// ── Constants ───────────────────────────────────────────────────────────────

export const BASAUTO_NON_OK = new Set(["URGENT", "OVERDUE", "SOON", "PURCHASE"]);
export const ARIA_NON_OK = new Set(["critical", "warning"]);

/** Velocity gap threshold — above this the two systems measure different things. */
export const VELOCITY_GAP_RATIO = 2;
/** Qty disagreement threshold — above this the two recommendations are different answers. */
export const QTY_GAP_RATIO = 0.5;
/** Runway safety multiple of lead time — below this the disagreement is borderline, not false. */
export const RUNWAY_LEAD_MULTIPLE = 2;
export const DEFAULT_LEAD_TIME_DAYS = 21;
export const NEED_WINDOW_DAYS = 30;

// ── Normalizers ─────────────────────────────────────────────────────────────

export function normalizeSku(sku: string | null | undefined): string {
    return (sku ?? "").trim().toUpperCase();
}

export function toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

export function fmtQty(n: number | null | undefined): string {
    if (n === null || n === undefined) return "?";
    const v = Math.round(n * 100) / 100;
    return v.toLocaleString("en-US");
}

export function fmtRate(n: number | null | undefined): string {
    if (n === null || n === undefined) return "?";
    const v = Math.round(n * 100) / 100;
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function fmtDays(n: number | null | undefined): string {
    if (n === null || n === undefined) return "?";
    return String(Math.round(n));
}

// ── Assessment ──────────────────────────────────────────────────────────────

/**
 * Classify one basauto product against Aria's reality.
 *
 * Precedence: OVERBUY_RISK (PO blindness) > VELOCITY_MISMATCH (signal source)
 * > FALSE_URGENT / BORDERLINE > AGREE/QTY_MISMATCH > ARIA_ONLY.
 *
 * @param bas  basauto product record (full or slim).
 * @param aria Aria purchasing item for the same SKU, or null when Aria has no record.
 * @returns    A ReconItem, or null when both systems are calm (nothing to report).
 */
export function assessBasautoItem(bas: BasautoRecord, aria: AriaItemLite | null): ReconItem | null {
    const sku = normalizeSku(bas.productId);
    const basUrgency = (bas.urgency ?? "").trim();
    const basNonOK = BASAUTO_NON_OK.has(basUrgency.toUpperCase());
    const ariaNonOK = aria !== null && ARIA_NON_OK.has((aria.urgency ?? "").toLowerCase());

    const base = {
        sku,
        vendor: bas.supplier,
        description: bas.description,
    };
    const basautoSide = {
        urgency: basUrgency,
        stockDaysLeft: bas.stockDaysLeft,
        reorderQty: bas.reorderQty,
        reorderDate: bas.reorderDate,
        velocity: bas.velocity,
        onOrder: bas.onOrder,
        quantityInDrafts: bas.quantityInDrafts,
        supplierLeadDays: bas.supplierLeadDays,
        lastReceived: bas.lastReceived,
    };

    // Aria has no record for this SKU at all.
    if (aria === null) {
        if (!basNonOK) return null;
        const qtyNote = (bas.reorderQty ?? 0) <= 0 ? "no reorder" : `reorder ${fmtQty(bas.reorderQty)}`;
        return {
            ...base,
            verdict: "MISSING_IN_ARIA",
            severity: bas.slim ? "medium" : "high",
            reason: bas.slim
                ? `basauto overdue list has ${sku} (${qtyNote}) but Aria's purchasing pipeline has no record — likely the Finale candidate gate (no reorder config / no velocity) or a job-supply SKU. Verify in Finale.`
                : `basauto says ${basUrgency} (stockDays ${fmtDays(bas.stockDaysLeft)}, ${qtyNote}) but Aria's purchasing pipeline has no record — likely the Finale candidate gate (no reorder config / no velocity) or a job-supply SKU. Verify in Finale.`,
            basauto: basautoSide,
            aria: null,
        };
    }

    const lead = aria.effectiveLeadTimeDays ?? aria.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
    const runway = aria.adjustedRunwayDays ?? aria.runwayDays;
    const poQty = (aria.openPOs ?? []).reduce((s, po) => s + (Number(po.quantity) || 0), 0);
    const need30 = Math.max(aria.dailyRate ?? 0, 0) * NEED_WINDOW_DAYS;
    const ariaSide = {
        urgency: aria.urgency,
        runwayDays: runway,
        dailyRate: aria.dailyRate,
        stockOnHand: aria.stockOnHand,
        stockOnOrder: aria.stockOnOrder,
        poQty,
        pos: aria.openPOs ?? [],
        suggestedQty: aria.suggestedQty ?? aria.assessmentRecommendedQty,
        leadTimeDays: lead,
    };

    const ariaQty = ariaSide.suggestedQty ?? 0;
    const basQty = bas.reorderQty ?? 0;
    const qtyRatio =
        basQty > 0 && ariaQty > 0
            ? Math.abs(basQty - ariaQty) / Math.max(basQty, ariaQty)
            : 0;

    // 1. Both calm → nothing to report.
    if (!basNonOK && !ariaNonOK) return null;

    // 2. Aria flags it, basauto says OK — Aria sees BOM/FG demand basauto misses.
    if (!basNonOK && ariaNonOK) {
        return {
            ...base,
            verdict: "ARIA_ONLY",
            severity: "medium",
            reason: `Aria ${aria.urgency} (runway ${fmtDays(runway)}d, rate ${fmtRate(aria.dailyRate)}/d) but basauto says OK — Aria sees BOM/FG-traceback demand basauto's depletion math misses.`,
            basauto: basautoSide,
            aria: ariaSide,
        };
    }

    // 3. Both flag it.
    if (basNonOK && ariaNonOK) {
        const qtyMismatch = qtyRatio > QTY_GAP_RATIO;
        return {
            ...base,
            verdict: qtyMismatch ? "QTY_MISMATCH" : "AGREE",
            severity: qtyMismatch ? "medium" : "low",
            reason: qtyMismatch
                ? `Both flag it (basauto ${basUrgency}, Aria ${aria.urgency}) but quantities disagree: basauto ${fmtQty(basQty)} vs Aria ${fmtQty(ariaQty)} (${Math.round(qtyRatio * 100)}% apart).`
                : `Both flag it (basauto ${basUrgency}, Aria ${aria.urgency}). basauto wants ${fmtQty(basQty)}, Aria suggests ${fmtQty(ariaQty)}.`,
            basauto: basautoSide,
            aria: ariaSide,
        };
    }

    // 4. basauto flags it, Aria says calm — figure out WHY they disagree.
    // 4a. Committed PO blindness (Bill's known over-purchase risk).
    if (
        poQty > 0 &&
        need30 > 0 &&
        (bas.onOrder ?? 0) < poQty &&
        poQty + (aria.stockOnHand ?? 0) >= need30
    ) {
        const poList = ariaSide.pos
            .map((po) => `#${po.orderId} (${po.quantity}${po.orderDate ? `, ${po.orderDate}` : ""})`)
            .join(", ");
        return {
            ...base,
            verdict: "OVERBUY_RISK",
            severity: "high",
            reason: `basauto says ${basUrgency} (wants ${fmtQty(basQty)}) and shows on-order ${fmtQty(bas.onOrder)}, but Aria counts PO ${poList} — ${fmtQty(poQty)} on order + ${fmtQty(aria.stockOnHand)} on hand covers the 30-day need (${fmtQty(need30)}). Do not re-buy.`,
            basauto: basautoSide,
            aria: ariaSide,
        };
    }

    // 4b. Velocity source mismatch (depletion vs demand) — the root cause for most false urgencies.
    const basVel = bas.velocity ?? 0;
    const ariaRate = aria.dailyRate ?? 0;
    if (basVel > 0 && ariaRate > 0) {
        const ratio = basVel / ariaRate;
        if (ratio >= VELOCITY_GAP_RATIO || ratio <= 1 / VELOCITY_GAP_RATIO) {
            return {
                ...base,
                verdict: "VELOCITY_MISMATCH",
                severity: "medium",
                reason: `basauto velocity ${fmtRate(basVel)} vs Aria ${fmtRate(ariaRate)} (${ratio.toFixed(1)}×). basauto uses net 90-day stock depletion (${fmtQty(bas.quantity != null ? Math.abs(bas.quantity) : null)} lb out) including what became packed FG; Aria uses Finale demand/90 (${aria.dailyRateSource ?? "demand"}), gated by FG sell-through.`,
                basauto: basautoSide,
                aria: ariaSide,
            };
        }
    }

    // 4c. Plain runway disagreement.
    if (runway !== null && runway > RUNWAY_LEAD_MULTIPLE * lead) {
        return {
            ...base,
            verdict: "FALSE_URGENT",
            severity: "medium",
            reason: `basauto says ${basUrgency} (stockDays ${fmtDays(bas.stockDaysLeft)}, reorder by ${bas.reorderDate ?? "?"}) but Aria shows ${fmtDays(runway)}d runway vs ${fmtDays(lead)}d lead — past the order point. Basauto's number likely ignores stockAvailable/committed or uses depletion velocity.`,
            basauto: basautoSide,
            aria: ariaSide,
        };
    }

    // 4d. Basauto urgent and Aria calm but runway genuinely near the order point.
    return {
        ...base,
        verdict: "BORDERLINE",
        severity: "medium",
        reason: `basauto says ${basUrgency} (stockDays ${fmtDays(bas.stockDaysLeft)}, wants ${fmtQty(basQty)}); Aria says ${aria.urgency ?? "ok"} with runway ${fmtDays(runway)}d — inside 2× lead (${fmtDays(lead)}d). Review manually.`,
        basauto: basautoSide,
        aria: ariaSide,
    };
}

// ── Report assembly ─────────────────────────────────────────────────────────

const EMPTY_SUMMARY = (): ReconSummary => ({
    flagged: 0,
    high: 0,
    medium: 0,
    low: 0,
    byVerdict: {
        OVERBUY_RISK: 0,
        VELOCITY_MISMATCH: 0,
        FALSE_URGENT: 0,
        BORDERLINE: 0,
        MISSING_IN_ARIA: 0,
        QTY_MISMATCH: 0,
        AGREE: 0,
        ARIA_ONLY: 0,
    },
    basautoItems: 0,
    basautoNonOK: 0,
    ariaItems: 0,
    ariaNonOK: 0,
});

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Build the full reconciliation report.
 *
 * @param basRecords  Normalized basauto products (purchases + slim overdue merged).
 * @param ariaItems   Aria purchasing items keyed by SKU.
 * @param meta        Crawl metadata (source, aria cache time, errors).
 * @param options     Optional dismissed-SKU set — reviewed noise is excluded from items.
 */
export function buildReconReport(
    basRecords: BasautoRecord[],
    ariaItems: AriaItemLite[],
    meta: { source: "api" | "playwright"; ariaCachedAt: string | null; errors?: string[] },
    options: { dismissedSkus?: Set<string> } = {},
): ReconReport {
    const dismissed = options.dismissedSkus ?? new Set<string>();
    const ariaBySku = new Map<string, AriaItemLite>();
    for (const it of ariaItems) ariaBySku.set(normalizeSku(it.productId), it);

    const items: ReconItem[] = [];
    for (const bas of basRecords) {
        const sku = normalizeSku(bas.productId);
        if (dismissed.has(sku)) continue;
        const item = assessBasautoItem(bas, ariaBySku.get(sku) ?? null);
        if (item) items.push(item);
    }

    items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.sku.localeCompare(b.sku));

    const summary = EMPTY_SUMMARY();
    summary.basautoItems = basRecords.length;
    summary.basautoNonOK = basRecords.filter((b) => BASAUTO_NON_OK.has((b.urgency ?? "").trim().toUpperCase())).length;
    summary.ariaItems = ariaItems.length;
    summary.ariaNonOK = ariaItems.filter((a) => ARIA_NON_OK.has((a.urgency ?? "").toLowerCase())).length;
    summary.flagged = items.length;
    for (const it of items) {
        summary.byVerdict[it.verdict] += 1;
        summary[it.severity] += 1;
    }

    return {
        crawledAt: new Date().toISOString(),
        source: meta.source,
        ariaCachedAt: meta.ariaCachedAt,
        errors: meta.errors ?? [],
        summary,
        items,
    };
}
