/**
 * @file    src/lib/tracking/tracking-po-match.ts
 * @purpose Deterministic tracking→PO matcher. Replaces the vendor-name
 *          token-overlap inference that produced the PO 125178 magnet
 *          (567 shipments guessed onto one PO). Matching rules, in order:
 *
 *            1. Carrier validation — a vendor's known carrier must be plausible
 *               (Rootwise ships FedEx ⇒ an Oak Harbor number can't be Rootwise).
 *               Uses seeds + a learned vendor→carrier map (self-improving).
 *            2. Vendor match — the PO's vendor name must appear in the email
 *               text (full normalized name, or ≥2 distinctive tokens).
 *            3. Open only — never attaches to a received/completed PO.
 *            4. Date-window — when multiple open POs remain, pick the one whose
 *               order date sits closest to (now − vendor lead time). Falls back
 *               to most-recently-ordered when lead time is unavailable.
 *
 *          Explicit-PO extraction (the primary path) is separate and always
 *          wins over this fallback. This function is PURE and testable.
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    ./vendor-carrier
 */

import {
    carrierRejectedForVendor,
    normalizeCarrierToken,
    type VendorCarrierCounts,
} from "./vendor-carrier";

export interface TrackingPoCandidate {
    po_number: string;
    vendor_name?: string | null;
    created_at?: string | null;
    lifecycle_state?: string | null;
}

export interface TrackingMatchInput {
    /** Email text (subject + body + from) to match vendor names against. */
    text: string;
    /** Shipment carrier name (e.g. "FedEx", "Oak Harbor Freight Lines"). */
    carrier: string | null;
    /** Recent POs (vendor_name + lifecycle + created_at required). */
    recentPOs: TrackingPoCandidate[];
    /** Optional learned vendor→carrier counts (from learnVendorCarrierCounts). */
    learnedCarriers?: VendorCarrierCounts;
    /** Optional lead-time days keyed by normalized vendor name. */
    leadTimeDays?: Map<string, number> | null;
    /** Reference "now" (shipment arrival). Defaults to Date.now(). */
    now?: string;
}

/** Lifecycle states that must NOT receive new tracking links. */
const CLOSED_STATES = new Set(["received", "completed", "order_completed"]);

const MS_PER_DAY = 86_400_000;

/**
 * Domain-generic words that appear in many BuildASoil vendor names and in
 * nearly every carrier email ("BuildASoil" ship-to, product lines, signatures).
 * Excluded from token matching so "soil" can't match "Rootwise Soil Dynamics".
 */
const COMMON_VENDOR_WORDS = new Set([
    "soil", "soils", "earth", "organics", "organic", "supplies", "supply",
    "usa", "inc", "llc", "ltd", "co", "company", "corp", "corporation",
    "the", "and", "freight", "systems", "dynamics", "compost", "fabric",
    "pots", "aloe", "gypsum", "minerals", "mineral", "probiotics", "grow",
    "growers", "farm", "farms", "garden", "gardens", "agri", "agriculture",
]);

function wordTokens(value: string | null | undefined): string[] {
    return normalizeCarrierToken(value)
        .split(" ")
        .filter((t) => t.length >= 3 && !COMMON_VENDOR_WORDS.has(t));
}

/**
 * Does this PO's vendor name appear in the email text?
 * Full normalized name (≥5 chars) substring match is authoritative; otherwise
 * ≥2 distinctive tokens must each appear.
 */
function vendorNameMatchesText(vendorName: string | null | undefined, text: string): boolean {
    const vendor = normalizeCarrierToken(vendorName);
    const haystack = normalizeCarrierToken(text);
    if (!vendor || vendor.length < 3) return false;

    if (vendor.length >= 5 && haystack.includes(vendor)) return true;

    const tokens = wordTokens(vendorName);
    if (tokens.length < 2) return false;
    const matched = tokens.filter((t) => haystack.includes(t)).length;
    return matched >= 2;
}

/**
 * Match a carrier notification email to a PO. Returns the PO number, or null
 * when there is no confident match (tracking should be stored unlinked).
 */
export function matchTrackingToPo(input: TrackingMatchInput): string | null {
    const { text, carrier, recentPOs, learnedCarriers, leadTimeDays, now } = input;
    if (!recentPOs.length) return null;

    const nowMs = now ? new Date(now).getTime() : Date.now();

    const open = recentPOs.filter((po) => {
        if (CLOSED_STATES.has(String(po.lifecycle_state || "").toLowerCase())) return false;
        if (!vendorNameMatchesText(po.vendor_name, text)) return false;
        return true;
    });

    if (open.length === 0) return null;

    // Carrier validation — drop vendors whose known carrier contradicts.
    const carrierValid = carrier
        ? open.filter((po) => !carrierRejectedForVendor(po.vendor_name, carrier, learnedCarriers))
        : open;

    if (carrierValid.length === 0) return null;
    if (carrierValid.length === 1) return carrierValid[0].po_number;

    // Date-window disambiguation: expected order date = now − lead time.
    const scored = carrierValid.map((po) => {
        const orderDate = po.created_at ? new Date(po.created_at).getTime() : 0;
        const lead = leadTimeDays?.get(normalizeCarrierToken(po.vendor_name));
        let score = Number.POSITIVE_INFINITY;
        if (lead != null && lead > 0 && orderDate > 0) {
            score = Math.abs(orderDate - (nowMs - lead * MS_PER_DAY));
        }
        return { po, score, orderDate };
    });

    const dateScored = scored.filter((s) => Number.isFinite(s.score));
    if (dateScored.length > 0) {
        dateScored.sort((a, b) => a.score - b.score);
        return dateScored[0].po.po_number;
    }

    // No lead time — most recently ordered open PO wins (bounded).
    scored.sort((a, b) => b.orderDate - a.orderDate);
    return scored[0].po.po_number;
}
