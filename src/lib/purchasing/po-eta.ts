/**
 * @file    src/lib/purchasing/po-eta.ts
 * @purpose Single source of truth for purchase-order ETA resolution, shared by
 *          the Active Purchases dashboard and the Friday purchasing report.
 *          Reusing one chain keeps both surfaces consistent and lets every
 *          consumer benefit from lead-time improvements in one place.
 * @author  Hermia
 * @created 2026-10-22
 * @deps    ../builds/lead-time-service
 * @env     none
 */

import { leadTimeService, type LeadTimeResult } from "../builds/lead-time-service";

const DAY_MS = 86_400_000;

/** Add N days to an ISO date (timezone-safe, UTC math). Null on bad input. */
function addDaysIso(iso: string, days: number): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(dt.getTime())) return null;
    dt.setUTCDate(dt.getUTCDate() + days);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

/**
 * Finale often stores the *planned* reception on PO.receiveDate while status
 * is still Committed. Only use it as ETA when it's still in the future and
 * within a sane window after order (not junk like +120d).
 */
export function normalizePlannedReceiveDate(
    receiveDate: string | null | undefined,
    orderDate: string | null | undefined,
    today: string,
): string | null {
    if (!receiveDate) return null;
    const rd = /^(\d{4}-\d{2}-\d{2})/.exec(receiveDate)?.[1] || null;
    if (!rd) return null;
    if (rd <= today) return null; // past = real receipt, handled elsewhere
    if (orderDate) {
        const ord = /^(\d{4}-\d{2}-\d{2})/.exec(orderDate)?.[1];
        if (ord) {
            const days = (Date.parse(rd) - Date.parse(ord)) / DAY_MS;
            if (days > 75) return null; // absurd planned date
        }
    }
    return rd;
}

export interface PoEta {
    /** Resolved ETA date (YYYY-MM-DD). */
    date: string;
    /** Which rung of the chain produced the date. */
    provenance: "delivered" | "carrier" | "vendor" | "finale_planned" | "lead_time" | "fallback";
    /** Human label, e.g. "Finale planned receive" or "13d median · vendor history". */
    label: string;
    /** Vendor lead-time lookup, when one was performed (for callers that
     *  surface fallback lead provenance). Null when orderDate is missing. */
    lead: LeadTimeResult | null;
    /** Finale's normalized planned receive date, or null when absent/unusable. */
    plannedReceive: string | null;
}

/** Real movement evidence from the tracking tables. */
export interface ShipmentEtaSignal {
    /** Carrier's own estimated delivery (ISO timestamp or date). */
    estimatedDeliveryAt?: string | null;
    /** Actual delivery scan, when it happened. */
    deliveredAt?: string | null;
}

/** First YYYY-MM-DD in a value, or null. */
function isoDay(value: string | null | undefined): string | null {
    if (!value) return null;
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
    return m ? m[1] : null;
}

/**
 * Resolve a PO's ETA the same way for every consumer.
 *
 * Chain (best evidence first — Bill: real tracking beats any assumption):
 *   1. Carrier delivery scan            → "Delivered"
 *   2. Carrier estimated delivery       → "Carrier ETA"
 *   3. Vendor-stated date (email)       → "Vendor stated"
 *   4. Finale planned receive date      → "Finale planned receive"
 *   5. orderDate + leadTimeService      → policy → SKU → vendor → product → 21d
 *   6. today                            → last resort
 *
 * A carrier date in the past is not an ETA — it means the tracking record is
 * stale, so it falls through rather than pinning the PO to a dead date.
 *
 * Never throws — a lead-time failure degrades to the 21d default.
 */
export async function resolvePoEta(input: {
    vendorName: string;
    orderDate?: string | null;
    plannedReceiveDate?: string | null;
    /** Vendor-stated date from an email reply, when one exists. */
    vendorStatedEta?: string | null;
    /** Real carrier evidence for this PO, when a shipment record exists. */
    shipment?: ShipmentEtaSignal | null;
    sku?: string;
    today: string;
}): Promise<PoEta> {
    // Real movement evidence wins outright.
    const delivered = isoDay(input.shipment?.deliveredAt);
    if (delivered) {
        return {
            date: delivered,
            provenance: "delivered",
            label: "Delivered",
            lead: null,
            plannedReceive: null,
        };
    }

    const carrier = isoDay(input.shipment?.estimatedDeliveryAt);
    if (carrier && carrier >= input.today) {
        return {
            date: carrier,
            provenance: "carrier",
            label: "Carrier ETA",
            lead: null,
            plannedReceive: null,
        };
    }

    const vendor = isoDay(input.vendorStatedEta);
    if (vendor && vendor >= input.today) {
        return {
            date: vendor,
            provenance: "vendor",
            label: "Vendor stated",
            lead: null,
            plannedReceive: null,
        };
    }

    let lead: LeadTimeResult | null = null;
    if (input.orderDate) {
        lead = await leadTimeService
            .getForVendor(input.vendorName, input.sku)
            .catch(() => null);
    }

    const planned = normalizePlannedReceiveDate(
        input.plannedReceiveDate,
        input.orderDate,
        input.today,
    );
    if (planned) {
        return { date: planned, provenance: "finale_planned", label: "Finale planned receive", lead, plannedReceive: planned };
    }

    if (input.orderDate) {
        const days = lead?.days ?? 21;
        const computed = addDaysIso(input.orderDate, days);
        if (computed) {
            return {
                date: computed,
                provenance: "lead_time",
                label: lead?.label ?? "21d default",
                lead,
                plannedReceive: null,
            };
        }
    }

    return { date: input.today, provenance: "fallback", label: "21d default", lead, plannedReceive: null };
}

/** Provenance values that represent observed movement rather than a forecast. */
const REAL_MOVEMENT = new Set(["delivered", "carrier", "vendor"]);

/**
 * Push a forecast date out to the vendor's own worst case.
 *
 * The median lead time answers "when does this vendor usually land"; the p90
 * answers "when do they land when they slip". Planning against the second date
 * is what stops the board and the Friday report from reading optimistic. Real
 * movement evidence (a delivery scan, a carrier ETA, a vendor's stated date) is
 * never adjusted — it is already the truth.
 *
 * @param dateIso Resolved ETA date (YYYY-MM-DD).
 * @param provenance Which rung produced it.
 * @param slipDays p90 − p50 for that vendor; 0 or negative means no adjustment.
 * @returns The planning date, or the input when no adjustment applies.
 */
export function withVendorSlip(
    dateIso: string | null,
    provenance: PoEta["provenance"],
    slipDays: number,
): string | null {
    if (!dateIso || !Number.isFinite(slipDays) || slipDays <= 0) return dateIso;
    if (REAL_MOVEMENT.has(provenance)) return dateIso;
    return addDaysIso(dateIso, Math.round(slipDays)) ?? dateIso;
}
