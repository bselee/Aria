// Targeted carrier poll for three shipments the cron cannot reach (lock held).
// Mirrors carrier-poll.pollActiveShipments' write call so the same guards apply:
// carrier API evidence, source 'carrier_poll', 0.95, delivered terminal.
import { Client } from "pg";
import { readFileSync } from "fs";
import { getTrackingStatus } from "../src/lib/carriers/tracking-service";
import { upsertShipmentEvidence } from "../src/lib/tracking/shipment-intelligence";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const trackings = ["520484904168", "520484904180", "520484902420"];

(async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    for (const t of trackings) {
        const r = await c.query(
            `select tracking_number, po_numbers, vendor_names, status_category, delivered_at
               from shipments where normalized_tracking_number = $1`,
            [t],
        );
        if (!r.rowCount) {
            console.log(`${t}: no PG row — skipped`);
            continue;
        }
        const s = r.rows[0];
        if (s.delivered_at) {
            console.log(`${t}: already delivered — skipped (terminal)`);
            continue;
        }
        const status = await getTrackingStatus(s.tracking_number);
        if (!status) {
            console.log(`${t}: carrier returned nothing — left as ${s.status_category}`);
            continue;
        }
        const delivered = status.category === "delivered" ? (status.delivered_at ?? new Date().toISOString()) : null;
        console.log(`${t}: carrier ${status.category} / ${status.display}${delivered ? ` / delivered ${delivered}` : ""}`);
        await upsertShipmentEvidence({
            trackingNumber: s.tracking_number,
            source: "carrier_poll",
            confidence: 0.95,
            statusCategory: (status.category ?? null) as any,
            statusDisplay: status.display ?? null,
            estimatedDeliveryAt: status.estimated_delivery_at ?? null,
            deliveredAt: delivered,
            poNumber: s.po_numbers?.[0] ?? null,
            vendorName: s.vendor_names?.[0] ?? null,
        });
        await new Promise((res) => setTimeout(res, 2000));
    }
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
