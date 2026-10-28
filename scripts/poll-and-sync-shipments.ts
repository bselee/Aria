// Poll specific trackings through the monotonic writer and mirror each into
// shipments_cache. Both steps are needed: the writer owns PG, the cache is what
// the dashboard renders, and the cache sync job cannot run while a cron lock is
// held by an orphan.
//
// Usage: node --import tsx --env-file=.env.local scripts/poll-and-sync-shipments.ts <tracking> [...]
import { Client } from "pg";
import { readFileSync } from "fs";
import { getTrackingStatus } from "../src/lib/carriers/tracking-service";
import { upsertShipmentEvidence } from "../src/lib/tracking/shipment-intelligence";
import { upsertTrackingLocal } from "../src/lib/storage/tracking-cache";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const trackings = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!trackings.length) {
    console.log("usage: <tracking> [...]");
    process.exit(0);
}

(async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();

    for (const t of trackings) {
        const r = await pg.query(
            `select tracking_number, po_numbers, vendor_names, status_category, delivered_at
               from shipments where normalized_tracking_number = $1`,
            [t],
        );
        if (!r.rowCount) {
            console.log(`${t}: no PG row — skipped (never create a shipment from a poll)`);
            continue;
        }
        const s = r.rows[0];

        if (!s.delivered_at) {
            const status = await getTrackingStatus(s.tracking_number);
            if (!status) {
                console.log(`${t}: carrier returned nothing — left as ${s.status_category}`);
            } else {
                const delivered =
                    status.category === "delivered" ? (status.delivered_at ?? new Date().toISOString()) : null;
                console.log(
                    `${t}: carrier ${status.category} / ${status.display}${delivered ? ` / delivered ${delivered}` : ""}`,
                );
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
            }
        } else {
            console.log(`${t}: already delivered ${s.delivered_at} — writer skipped (terminal)`);
        }

        // Mirror the row as it now stands in PG into the dashboard cache.
        const after = await pg.query(
            `select tracking_number, po_numbers, status_category, status_display,
                    estimated_delivery_at, delivered_at
               from shipments where normalized_tracking_number = $1`,
            [t],
        );
        const x = after.rows[0];
        const written = upsertTrackingLocal({
            trackingNumber: x.tracking_number,
            poNumbers: x.po_numbers ?? [],
            statusCategory: x.status_category ?? undefined,
            statusDisplay: x.status_display ?? undefined,
            estimatedDeliveryAt: x.estimated_delivery_at ? new Date(x.estimated_delivery_at).toISOString() : undefined,
            deliveredAt: x.delivered_at ? new Date(x.delivered_at).toISOString() : undefined,
        });
        console.log(`  cache: ${JSON.stringify(written)}`);
    }

    await pg.end();
})().catch((e) => console.error("ERR", e?.message || e));
