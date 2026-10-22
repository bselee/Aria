/**
 * @file    scripts/recover-glued-tracking-numbers.ts
 * @purpose The PDF column-glue defect turned real FedEx numbers into fake ones
 *          (520484908553 + "1ea56"). Once the glued rows are deactivated the real parcels are
 *          invisible in the dashboard, so this restores them: poll the carrier for each real
 *          number and write a proper shipment row with NO PO (their source invoices cited only
 *          vendor-side refs that 404 in Finale). Vendor is recorded as provenance.
 *
 * @usage   node --import tsx --env-file=.env.local scripts/recover-glued-tracking-numbers.ts <realTracking>... [--apply]
 */
import { readFileSync } from "fs";
import { Client } from "pg";
const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { detectCarrier, getTrackingStatus, carrierUrl } from "../src/lib/carriers/tracking-service";
import { upsertShipmentEvidence } from "../src/lib/tracking/shipment-intelligence";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const NUMS = args.filter((a) => !a.startsWith("--"));
const VENDOR = "EverGreen Growers Supply";

async function main() {
  if (!NUMS.length) {
    console.error("usage: recover-glued-tracking-numbers.ts <realTracking>... [--apply]");
    process.exit(1);
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  for (const num of NUMS) {
    const carrier = detectCarrier(num);
    const existing = await c.query(
      `select tracking_number, po_numbers, active from shipments where normalized_tracking_number = $1`,
      [num],
    );
    if (existing.rows.length) {
      console.log(`${num}: already present -> ${JSON.stringify(existing.rows[0])}`);
      continue;
    }
    let status: any = null;
    try {
      status = await getTrackingStatus(carrier, num);
    } catch (e: any) {
      console.log(`${num}: carrier poll failed (${e.message})`);
    }
    console.log(
      `${num} [${carrier}] -> ${status?.category ?? "unknown"} / ${status?.statusDescription ?? "?"}` +
        `${status?.estimatedDelivery ? ` eta=${status.estimatedDelivery}` : ""}` +
        `${status?.deliveredAt ? ` delivered=${status.deliveredAt}` : ""}`,
    );
    if (!APPLY) continue;

    const rec = await upsertShipmentEvidence({
      trackingNumber: num,
      poNumber: null,
      vendorName: VENDOR,
      source: "manual_repair",
      sourceRef: "pdf column-glue recovery",
      confidence: 0.9,
      statusCategory: status?.category ?? null,
      statusDisplay: status?.statusDescription ?? null,
      estimatedDeliveryAt: status?.estimatedDelivery ?? null,
      deliveredAt: status?.deliveredAt ?? null,
      publicTrackingUrl: carrierUrl(carrier, num),
    });
    console.log(`  wrote ${rec?.trackingNumber} status=${rec?.statusCategory} po=${JSON.stringify(rec?.poNumbers)}`);
  }
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
