/**
 * @file    src/cli/backfill-po-links.ts
 * @purpose Reverse-match unlinked shipments → open POs using carrier + vendor
 *          correlation. For each active shipment with an empty po_numbers array,
 *          attempt to link it to an open PO by:
 *            1. Carrier validation (seeds + learned map)
 *            2. Open-only filter (never attach to received/completed POs)
 *            3. Single-PO-per-vendor rule (only match when exactly one open PO
 *               exists for that vendor — prevents magnet-like pile-ups)
 *            4. Date-window disambiguation (closest to expected order date)
 *
 *          This is a different matching strategy than the email-based matcher
 *          (matchTrackingToPo) which requires vendor name in email text.
 *          Here we match by carrier + vendor from the PO, not by email content.
 *
 *          Dry-run by default. Pass `--apply` to write po_numbers and trigger
 *          syncLegacyPurchaseOrderTracking (which pushes to Finale).
 *
 * @author  Hermia
 * @created 2026-08-26
 * @env     PGRST_URL, DATABASE_URL (for PostgREST client)
 */

import { createClient } from "@/lib/db";
import { carrierRejectedForVendor, learnVendorCarrierCounts } from "@/lib/tracking/vendor-carrier";
import { leadTimeService } from "@/lib/builds/lead-time-service";
import { syncLegacyPurchaseOrderTracking } from "@/lib/tracking/shipment-intelligence";

const APPLY = process.argv.includes("--apply");

// Closed lifecycle states — never attach tracking to these
const CLOSED_STATES = new Set(["received", "completed", "order_completed", "cancelled"]);

// Known vendor→carrier pairs (from linked shipments analysis)
const VENDOR_CARRIER_MAP: Record<string, string[]> = {
    "Rootwise Soil Dynamics": ["FedEx"],
    "Emro USA": ["FedEx"],
    "The Amazing Dr. Zymes": ["FedEx"],
    "Diamond K Gypsum": ["FedEx", "FedEx Freight"],
    "Azure Standard": ["FedEx"],
    "SafeSolutions": ["FedEx"],
    "Axiom Print": ["FedEx", "UPS"],
    "Sun Coast Packaging, Inc.": ["FedEx"],
    "ULINE": ["UPS"],
    "Coats Agri-Aloe": ["UPS"],
    "Grassroots Fabric Pots": ["AAA Cooper", "UPS"],
    "C and S Plastics": ["AAA Cooper"],
    "Thirsty Earth": ["Oak Harbor Freight Lines"],
    "Thrive Probiotics": ["Oak Harbor Freight Lines"],
    "Seacoast Compost": ["Oak Harbor Freight Lines"],
    "Cen-Tec Systems": ["Oak Harbor Freight Lines", "UPS"],
    "Ferticell": ["Old Dominion"],
    "Organics Alive": ["FedEx Freight"],
    "Thorvin": ["FedEx Freight"],
    "Colorful Packaging Ltd": ["UPS"],
    "Stock Bag Depot": ["UPS"],
    "Grove Bags (Kinzie Advanced Polymers))": ["UPS"],
    "Left Coast Garden Wholesale": ["UPS"],
    "Sustainable Village": ["UPS", "Oak Harbor Freight Lines"],
    "Autopot Watering Systems": ["UPS"],
    "Miles Filippelli": ["UPS"],
    "TeaLAB": ["UPS"],
    "Organic AG Products": ["UPS"],
    "Novelty Manufacturing / Earthbox": ["UPS"],
    "Sticker Giant": ["UPS"],
    "Grand Master LED": ["UPS"],
    "EverGreen Growers Supply": ["UPS"],
    "Printful": ["UPS"],
    "Mammoth Lighting": ["UPS"],
    "Quinton O'Connor": ["UPS"],
    "Marion Ag Service, Inc": ["UPS"],
    "Funtechnik import": ["UPS"],
    "Malibu Compost": ["UPS"],
    "GrowGeneration": ["UPS"],
    "Farm Fuel Inc.": ["UPS"],
    "Aloe Corp": ["UPS"],
    "Liberty Natural Products Inc.": ["UPS"],
    "Gypsum": ["FedEx"],
    "Granite Mill Farms": ["FedEx"],
    "PULSE USA": ["UPS"],
    "Primary Packaging": ["UPS"],
    "TeraGanix": ["UPS"],
    "Lightray": ["UPS"],
    "Ecostadt Technologies LLC": ["Estes"],
    "JABB of the Carolinas, Inc.": ["UPS"],
    "SafeSolutions": ["FedEx"],
    "Azure Standard": ["FedEx"],
};

interface UnlinkedShipment {
    id: string;
    tracking_number: string;
    carrier_name: string | null;
    last_source: string;
    created_at: string | null;
}

interface OpenPO {
    po_number: string;
    vendor_name: string | null;
    created_at: string | null;
    lifecycle_state: string | null;
}

async function main() {
    const db = createClient();
    if (!db) {
        console.error("No PostgREST client available");
        process.exit(1);
    }

    // ── 1. Load all active, unlinked shipments ──────────────────────────────
    let allUnlinked: UnlinkedShipment[] = [];
    let offset = 0;
    while (true) {
        const { data } = await db
            .from("shipments")
            .select("id, tracking_number, carrier_name, last_source, created_at")
            .eq("active", true)
            .limit(1000)
            .offset(offset);
        const rows = data || [];
        // Filter for truly unlinked (empty po_numbers array)
        for (const row of rows as any[]) {
            if (!row.po_numbers || row.po_numbers.length === 0) {
                allUnlinked.push(row as UnlinkedShipment);
            }
        }
        if (rows.length < 1000) break;
        offset += 1000;
    }

    console.log(`Active unlinked shipments: ${allUnlinked.length}`);

    // ── 2. Load all open POs ────────────────────────────────────────────────
    let allPOs: OpenPO[] = [];
    offset = 0;
    while (true) {
        const { data } = await db
            .from("purchase_orders")
            .select("po_number, vendor_name, created_at, lifecycle_state")
            .limit(1000)
            .offset(offset);
        const rows = data || [];
        for (const row of rows as any[]) {
            if (!CLOSED_STATES.has(String(row.lifecycle_state || "").toLowerCase())) {
                allPOs.push(row as OpenPO);
            }
        }
        if (rows.length < 1000) break;
        offset += 1000;
    }

    console.log(`Open POs: ${allPOs.length}`);

    // ── 3. Build learned vendor→carrier map ─────────────────────────────────
    const learnedCarriers = await learnVendorCarrierCounts(db);
    console.log(`Learned vendor→carrier entries: ${learnedCarriers.size}`);

    // ── 4. Build lead-time map ──────────────────────────────────────────────
    let leadTimeDays: Map<string, number> | null = null;
    try {
        await leadTimeService.warmCache();
        leadTimeDays = new Map();
        for (const po of allPOs) {
            if (!po.vendor_name) continue;
            const key = po.vendor_name.trim().toLowerCase();
            if (leadTimeDays.has(key)) continue;
            const lt = await leadTimeService.getForVendor(po.vendor_name);
            leadTimeDays.set(key, lt.days);
        }
        console.log(`Lead-time entries: ${leadTimeDays.size}`);
    } catch (err: any) {
        console.warn(`Lead-time warm failed: ${err.message}`);
        leadTimeDays = null;
    }

    // ── 5. Build vendor→open-POs index ──────────────────────────────────────
    const vendorPOs = new Map<string, OpenPO[]>();
    for (const po of allPOs) {
        if (!po.vendor_name) continue;
        const key = po.vendor_name.trim().toLowerCase();
        if (!vendorPOs.has(key)) vendorPOs.set(key, []);
        vendorPOs.get(key)!.push(po);
    }

    // ── 6. Match each unlinked shipment ─────────────────────────────────────
    const matches: Array<{
        shipment: UnlinkedShipment;
        poNumber: string;
        vendorName: string;
    }> = [];
    const noMatch: UnlinkedShipment[] = [];

    for (const shipment of allUnlinked) {
        const carrier = shipment.carrier_name;
        if (!carrier) {
            noMatch.push(shipment);
            continue;
        }

        // Find vendors whose known carrier matches this shipment's carrier
        const matchingVendors: string[] = [];
        for (const [vendor, carriers] of Object.entries(VENDOR_CARRIER_MAP)) {
            const carrierLower = carrier.toLowerCase();
            const matches = carriers.some(c => 
                carrierLower.includes(c.toLowerCase()) || c.toLowerCase().includes(carrierLower)
            );
            if (matches) {
                matchingVendors.push(vendor);
            }
        }

        // Also check learned carriers
        for (const [vendor, carrierCounts] of learnedCarriers.entries()) {
            const carrierLower = carrier.toLowerCase();
            const matches = [...carrierCounts.keys()].some(k => 
                carrierLower.includes(k) || k.includes(carrierLower)
            );
            if (matches && !matchingVendors.includes(vendor)) {
                matchingVendors.push(vendor);
            }
        }

        if (matchingVendors.length === 0) {
            noMatch.push(shipment);
            continue;
        }

        // For each matching vendor, find their open POs
        const candidatePOs: OpenPO[] = [];
        for (const vendor of matchingVendors) {
            const vendorLower = vendor.trim().toLowerCase();
            const pos = vendorPOs.get(vendorLower) || [];
            candidatePOs.push(...pos);
        }

        // Filter out POs where carrier is contradicted
        const carrierValid = candidatePOs.filter(po => 
            !carrierRejectedForVendor(po.vendor_name, carrier, learnedCarriers)
        );

        if (carrierValid.length === 0) {
            noMatch.push(shipment);
            continue;
        }

        // CONSERVATIVE RULE: Only match when exactly one open PO exists for
        // this vendor. Multiple open POs = ambiguous → skip (prevents magnet).
        // Exception: if we have date-window disambiguation AND lead time,
        // we can pick the right one.
        if (carrierValid.length === 1) {
            matches.push({
                shipment,
                poNumber: carrierValid[0].po_number,
                vendorName: carrierValid[0].vendor_name || "Unknown",
            });
            continue;
        }

        // Multiple candidates — try date-window disambiguation
        const nowMs = shipment.created_at ? new Date(shipment.created_at).getTime() : Date.now();
        const scored = carrierValid.map(po => {
            const orderDate = po.created_at ? new Date(po.created_at).getTime() : 0;
            const lead = leadTimeDays?.get(po.vendor_name?.trim().toLowerCase() || "");
            let score = Number.POSITIVE_INFINITY;
            if (lead != null && lead > 0 && orderDate > 0) {
                score = Math.abs(orderDate - (nowMs - lead * 86_400_000));
            }
            return { po, score, orderDate };
        });

        const dateScored = scored.filter(s => Number.isFinite(s.score));
        if (dateScored.length === 1) {
            // Only one candidate has a finite date score — use it
            matches.push({
                shipment,
                poNumber: dateScored[0].po.po_number,
                vendorName: dateScored[0].po.vendor_name || "Unknown",
            });
        } else if (dateScored.length > 1) {
            // Multiple candidates with finite scores — pick closest
            dateScored.sort((a, b) => a.score - b.score);
            // CONSERVATIVE: only match if the best score is significantly better
            // (at least 2x better than the second-best)
            if (dateScored.length >= 2 && dateScored[0].score * 2 < dateScored[1].score) {
                matches.push({
                    shipment,
                    poNumber: dateScored[0].po.po_number,
                    vendorName: dateScored[0].po.vendor_name || "Unknown",
                });
            } else {
                // Ambiguous — skip
                noMatch.push(shipment);
            }
        } else {
            // No lead time data — can't disambiguate
            noMatch.push(shipment);
        }
    }

    // ── 7. Report ───────────────────────────────────────────────────────────
    console.log(`\n=== RESULTS ===`);
    console.log(`Matched: ${matches.length}`);
    console.log(`No match: ${noMatch.length}`);
    console.log(`Mode: ${APPLY ? "APPLY (write po_numbers + sync Finale)" : "DRY-RUN (no writes)"}`);

    // Group matches by vendor
    const byVendor = new Map<string, number>();
    for (const m of matches) {
        byVendor.set(m.vendorName, (byVendor.get(m.vendorName) || 0) + 1);
    }
    console.log(`\nMatches by vendor:`);
    for (const [vendor, count] of [...byVendor.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${vendor}: ${count}`);
    }

    // Group matches by carrier
    const byCarrier = new Map<string, number>();
    for (const m of matches) {
        const c = m.shipment.carrier_name || "unknown";
        byCarrier.set(c, (byCarrier.get(c) || 0) + 1);
    }
    console.log(`\nMatches by carrier:`);
    for (const [carrier, count] of [...byCarrier.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${carrier}: ${count}`);
    }

    // Show first 20 matches
    console.log(`\nSample matches (first 20):`);
    for (const m of matches.slice(0, 20)) {
        console.log(`  ${m.shipment.carrier_name}: ${m.shipment.tracking_number?.slice(0, 35)} → PO ${m.poNumber} (${m.vendorName})`);
    }

    // Show first 10 no-matches
    console.log(`\nSample no-matches (first 10):`);
    for (const s of noMatch.slice(0, 10)) {
        console.log(`  ${s.carrier_name}: ${s.tracking_number?.slice(0, 35)} | src:${s.last_source} | ${s.created_at?.slice(0, 10)}`);
    }

    // ── 8. Apply if requested ───────────────────────────────────────────────
    if (APPLY) {
        console.log(`\nApplying ${matches.length} matches...`);
        let applied = 0;
        let failed = 0;

        for (const m of matches) {
            try {
                // Get current po_numbers for this shipment
                const { data: current } = await db
                    .from("shipments")
                    .select("po_numbers")
                    .eq("id", m.shipment.id)
                    .single();

                const existingPOs = (current as any)?.po_numbers || [];
                if (existingPOs.includes(m.poNumber)) {
                    continue; // Already linked
                }

                // Append the new PO
                const newPOs = [...existingPOs, m.poNumber];
                const { error } = await db
                    .from("shipments")
                    .update({ po_numbers: newPOs })
                    .eq("id", m.shipment.id);

                if (error) {
                    console.warn(`  FAIL ${m.shipment.id}: ${error.message}`);
                    failed++;
                    continue;
                }

                // Sync to purchase_orders + Finale
                try {
                    await syncLegacyPurchaseOrderTracking(m.poNumber);
                } catch (syncErr: any) {
                    console.warn(`  Sync warn for PO ${m.poNumber}: ${syncErr.message}`);
                }

                applied++;
            } catch (err: any) {
                console.warn(`  ERROR ${m.shipment.id}: ${err.message}`);
                failed++;
            }
        }

        console.log(`\nApplied: ${applied}/${matches.length} (${failed} failed)`);
    } else {
        console.log(`\nRe-run with --apply to write po_numbers + sync to Finale.`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
});