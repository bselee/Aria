/**
 * @file    match.ts
 * @purpose Pure matching logic for LTL Select COLLECT freight → Finale PO correlation.
 *          No network, no DB — every function here is deterministic so the module
 *          can be unit-tested in isolation (TDD). The CLI wires these to the live
 *          LTL Select API and Finale client.
 *
 *          Filtering rule (BAS-paid inbound only):
 *            - keep:  rate.paymentType === "COLLECT"  OR  rate.direction === "CONSIGNEE"
 *            - drop:  PREPAID / SHIPPER (customer-paid outbound freight)
 *          Amount of record: scannedInvoiceTotal.invoiceTotal (fallback: quoted total).
 * @author  Hermia
 * @created 2026-08-05
 * @deps    types.ts
 */

import type { LtlSelectInvoice } from "./types";

// ── Constants ────────────────────────────────────────────────────────────────

/** Finale-style 6-digit PO number. */
export const FINALE_PO_RE = /\b(\d{6})\b/;

/**
 * Origins whose shipments are NOT vendor freight: BuildASoil itself shipping
 * out. Defensive — the COLLECT/CONSIGNEE filter already drops these, but an
 * origin named BUILDASOIL with a weird rate block must never match a vendor.
 */
const OUTBOUND_ORIGIN_RE = /buildasoil|montrose/i;

/**
 * Vendor origin map — substring match against origin **name** first.
 * Order matters: more specific patterns first (e.g. "advantage wh" before "ams").
 * Live 90d origins (2026-08-05): ROOTWISE, GROKASHI, GRANITE MILL FARMS,
 * CONCENTRATES INC, SPUSA C/O ADVANTAGE WH, SEAFORTH MINERAL, LVC,
 * INTERNATIONAL MOLASSES, DIAMOND K, FARM FUEL, AMS LOGISTICS.
 */
export const VENDOR_ORIGIN_MAP: ReadonlyArray<{
    /** Case-insensitive regex tested against the origin name. */
    alias: RegExp;
    vendor: string;
}> = [
    { alias: /rootwise/i, vendor: "Rootwise Soil Dynamics" },
    { alias: /granite/i, vendor: "Granite Mill Farms" },
    { alias: /grokashi|gro\s*kashi/i, vendor: "Grokashi" },
    { alias: /surepack|spusa|advantage\s*wh|\blvc\b/i, vendor: "Surepack USA" },
    { alias: /seaforth/i, vendor: "Seaforth Mineral" },
    { alias: /concentrates/i, vendor: "Concentrates, Inc" },
    { alias: /diamond\s*k/i, vendor: "Diamond K" },
    { alias: /farm\s*fuel/i, vendor: "Farm Fuel" },
    { alias: /ams\s*logistics/i, vendor: "AMS Logistics" },
    { alias: /molasses/i, vendor: "International Molasses" },
    { alias: /riceland/i, vendor: "Riceland" },
    { alias: /uline/i, vendor: "Uline" },
];

/**
 * City/state fallback for origins whose name is opaque (e.g. "LVC" for the
 * Surepack Las Vegas warehouse). City/state are matched UPPERCASE.
 */
export const VENDOR_CITY_STATE_MAP: ReadonlyArray<{
    city: string;
    state: string;
    vendor: string;
}> = [
    { city: "EVERGREEN", state: "CO", vendor: "Rootwise Soil Dynamics" },
    { city: "MISSOULA", state: "MT", vendor: "Granite Mill Farms" },
    { city: "LAYTONVILLE", state: "CA", vendor: "Grokashi" },
    { city: "LAS VEGAS", state: "NV", vendor: "Surepack USA" },
];

/**
 * Vendors excluded from automatic freight application (special shipping
 * arrangements, freight billed inside product cost, etc.) — mirror of
 * reconcile-fedex.ts EXCLUDE_VENDORS. Reports them for manual handling unless
 * the CLI passes --include-excluded.
 */
export const EXCLUDE_VENDORS: ReadonlyArray<string> = ["grokashi"];

/**
 * Multi-delivery vendors: several LTL Select shipments (each PRO/BOL) against
 * ONE Finale PO — each delivery gets its own FREIGHT line. Differentiation is
 * Finale receiveDate vs freight pickup (not orderDate alone).
 *
 * Bill 2026-08-05: Rootwise multi-ship hard to split; Granite farther but still
 * in band. **All lanes: receive typically within 7–10 MAX business days** of
 * freight pickup. Multi-delivery requires a correlated receive in that window
 * (no orderDate-only guess).
 */
export const MULTI_DELIVERY_VENDORS: ReadonlyArray<string> = ["rootwise", "granite"];

/**
 * Max |pickup − Finale receive| in **business days** (Mon–Fri) for multi-delivery
 * attribution. Bill: typically 7–10 MAX biz days for all (Rootwise short end,
 * Granite/farther still ≤10).
 */
export const MULTI_DELIVERY_RECEIVE_MAX_BIZ_DAYS = 10;

/** Soft rank window (calendar days) for single-delivery vendor_window matches. */
export const SINGLE_DELIVERY_RECEIVE_RANK_DAYS = 7;

/**
 * Count business days between two YYYY-MM-DD (or ISO) dates, exclusive of neither
 * endpoint style: number of Mon–Fri midnights crossed by the absolute span.
 * Same calendar day → 0. Weekend-only span can still be 0–1 depending on endpoints.
 */
export function businessDaysBetween(dateA: string, dateB: string): number {
    const a = new Date(`${String(dateA).slice(0, 10)}T12:00:00`);
    const b = new Date(`${String(dateB).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return Number.POSITIVE_INFINITY;
    const start = a <= b ? a : b;
    const end = a <= b ? b : a;
    let count = 0;
    const cur = new Date(start);
    cur.setDate(cur.getDate() + 1); // exclusive start: days after start until end inclusive
    while (cur <= end) {
        const dow = cur.getDay(); // 0 Sun … 6 Sat
        if (dow !== 0 && dow !== 6) count += 1;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}

/**
 * Receive-correlation window description for logs/tests.
 * Multi-delivery → MULTI_DELIVERY_RECEIVE_MAX_BIZ_DAYS business days;
 * single-delivery → SINGLE_DELIVERY_RECEIVE_RANK_DAYS calendar days (rank only).
 */
export function receiveWindowDaysForVendor(vendorName: string): {
    mode: "business" | "calendar";
    maxDays: number;
} {
    if (isMultiDeliveryVendor(vendorName)) {
        return { mode: "business", maxDays: MULTI_DELIVERY_RECEIVE_MAX_BIZ_DAYS };
    }
    return { mode: "calendar", maxDays: SINGLE_DELIVERY_RECEIVE_RANK_DAYS };
}

// ── Derived types ────────────────────────────────────────────────────────────

/**
 * A COLLECT invoice normalized into the shape the reconciler works with.
 * `amount` is the amount of record (scanned invoice total, quote fallback);
 * `quoteAmount` is kept for variance reporting.
 */
export interface CollectEntry {
    invoiceId: string;
    proNumber: string;
    bolNumber: string;
    orderNumber: string | null;
    referenceNumber: string | null;
    pickupNumber: string | null;
    internalTrackingNumber: string | null;
    originName: string;
    originCity: string;
    originState: string;
    originPostalCode: string;
    /** YYYY-MM-DD pickup/ship date (origin.date preferred). */
    pickupDate: string;
    carrier: string;
    paymentType: string;
    direction: string;
    quoteAmount: number;
    amount: number;
    statusCode: string;
    raw: LtlSelectInvoice;
}

export interface VendorOriginMatch {
    vendor: string;
    matchedBy: "name" | "city_state";
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function toNumber(value: unknown): number {
    const n = typeof value === "string" ? parseFloat(value) : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toDateOnly(value: string | null | undefined): string {
    if (!value) return "";
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
        return d.toISOString().split("T")[0];
    }
    return value.slice(0, 10);
}

/** True when the shipment is BAS-paid inbound freight. */
export function isCollectShipment(invoice: LtlSelectInvoice): boolean {
    const rate = invoice?.shipment?.rate;
    const paymentType = (rate?.paymentType || "").toUpperCase();
    const direction = (rate?.direction || "").toUpperCase();
    if (paymentType === "COLLECT" || direction === "CONSIGNEE") {
        // Defensive: an origin that is literally BuildASoil means this is an
        // outbound/return shipment regardless of rate flags.
        const originName = (invoice?.shipment?.origin?.name || "").toUpperCase();
        return !OUTBOUND_ORIGIN_RE.test(originName);
    }
    return false;
}

/**
 * Normalize a raw API invoice row into a CollectEntry.
 *
 * Returns null for outbound (PREPAID/SHIPPER) rows and for rows with no usable
 * amount (neither scanned nor quoted total).
 */
export function parseCollectEntry(invoice: LtlSelectInvoice): CollectEntry | null {
    if (!isCollectShipment(invoice)) return null;

    const rate = invoice?.shipment?.rate ?? null;
    const origin = invoice?.shipment?.origin ?? null;
    const identifiers = invoice?.identifiers ?? null;
    const scanned = invoice?.scannedInvoiceTotal ?? null;

    const scannedAmount = toNumber(scanned?.invoiceTotal);
    const quoteAmount = toNumber(rate?.rateQuoteDetail?.total);
    const amount = scannedAmount > 0 ? scannedAmount : quoteAmount;
    if (amount <= 0) return null;

    const address = origin?.address ?? null;
    const rawDate =
        origin?.date ||
        invoice?.shipment?.booked_at ||
        invoice?.shipment?.pickupDateTime ||
        "";

    return {
        invoiceId: invoice?._id ?? "",
        proNumber: identifiers?.proNumber || "",
        bolNumber: identifiers?.bolNumber || "",
        orderNumber: identifiers?.orderNumber || null,
        referenceNumber: identifiers?.referenceNumber || null,
        pickupNumber: identifiers?.pickupNumber || null,
        internalTrackingNumber: identifiers?.internalTrackingNumber || null,
        originName: origin?.name || "",
        originCity: address?.city || "",
        originState: address?.state || "",
        originPostalCode: address?.postal_code || address?.postalCode || "",
        pickupDate: toDateOnly(rawDate),
        carrier: invoice?.shipment?.carrier || "",
        paymentType: rate?.paymentType || "",
        direction: rate?.direction || "",
        quoteAmount,
        amount,
        statusCode: invoice?.status?.currentStatus?.code || "",
        raw: invoice,
    };
}

/**
 * Extract a Finale PO number from orderNumber / referenceNumber only.
 * Never scans PRO/BOL/pickup blobs (false 6-digit hits). 8-digit ecommerce ids ignored.
 */
export function extractFinalePoNumber(
    invoiceOrEntry: LtlSelectInvoice | CollectEntry,
    _opts: { hardOnly?: boolean } = {},
): string | null {
    const ids =
        "identifiers" in invoiceOrEntry
            ? (invoiceOrEntry.identifiers ?? null)
            : {
                  orderNumber: invoiceOrEntry.orderNumber,
                  referenceNumber: invoiceOrEntry.referenceNumber,
              };

    const candidates: string[] = [];
    if (ids?.orderNumber) candidates.push(String(ids.orderNumber));
    if (ids?.referenceNumber) candidates.push(String(ids.referenceNumber));

    for (const candidate of candidates) {
        // Pure 6-digit token only (not a slice of longer digit runs)
        const pure = candidate.trim().match(/^(\d{6})$/);
        if (pure) return pure[1];
        const embedded = candidate.match(/(?:^|[^\d])(\d{6})(?:[^\d]|$)/);
        if (embedded && !/\d{7,}/.test(candidate)) return embedded[1];
        // "PO 124909" / "PO-124909"
        const labeled = candidate.match(/\bPO[\s#-]*(\d{6})\b/i);
        if (labeled) return labeled[1];
    }
    return null;
}

/** Alias — PO extract is always order/ref-only. */
export function extractHardFinalePoNumber(
    invoiceOrEntry: LtlSelectInvoice | CollectEntry,
): string | null {
    return extractFinalePoNumber(invoiceOrEntry);
}

/**
 * Match an origin to a known vendor: name substring first, then city/state.
 *
 * @returns null when the origin is unknown.
 */
export function matchVendorFromOrigin(entry: CollectEntry): VendorOriginMatch | null {
    const name = (entry.originName || "").toUpperCase();
    for (const { alias, vendor } of VENDOR_ORIGIN_MAP) {
        if (alias.test(name)) return { vendor, matchedBy: "name" };
    }

    const city = (entry.originCity || "").toUpperCase();
    const state = (entry.originState || "").toUpperCase();
    if (city && state) {
        for (const { city: mapCity, state: mapState, vendor } of VENDOR_CITY_STATE_MAP) {
            if (city === mapCity && state === mapState) {
                return { vendor, matchedBy: "city_state" };
            }
        }
    }
    return null;
}

/** True when the vendor is on the no-auto-freight exclusion list. */
export function isExcludedVendor(vendorName: string): boolean {
    const lc = (vendorName || "").toLowerCase();
    return EXCLUDE_VENDORS.some((v) => lc.includes(v));
}

/** True when the vendor gets one FREIGHT line per delivery (multi-delivery OK). */
export function isMultiDeliveryVendor(vendorName: string): boolean {
    const lc = (vendorName || "").toLowerCase();
    return MULTI_DELIVERY_VENDORS.some((v) => lc.includes(v));
}

/**
 * Variance between the carrier's scanned invoice total and the original quote.
 * Positive = carrier charged more than quoted (e.g. Rootwise residential
 * pickup ~+$97).
 */
export function computeVariance(entry: CollectEntry): number {
    return entry.amount - entry.quoteAmount;
}

/**
 * Closest Finale receive within the given window of freightDate.
 * mode "business" uses businessDaysBetween; "calendar" uses absolute calendar days.
 */
export interface ReceptionHit {
    shipmentId?: string;
    receiveDate: string;
    /** Distance in the active unit (biz days or calendar days). */
    diffDays: number;
}

export function findBestReception(
    po: { shipments?: Array<{ shipmentId?: string; receiveDate?: string | null }> },
    freightDate: string,
    opts: { mode: "business" | "calendar"; maxDays: number },
): ReceptionHit | null {
    if (!po?.shipments || po.shipments.length === 0) return null;
    let best: ReceptionHit | null = null;
    for (const sh of po.shipments) {
        if (!sh.receiveDate) continue;
        const diffDays =
            opts.mode === "business"
                ? businessDaysBetween(freightDate, sh.receiveDate)
                : Math.abs(
                      (new Date(`${String(freightDate).slice(0, 10)}T12:00:00`).getTime() -
                          new Date(`${String(sh.receiveDate).slice(0, 10)}T12:00:00`).getTime()) /
                          86400000,
                  );
        if (!Number.isFinite(diffDays) || diffDays > opts.maxDays) continue;
        if (!best || diffDays < best.diffDays) {
            best = {
                shipmentId: sh.shipmentId,
                receiveDate: sh.receiveDate,
                diffDays,
            };
        }
    }
    return best;
}

/**
 * Find a correlated reception note on a PO.
 * Prefer findBestReception + vendor window; this keeps a simple calendar default
 * for callers that pass an explicit windowDays.
 *
 * @returns Human-readable correlation note, or null.
 */
export function findCorrelatedReception(
    po: { shipments?: Array<{ shipmentId?: string; receiveDate?: string | null }> },
    dateStr: string,
    windowDays = SINGLE_DELIVERY_RECEIVE_RANK_DAYS,
    mode: "business" | "calendar" = "calendar",
): string | null {
    const best = findBestReception(po, dateStr, { mode, maxDays: windowDays });
    if (!best) return null;
    const unit = mode === "business" ? "biz d" : "d";
    return `Rec ${best.shipmentId ?? "?"} on ${best.receiveDate} (Δ${best.diffDays.toFixed(0)}${unit})`;
}

/**
 * PO candidate shape consumed by pickPoForEntry — the subset of a FullPO that
 * matters for matching (what getRecentPurchaseOrders returns).
 */
export interface PoCandidate {
    orderId: string;
    vendorName: string;
    orderDate: string; // YYYY-MM-DD
    shipments?: Array<{ shipmentId?: string; receiveDate?: string | null }>;
}

/**
 * Pick the best Finale PO for an entry among recent POs of the mapped vendor.
 *
 * Shared:
 *   - Dropship order ids skipped
 *   - freight pickup within [orderDate − 3d, orderDate + 45d]
 *
 * Multi-delivery (Rootwise, Granite) — Bill 2026-08-05:
 *   - REQUIRE Finale receive within MULTI_DELIVERY_RECEIVE_MAX_BIZ_DAYS (10)
 *     **business days** of pickup (all lanes typically 7–10 MAX biz days)
 *   - Prefer closest receive; no orderDate-only fallback
 *
 * Single-delivery:
 *   - Prefer receive within SINGLE_DELIVERY_RECEIVE_RANK_DAYS calendar days,
 *     else closest orderDate
 */
export function pickPoForEntry(
    entry: CollectEntry,
    recentPOs: PoCandidate[],
    mappedVendor: string,
): PoCandidate | null {
    const vendorKey = mappedVendor.split(" ")[0].toLowerCase();
    const delMs = new Date(entry.pickupDate).getTime();
    if (Number.isNaN(delMs)) return null;
    const multi = isMultiDeliveryVendor(mappedVendor);
    const window = receiveWindowDaysForVendor(mappedVendor);

    const vendorPOs = recentPOs.filter((po) => {
        if (/dropship/i.test(po.orderId || "")) return false;
        const name = (po.vendorName || "").toLowerCase();
        if (!name.includes(vendorKey)) return false;
        const orderMs = new Date(po.orderDate).getTime();
        if (Number.isNaN(orderMs)) return false;
        const daysDiff = (delMs - orderMs) / 86400000;
        if (daysDiff < -3 || daysDiff > 45) return false;
        // Multi-delivery: must have a receive in the biz-day window.
        if (multi) {
            return !!findBestReception(po, entry.pickupDate, window);
        }
        return true;
    });

    if (vendorPOs.length === 0) return null;

    vendorPOs.sort((a, b) => {
        const aHit = findBestReception(a, entry.pickupDate, window);
        const bHit = findBestReception(b, entry.pickupDate, window);
        if (aHit && bHit) return aHit.diffDays - bHit.diffDays;
        if (aHit && !bHit) return -1;
        if (!aHit && bHit) return 1;
        const diffA = Math.abs(delMs - new Date(a.orderDate).getTime());
        const diffB = Math.abs(delMs - new Date(b.orderDate).getTime());
        return diffA - diffB;
    });

    return vendorPOs[0] ?? null;
}

/**
 * Finale FREIGHT adjustment description — keep simple (Bill 2026-08-05):
 * amount is the field; notes = "Freight" + BOL (or PRO if no BOL).
 * No LTL Select / origin / date prose on the PO.
 *
 * @example "Freight BOL 17165341"
 * @example "Freight PRO 300183121811"
 */
export function buildFreightLabel(entry: CollectEntry): string {
    if (entry.bolNumber) return `Freight BOL ${entry.bolNumber}`;
    if (entry.proNumber) return `Freight PRO ${entry.proNumber}`;
    return "Freight";
}

// ── Apply confidence (gates --live) ──────────────────────────────────────────

export type FreightApplyConfidence = "high" | "medium" | "low";

export interface FreightApplyScoreInput {
    entry: CollectEntry;
    /** hard PO from order/ref only */
    hardPoRef: string | null;
    matchSource: "po_ref" | "vendor_window" | "excluded" | "unmatched";
    finalePoId: string | null;
    vendor: string | null;
    vendorMatchedBy: "name" | "city_state" | null;
    freightAlreadyOnPO: boolean;
    /** Set when would-add path failed verify */
    error?: string | null;
    /**
     * Business-day (multi) or calendar-day (single) distance to best Finale
     * receive, when known. null = no correlated receive.
     */
    receiveDiffDays: number | null;
    /** True when scannedInvoiceTotal.invoiceTotal drove amount (not quote). */
    hasScannedAmount: boolean;
}

export interface FreightApplyScore {
    confidence: FreightApplyConfidence;
    /** Short machine-stable reasons for the report. */
    reasons: string[];
    /** True when --live may write Finale FREIGHT (high only). */
    mayApply: boolean;
}

const AMOUNT_MIN = 5;
const AMOUNT_MAX = 5000;

/**
 * Score whether a COLLECT freight match is safe to auto-apply to a Finale PO.
 *
 * HIGH (mayApply): scanned $, known vendor by name, PO solid, multi-delivery
 * has receive ≤10 biz days, single-delivery has receive or hard po_ref,
 * not excluded/dropship/already, $ in band.
 *
 * MEDIUM: matched but waiting receive / soft po_ref / city-only vendor / quote-only.
 * LOW: unmatched, excluded, error, insane $.
 */
export function scoreFreightApplyConfidence(input: FreightApplyScoreInput): FreightApplyScore {
    const reasons: string[] = [];
    const {
        entry,
        hardPoRef,
        matchSource,
        finalePoId,
        vendor,
        vendorMatchedBy,
        freightAlreadyOnPO,
        error,
        receiveDiffDays,
        hasScannedAmount,
    } = input;

    if (error) {
        return { confidence: "low", reasons: ["error", error.slice(0, 80)], mayApply: false };
    }
    if (matchSource === "excluded") {
        return { confidence: "low", reasons: ["excluded_vendor"], mayApply: false };
    }
    if (matchSource === "unmatched" || !finalePoId) {
        return { confidence: "low", reasons: ["unmatched"], mayApply: false };
    }
    if (freightAlreadyOnPO) {
        return { confidence: "low", reasons: ["already_on_po"], mayApply: false };
    }
    if (/dropship/i.test(finalePoId)) {
        return { confidence: "low", reasons: ["dropship_po"], mayApply: false };
    }
    if (entry.amount < AMOUNT_MIN || entry.amount > AMOUNT_MAX) {
        return {
            confidence: "low",
            reasons: [`amount_out_of_band_${entry.amount}`],
            mayApply: false,
        };
    }
    if (!vendor) {
        return { confidence: "medium", reasons: ["unknown_vendor"], mayApply: false };
    }
    if (vendorMatchedBy === "city_state") {
        reasons.push("vendor_city_only");
    }
    if (!hasScannedAmount) {
        reasons.push("quote_only_amount");
    }

    const multi = isMultiDeliveryVendor(vendor);
    const hardRefMatch = !!(hardPoRef && hardPoRef === finalePoId);

    if (multi) {
        if (receiveDiffDays === null) {
            return {
                confidence: "medium",
                reasons: [...reasons, "multi_delivery_no_receive"],
                mayApply: false,
            };
        }
        if (receiveDiffDays > MULTI_DELIVERY_RECEIVE_MAX_BIZ_DAYS) {
            return {
                confidence: "medium",
                reasons: [...reasons, `receive_delta_biz_${receiveDiffDays}`],
                mayApply: false,
            };
        }
        reasons.push(`receive_ok_biz_${receiveDiffDays}`);
        if (vendorMatchedBy !== "name" && !hardRefMatch) {
            return {
                confidence: "medium",
                reasons: [...reasons, "multi_needs_name_or_hard_po"],
                mayApply: false,
            };
        }
        if (!hasScannedAmount) {
            return { confidence: "medium", reasons, mayApply: false };
        }
        reasons.push(hardRefMatch ? "hard_po_ref" : "vendor_window_multi");
        return { confidence: "high", reasons, mayApply: true };
    }

    // Single-delivery
    if (hardRefMatch && hasScannedAmount && vendorMatchedBy === "name") {
        reasons.push("hard_po_ref");
        return { confidence: "high", reasons, mayApply: true };
    }
    if (
        matchSource === "vendor_window" &&
        hasScannedAmount &&
        vendorMatchedBy === "name" &&
        receiveDiffDays !== null &&
        receiveDiffDays <= SINGLE_DELIVERY_RECEIVE_RANK_DAYS
    ) {
        reasons.push(`receive_ok_cal_${receiveDiffDays}`, "vendor_window");
        return { confidence: "high", reasons, mayApply: true };
    }

    if (matchSource === "po_ref" && !hardRefMatch) {
        reasons.push("soft_po_ref_blob");
    }
    if (receiveDiffDays === null) reasons.push("no_receive");
    reasons.push(matchSource);
    return { confidence: "medium", reasons, mayApply: false };
}

/** Detect whether CollectEntry.amount came from scanned invoice total. */
export function entryHasScannedAmount(entry: CollectEntry): boolean {
    const scanned = toNumber(entry.raw?.scannedInvoiceTotal?.invoiceTotal);
    return scanned > 0 && Math.abs(scanned - entry.amount) < 0.005;
}
