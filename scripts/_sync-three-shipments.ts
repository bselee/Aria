// Populate shipments_cache for three rows that exist in PG but never reached the
// local cache (the sync job is behind the cron lock). Uses the app's own writer so
// the cache row has exactly the shape the dashboard expects.
import { Client } from "pg";
import { readFileSync } from "fs";
import { upsertTrackingLocal } from "../src/lib/storage/tracking-cache";

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
            `select tracking_number, po_numbers, status_category, status_display,
                    estimated_delivery_at, delivered_at
               from shipments where normalized_tracking_number = $1`,
            [t],
        );
        if (!r.rowCount) {
            console.log(`${t}: NO PG ROW — skipped`);
            continue;
        }
        const x = r.rows[0];
        const written = upsertTrackingLocal({
            trackingNumber: x.tracking_number,
            poNumbers: x.po_numbers ?? [],
            statusCategory: x.status_category ?? undefined,
            statusDisplay: x.status_display ?? undefined,
            estimatedDeliveryAt: x.estimated_delivery_at ? new Date(x.estimated_delivery_at).toISOString() : undefined,
            deliveredAt: x.delivered_at ? new Date(x.delivered_at).toISOString() : undefined,
        });
        console.log(`${t} -> cached ${JSON.stringify(written)}`);
    }
    await c.end();
})().catch((e) => console.error("ERR", e?.message || e));
