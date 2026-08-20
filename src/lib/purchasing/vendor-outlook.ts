/**
 * @file    vendor-outlook.ts
 * @purpose Vendor timeline comments + a clean forward plan.
 *          BAS Auto / Finale "OVERDUE + huge qty" is often undated MFG/Soil
 *          builds, not a truck to place today. This module turns sales,
 *          consumption, dated builds, and a human note into an order-by.
 * @author  Hermia
 * @created 2026-08-14
 * @deps    none — pure
 */

export type OutlookReason =
    | "sales"
    | "dated_build"
    | "build_consumption"
    | "undated_build_ramp"
    | "covered"
    | "no_signal";

export interface OutlookItemInput {
    productId: string;
    itemType?: "resale" | "bom-component" | "resale-bom" | string | null;
    stockOnHand?: number | null;
    stockOnOrder?: number | null;
    stockAvailable?: number | null;
    dailyRate?: number | null;
    salesVelocity?: number | null;
    demandVelocity?: number | null;
    purchaseVelocity?: number | null;
    leadTimeDays?: number | null;
    effectiveLeadTimeDays?: number | null;
    suggestedQty?: number | null;
    lastPurchaseQty?: number | null;
    finaleReorderQty?: number | null;
    finaleStockoutDays?: number | null;
    feedsFinishedGoods?: Array<{ sku?: string }> | null;
    forwardDemandEntry?: {
        requiredQty: number;
        earliestBuildDate: string;
        feedsBuilds: string[];
    } | null;
    vendorPolicy?: {
        leadTimeOverrideDays?: number | null;
        targetCoverDays?: number | null;
        notes?: string | null;
    } | null;
}

export interface VendorOutlookFields {
    notes: string | null;
    leadTimeOverrideDays: number | null;
    targetCoverDays: number | null;
    holdUntilDate?: string | null;
    truckQty?: number | null;
}

export interface OutlookPlan {
    productId: string;
    reason: OutlookReason;
    orderByDate: string | null;
    orderByDays: number | null;
    leadDays: number;
    salesPerDay: number;
    demandPerDay: number;
    onHand: number;
    onOrder: number;
    truckHintQty: number | null;
    summary: string;
}

const HOLD_TOKEN = /(?:^|\n)HOLD:(\d{4}-\d{2}-\d{2})(?:\n|$)/;
const BUILD_RAMP_RATIO = 3;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Persist hold-until as HOLD:YYYY-MM-DD inside notes (no extra column). */
export function encodeOutlookNotes(holdUntilDate: string | null, notes: string | null): string | null {
    const rest = String(notes || "").replace(HOLD_TOKEN, "\n").trim();
    const hold = holdUntilDate && ISO_DATE.test(holdUntilDate) ? `HOLD:${holdUntilDate.slice(0, 10)}` : "";
    const out = [hold, rest].filter(Boolean).join("\n");
    return out || null;
}

export function decodeOutlookNotes(raw: string | null | undefined): { holdUntilDate: string | null; notes: string | null } {
    const text = String(raw || "");
    const m = text.match(HOLD_TOKEN);
    const holdUntilDate = m ? m[1] : null;
    const notes = text.replace(HOLD_TOKEN, "\n").trim() || null;
    return { holdUntilDate, notes };
}

/** True when the vendor is held through today (hidden from TODAY, still in 30/60/90). */
export function isHoldActive(holdUntilDate: string | null | undefined, today: Date = new Date()): boolean {
    if (!holdUntilDate || !ISO_DATE.test(holdUntilDate)) return false;
    const hold = holdUntilDate.slice(0, 10);
    const now = today.toISOString().slice(0, 10);
    return hold >= now;
}

/**
 * Pull lead / cover numbers out of a free-text vendor comment.
 * Examples: "120d MTO", "lead 60", "cover 90d", "6 months cover".
 */
export function parseOutlookNote(note: string | null | undefined): Partial<VendorOutlookFields> {
    if (!note) return {};
    const text = note.replace(/\s+/g, " ").trim();
    const out: Partial<VendorOutlookFields> = { notes: text };

    const lead =
        text.match(/\b(?:lead|lt)\s*[:=]?\s*(\d{1,3})\s*d\b/i) ||
        text.match(/\b(\d{1,3})\s*d(?:ay)?s?\s+(?:lead|lt|mto)\b/i) ||
        text.match(/\bmto\b[^\d]{0,12}(\d{1,3})\s*d/i);
    if (lead) {
        const n = Number(lead[1]);
        if (n >= 1 && n <= 180) out.leadTimeOverrideDays = n;
    } else if (/\bmto\b/i.test(text) && !/\b\d+\s*d/.test(text)) {
        out.leadTimeOverrideDays = 120;
    }

    const cover =
        text.match(/\b(?:cover|horizon|outlook)\s*[:=]?\s*(\d{1,3})\s*d\b/i) ||
        text.match(/\b(\d{1,3})\s*d(?:ay)?s?\s+cover\b/i);
    if (cover) {
        const n = Number(cover[1]);
        if (n >= 7 && n <= 365) out.targetCoverDays = n;
    } else {
        const months = text.match(/\b(\d(?:\.\d)?)\s*months?\s+cover\b/i);
        if (months) {
            const n = Math.round(Number(months[1]) * 30);
            if (n >= 7 && n <= 365) out.targetCoverDays = n;
        }
    }

    return out;
}

export function resolveOutlookLeadDays(item: OutlookItemInput, outlook?: VendorOutlookFields | null): number {
    const fromOutlook = outlook?.leadTimeOverrideDays;
    if (typeof fromOutlook === "number" && fromOutlook > 0) return fromOutlook;
    const fromPolicy = item.vendorPolicy?.leadTimeOverrideDays;
    if (typeof fromPolicy === "number" && fromPolicy > 0) return fromPolicy;
    const effective = item.effectiveLeadTimeDays;
    if (typeof effective === "number" && effective > 0) return effective;
    const declared = item.leadTimeDays;
    if (typeof declared === "number" && declared > 0) return declared;
    return 21;
}

function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
}

function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function parseIsoDate(value: string | null | undefined): Date | null {
    if (!value || !ISO_DATE.test(value)) return null;
    const d = new Date(value.slice(0, 10) + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
}

function fmtShort(iso: string): string {
    const d = parseIsoDate(iso);
    if (!d) return iso;
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** BOM / FG component — plan off build consumption, not shelf sales. */
export function isBuildInput(item: OutlookItemInput): boolean {
    const kind = String(item.itemType || "").toLowerCase();
    if (kind === "bom-component" || kind === "resale-bom") return true;
    if ((item.feedsFinishedGoods?.length ?? 0) > 0) return true;
    const sales = Math.max(0, Number(item.salesVelocity) || 0);
    const demand = Math.max(0, Number(item.demandVelocity) || 0);
    if (demand > 0 && demand >= Math.max(sales, 0.01) * BUILD_RAMP_RATIO) return true;
    return false;
}

/**
 * Forward plan for one SKU.
 * Build inputs (BOM / FG components): Finale demand + dated builds.
 * Resale / no BOM: sales only.
 * Never treat Finale's undated calendar dump as "buy the 256k today."
 */
export function planItemOutlook(
    item: OutlookItemInput,
    outlook?: VendorOutlookFields | null,
    today: Date = new Date(),
): OutlookPlan {
    const leadDays = resolveOutlookLeadDays(item, outlook);
    const onHand = Math.max(0, Number(item.stockOnHand) || 0);
    const onOrder = Math.max(0, Number(item.stockOnOrder) || 0);
    const salesPerDay = Math.max(0, Number(item.salesVelocity) || 0);
    const demandPerDay = Math.max(0, Number(item.demandVelocity) || 0);
    const lastTruck = typeof item.lastPurchaseQty === "number" && item.lastPurchaseQty > 0
        ? Math.round(item.lastPurchaseQty)
        : null;
    const productId = item.productId || "SKU";
    const buildInput = isBuildInput(item);
    const mixed = buildInput && salesPerDay > 0 && demandPerDay > 0;

    const forward = item.forwardDemandEntry;
    const buildDate = parseIsoDate(forward?.earliestBuildDate ?? null);
    const buildQty = forward?.requiredQty ?? 0;

    if (buildDate && buildQty > 0) {
        const orderBy = addDays(buildDate, -leadDays);
        const orderByDays = Math.round((orderBy.getTime() - today.getTime()) / 86_400_000);
        const fgs = (forward?.feedsBuilds ?? []).slice(0, 3).join("/");
        const truck = lastTruck && lastTruck > buildQty ? lastTruck : Math.ceil(buildQty);
        return {
            productId,
            reason: "dated_build",
            orderByDate: isoDate(orderBy),
            orderByDays,
            leadDays,
            salesPerDay,
            demandPerDay,
            onHand,
            onOrder,
            truckHintQty: truck,
            summary: `${productId} need ${Math.round(buildQty).toLocaleString()} for ${fmtShort(isoDate(buildDate))} build${fgs ? ` (${fgs})` : ""}. Order by ${fmtShort(isoDate(orderBy))} · ${leadDays}d lead.${lastTruck ? ` Last truck ${lastTruck.toLocaleString()}.` : ""}`,
        };
    }

    if (buildInput && demandPerDay > 0) {
        const burn = mixed ? Math.max(salesPerDay, demandPerDay) : demandPerDay;
        const runway = (onHand + onOrder) / burn;
        const orderByDays = Math.round(runway - leadDays);
        const orderBy = addDays(today, orderByDays);
        const truck = lastTruck ?? (typeof item.suggestedQty === "number" && item.suggestedQty > 0
            ? Math.round(item.suggestedQty)
            : null);
        const dateBit = buildDate
            ? ` next build ${fmtShort(isoDate(buildDate))}`
            : " no calendar date yet";
        const mixBit = mixed
            ? ` sales ${salesPerDay.toFixed(1)}/d + build ${demandPerDay.toFixed(0)}/d`
            : ` build burn ${demandPerDay.toFixed(0)}/d`;
        return {
            productId,
            reason: "build_consumption",
            orderByDate: isoDate(orderBy),
            orderByDays,
            leadDays,
            salesPerDay,
            demandPerDay,
            onHand,
            onOrder,
            truckHintQty: truck,
            summary: `${productId}${mixBit} · ${Math.round(runway)}d runway · order by ${fmtShort(isoDate(orderBy))} (${leadDays}d lead).${dateBit}.${truck ? ` Truck ~${truck.toLocaleString()}.` : ""}`,
        };
    }

    const burn = salesPerDay > 0 ? salesPerDay : (!buildInput ? (item.dailyRate ?? 0) : 0);
    if (burn > 0) {
        const runway = (onHand + onOrder) / burn;
        const orderByDays = Math.round(runway - leadDays);
        const orderBy = addDays(today, orderByDays);
        const covered = orderByDays > 90;
        const truck = lastTruck ?? (typeof item.suggestedQty === "number" && item.suggestedQty > 0
            ? Math.round(item.suggestedQty)
            : null);
        return {
            productId,
            reason: covered ? "covered" : "sales",
            orderByDate: isoDate(orderBy),
            orderByDays,
            leadDays,
            salesPerDay,
            demandPerDay,
            onHand,
            onOrder,
            truckHintQty: truck,
            summary: covered
                ? `${productId} ${Math.round(runway)}d sales runway · order by ${fmtShort(isoDate(orderBy))} (${leadDays}d lead).`
                : `${productId} order by ${fmtShort(isoDate(orderBy))} · ${Math.round(runway)}d sales runway − ${leadDays}d lead.${truck ? ` Truck ~${truck.toLocaleString()}.` : ""}`,
        };
    }

    return {
        productId,
        reason: "no_signal",
        orderByDate: null,
        orderByDays: null,
        leadDays,
        salesPerDay,
        demandPerDay,
        onHand,
        onOrder,
        truckHintQty: lastTruck,
        summary: `${productId} no sales/consumption signal. ${Math.round(onHand).toLocaleString()} on hand.`,
    };
}

export function planVendorOutlook(
    items: OutlookItemInput[],
    outlook?: VendorOutlookFields | null,
    today: Date = new Date(),
): {
    headline: string;
    tightest: OutlookPlan | null;
    plans: OutlookPlan[];
    rampCount: number;
} {
    const plans = items.map(item => planItemOutlook(item, outlook, today));
    const actionable = plans.filter(p =>
        p.reason === "sales" || p.reason === "dated_build" || p.reason === "build_consumption",
    );
    const rampCount = plans.filter(p => p.reason === "build_consumption" || p.reason === "undated_build_ramp").length;
    actionable.sort((a, b) => (a.orderByDays ?? 9999) - (b.orderByDays ?? 9999));
    const tightest = actionable[0] ?? plans.find(p => p.reason === "undated_build_ramp") ?? plans[0] ?? null;

    const noteBit = outlook?.notes?.trim() ? ` · ${outlook.notes.trim().slice(0, 80)}` : "";
    const leadBit = outlook?.leadTimeOverrideDays ? `${outlook.leadTimeOverrideDays}d lead` : null;
    const coverBit = outlook?.targetCoverDays ? `${outlook.targetCoverDays}d cover` : null;
    const policyBits = [leadBit, coverBit].filter(Boolean).join(" · ");

    let headline: string;
    if (tightest?.reason === "dated_build" || tightest?.reason === "sales") {
        headline = tightest.summary;
    } else if (rampCount > 0) {
        headline = `${rampCount} SKU${rampCount === 1 ? "" : "s"} on undated MFG/Soil ramps — not a today truck.`;
    } else if (tightest) {
        headline = tightest.summary;
    } else {
        headline = "No forward buy.";
    }
    if (policyBits) headline = `${policyBits}. ${headline}`;
    if (noteBit && !headline.includes(outlook?.notes?.trim().slice(0, 40) ?? "___")) {
        headline += noteBit;
    }

    return { headline, tightest, plans, rampCount };
}
