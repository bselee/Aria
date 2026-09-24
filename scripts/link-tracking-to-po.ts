/**
 * @file    scripts/link-tracking-to-po.ts
 * @purpose Link a carrier tracking number to a purchase order, then verify it
 *          against the carrier API. Use when a tracking number is supplied
 *          outside the email-ingest path (Slack/Telegram/CLI hand-off) or when
 *          the ingest only produced a *candidate* (inferred) link that an
 *          operator has now confirmed.
 *
 *          SIDE EFFECTS (idempotent):
 *            1. shipments evidence upsert (PO link + vendor + operator source ref)
 *            2. carrier status refresh → status_category / ETA / last_checked_at
 *            3. PO sync: tracking_numbers[] + Finale custom fields + lifecycle
 *
 * @usage   node --import tsx --env-file=.env.local scripts/link-tracking-to-po.ts <po_number> <tracking_number> [--carrier=FedEx] [--dry-run]
 */

import { createClient } from "@/lib/db";
import {
    carrierUrl,
    detectCarrier,
    getTrackingStatus,
    isFedExNumber,
    splitEncodedTracking,
} from "@/lib/carriers/tracking-service";
import {
    normalizeTrackingIdentity,
    refreshShipmentStatus,
    upsertShipmentEvidence,
    type ShipmentRecord,
} from "@/lib/tracking/shipment-intelligence";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const carrierFlag = argv.find((a) => a.startsWith("--carrier="))?.split("=")[1];
const positional = argv.filter((a) => !a.startsWith("--"));
const [poArg, trackingArg] = positional;

function titleCase(value: string): string {
    return value
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ");
}

/** Resolve the carrier name to encode into "Carrier:::Number" (null = bare number). */
function resolveCarrierName(number: string): string | null {
    if (carrierFlag) return carrierFlag;
    const key = detectCarrier(number);
    if (key) return titleCase(key);
    return isFedExNumber(number) ? "FedEx" : null;
}

async function main() {
    if (!poArg || !trackingArg) {
        console.error(
            "usage: link-tracking-to-po.ts <po_number> <tracking_number> [--carrier=FedEx] [--dry-run]",
        );
        process.exit(1);
    }

    const db = createClient();
    const { data: po } = await db
        .from("purchase_orders")
        .select("po_number, vendor_name, status, lifecycle_state, tracking_numbers, line_items")
        .eq("po_number", poArg)
        .maybeSingle();

    if (!po) {
        console.error(`PO ${poArg}: not found in purchase_orders — aborting (no blind writes).`);
        process.exit(2);
    }

    const rawNumber = splitEncodedTracking(trackingArg).rawNumber;
    const carrierName = resolveCarrierName(rawNumber);
    const encoded = carrierName ? `${carrierName}:::${rawNumber}` : rawNumber;
    const identity = normalizeTrackingIdentity(encoded);

    console.log(`PO ${poArg} — ${po.vendor_name ?? "unknown vendor"} (status=${po.status})`);
    console.log(`tracking ${encoded} → key=${identity.trackingKey} kind=${identity.trackingKind} url=${carrierUrl(encoded)}`);

    if (dryRun) {
        console.log("dry run — no writes");
        return;
    }

    // 1. Operator-confirmed PO link
    const linked = await upsertShipmentEvidence({
        trackingNumber: encoded,
        poNumber: poArg,
        vendorName: po.vendor_name ?? null,
        source: "manual_confirmation",
        sourceRef: "operator:bill",
        confidence: 0.95,
        statusCategory: "in_transit",
        statusDisplay: "Tracking linked to PO (operator confirmed)",
        publicTrackingUrl: carrierUrl(encoded),
        active: true,
    });
    console.log(`evidence upserted: ${linked?.id ?? "(none)"} po_numbers=${JSON.stringify(linked?.po_numbers ?? [])}`);

    // 2. Carrier-verified status
    const status = await getTrackingStatus(encoded);
    console.log(`carrier status: ${status ? `${status.category} — ${status.display}${status.estimated_delivery_at ? ` (ETA ${status.estimated_delivery_at})` : ""}` : "UNAVAILABLE"}`);

    let refreshed: ShipmentRecord | null = linked;
    if (linked) {
        refreshed = await refreshShipmentStatus(linked);
        console.log(`shipment: kind=${refreshed.tracking_kind} status=${refreshed.status_category} checked=${refreshed.last_checked_at}`);
    }

    // 3. PO-side sync (tracking_numbers + Finale custom fields) — only fires when
    //    the evidence now classifies as confirmed (carrier status checked).
    const confirmed = await upsertShipmentEvidence({
        trackingNumber: encoded,
        poNumber: poArg,
        vendorName: po.vendor_name ?? null,
        source: "manual_confirmation",
        sourceRef: "operator:bill",
        confidence: 0.95,
        publicTrackingUrl: carrierUrl(encoded),
        active: true,
    });
    console.log(`po sync pass: ${confirmed ? "done" : "skipped"}`);

    const { data: after } = await db
        .from("purchase_orders")
        .select("po_number, tracking_numbers, tracking_status_summary, last_movement_summary, lifecycle_stage, updated_at")
        .eq("po_number", poArg)
        .maybeSingle();
    console.log(`PO after: tracking_numbers=${JSON.stringify(after?.tracking_numbers ?? [])} summary=${after?.tracking_status_summary ?? "-"} movement=${after?.last_movement_summary ?? "-"} stage=${after?.lifecycle_stage ?? "-"}`);

    const { data: row } = await db
        .from("shipments")
        .select("tracking_number, carrier_name, tracking_kind, po_numbers, vendor_names, status_category, status_display, estimated_delivery_at, last_checked_at, last_source, source_confidence, public_tracking_url")
        .eq("tracking_key", identity.trackingKey)
        .maybeSingle();
    console.log(`shipments row: ${JSON.stringify(row)}`);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
