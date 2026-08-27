/**
 * @file    src/lib/tracking/vendor-carrier.ts
 * @purpose Vendor → carrier correlation for tracking→PO matching. A vendor's
 *          shipping carrier is a strong signal: "Rootwise ships FedEx" means an
 *          Oak Harbor freight number can never belong to a Rootwise PO.
 *
 *          Two layers:
 *            1. SEEDS — Bill's explicit knowledge + high-signal pairs.
 *            2. LEARNED — derived from purchase_orders.tracking_numbers
 *               (vendor + encoded carriers) and explicit-PO shipments. The
 *               learned layer self-improves as POs accumulate tracking, so it
 *               is re-derived on each run (no manual upkeep).
 *
 *          Guard is conservative: a vendor is only REJECTED on a carrier
 *          contradiction when we have ≥2 learned samples for that vendor
 *          (a single-sample vendor never triggers a reject). Unknown vendors
 *          are always allowed.
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    @/lib/db (for learnVendorCarrierCounts)
 */

import type { createClient } from "@/lib/db";

/** Normalize a carrier/vendor string for comparison. */
export function normalizeCarrierToken(value: string | null | undefined): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Known vendor → carrier pairs (normalized). Seed key is a unique substring of
 * the vendor name; values are normalized carrier names matched by substring so
 * "fedex" matches both "FedEx" (parcel) and "FedEx Freight" (LTL).
 *
 * Seeded from Bill's domain knowledge + high-signal learned pairs
 * (explicit-PO: ULINE→UPS ×4, Thrive→Oak Harbor ×4,
 * Organics Alive→FedEx Freight ×2, Grassroots→AAA Cooper ×2 (inbound LTL)).
 * Note: AAA Cooper — like FedEx — is bidirectional: it carries inbound
 * vendor LTL (Grassroots, C&S Plastics) AND produces outbound billing
 * noise. Ingest filters OUTBOUND at the SOURCE (billing email domains /
 * message IDs), not by carrier name, so vendor→AAA Cooper inbound seeds
 * are legitimate.
 */
export const VENDOR_CARRIER_SEEDS: Record<string, string[]> = {
    "rootwise": ["fedex"],
    "uline": ["ups"],
    "thrive probiotics": ["oak harbor"],
    "organics alive": ["fedex"],
    "grassroots fabric pots": ["aaa cooper", "ups"],
    "diamond k gypsum": ["fedex"],
    "ferticell": ["old dominion"],
    "c and s plastics": ["aaa cooper"],
    "the amazing dr. zymes": ["fedex"],
    "emro usa": ["fedex"],
    "thorvin": ["fedex"],
    "azure standard": ["fedex"],
    "coats agri-aloe": ["ups"],
    "thirsty earth": ["oak harbor"],
    "seacoast compost": ["oak harbor"],
    "cen-tec systems": ["oak harbor"],
};

/** Extract the carrier name from an encoded tracking string ("FedEx:::123" → "fedex"). */
export function carrierFromTrackingNumber(trackingNumber: string | null | undefined): string | null {
    const tn = String(trackingNumber || "").trim();
    if (!tn) return null;
    if (tn.includes(":::")) {
        return normalizeCarrierToken(tn.split(":::")[0]);
    }
    return null; // bare numbers carry no carrier label
}

export type CarrierVerdict =
    | "allow"    // no contradiction
    | "reject"   // positive contradiction — carrier NOT in vendor's known set
    | "unknown"; // no data — treat as allow

/** Learned vendor→carrier counts: normalizedVendor → (normalizedCarrier → count). */
export type VendorCarrierCounts = Map<string, Map<string, number>>;

/** Minimum total samples before a learned vendor can trigger a reject. */
const LEARNED_REJECT_MIN_SAMPLES = 2;

/**
 * Decide whether a carrier is plausible for a vendor.
 *
 * @param vendorName  Vendor name (any case/spacing).
 * @param carrier     Carrier name (e.g. "FedEx", "Oak Harbor Freight Lines").
 * @param learned     Optional learned vendor→carrier counts (from DB).
 * @returns 'reject' only on a high-signal contradiction.
 */
export function carrierMatchesVendor(
    vendorName: string | null | undefined,
    carrier: string | null | undefined,
    learned?: VendorCarrierCounts,
): CarrierVerdict {
    const v = normalizeCarrierToken(vendorName);
    const c = normalizeCarrierToken(carrier);
    if (!v || !c) return "unknown";

    // 1. Seeds (highest confidence).
    for (const [seedKey, carriers] of Object.entries(VENDOR_CARRIER_SEEDS)) {
        if (v.includes(seedKey) || seedKey.includes(v)) {
            const allowed = carriers.some((ac) => c.includes(ac) || ac.includes(c));
            return allowed ? "allow" : "reject";
        }
    }

    // 2. Learned counts (data-driven, self-improving).
    if (learned) {
        const carrierCounts = learned.get(v);
        if (carrierCounts && carrierCounts.size > 0) {
            const total = [...carrierCounts.values()].reduce((a, b) => a + b, 0);
            const matches = [...carrierCounts.entries()].some(
                ([known, count]) => count >= 1 && (c.includes(known) || known.includes(c)),
            );
            if (matches) return "allow";
            // Only reject when we have enough evidence this vendor doesn't use it.
            if (total >= LEARNED_REJECT_MIN_SAMPLES) return "reject";
        }
    }

    return "unknown";
}

/** True when the carrier is positively contradicted (seeds or learned). */
export function carrierRejectedForVendor(
    vendorName: string | null | undefined,
    carrier: string | null | undefined,
    learned?: VendorCarrierCounts,
): boolean {
    return carrierMatchesVendor(vendorName, carrier, learned) === "reject";
}

/**
 * Derive vendor→carrier counts from purchase_orders (vendor + encoded
 * tracking_numbers) and explicit-PO shipments. This is the self-improving
 * layer: as POs accumulate tracking, the map grows automatically.
 *
 * @param db  PostgREST client (from @/lib/db).
 */
export async function learnVendorCarrierCounts(
    db: ReturnType<typeof createClient> | null,
): Promise<VendorCarrierCounts> {
    const counts: VendorCarrierCounts = new Map();
    if (!db) return counts;

    const bump = (vendorName: string | null | undefined, carrier: string | null) => {
        const v = normalizeCarrierToken(vendorName);
        const c = normalizeCarrierToken(carrier);
        if (!v || !c) return;
        const inner = counts.get(v) || new Map<string, number>();
        inner.set(c, (inner.get(c) || 0) + 1);
        counts.set(v, inner);
    };

    try {
        // Source 1: purchase_orders.tracking_numbers (vendor + encoded carriers).
        let offset = 0;
        while (true) {
            const { data } = await db
                .from("purchase_orders")
                .select("vendor_name, tracking_numbers")
                .limit(1000)
                .offset(offset);
            const rows = data || [];
            for (const row of rows as any[]) {
                const tns = row.tracking_numbers;
                if (!Array.isArray(tns) || tns.length === 0) continue;
                for (const tn of tns) bump(row.vendor_name, carrierFromTrackingNumber(tn));
            }
            if (rows.length < 1000) break;
            offset += 1000;
        }
    } catch { /* non-fatal */ }

    return counts;
}
