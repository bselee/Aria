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

/** Add N days to an ISO date (timezone-safe, UTC math). */
function addDaysIso(iso: string, days: number): string {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
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
    provenance: "finale_planned" | "lead_time" | "fallback";
    /** Human label, e.g. "Finale planned receive" or "13d median · vendor history". */
    label: string;
    /** Vendor lead-time lookup, when one was performed (for callers that
     *  surface fallback lead provenance). Null when orderDate is missing. */
    lead: LeadTimeResult | null;
    /** Finale's normalized planned receive date, or null when absent/unusable. */
    plannedReceive: string | null;
}

/**
 * Resolve a PO's ETA the same way for every consumer.
 *
 * Chain:
 *   1. Finale planned receive date (future + sane) → "Finale planned receive"
 *   2. orderDate + leadTimeService (policy override → SKU observed → vendor
 *      median → Finale product → 21d default)
 *   3. today (last resort)
 *
 * Never throws — a lead-time failure degrades to the 21d default.
 */
export async function resolvePoEta(input: {
    vendorName: string;
    orderDate?: string | null;
    plannedReceiveDate?: string | null;
    sku?: string;
    today: string;
}): Promise<PoEta> {
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
        return {
            date: addDaysIso(input.orderDate, days),
            provenance: "lead_time",
            label: lead?.label ?? "21d default",
            lead,
            plannedReceive: null,
        };
    }

    return { date: input.today, provenance: "fallback", label: "21d default", lead, plannedReceive: null };
}
