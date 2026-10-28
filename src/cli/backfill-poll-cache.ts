/**
 * @file    src/cli/backfill-poll-cache.ts
 * @purpose One-time backfill: register every active non-delivered inbound
 *          shipment into the SQLite poll cache so the carrier loop starts
 *          polling it (2026-10-28). Dropship shipments (teammate's domain)
 *          are skipped. Idempotent — existing cache rows are untouched.
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/backfill-poll-cache.ts [--apply]
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/db, @/lib/storage/tracking-cache
 */
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local", quiet: true });

import { createClient } from "../lib/db";
import { registerTrackingForPolling, countActiveTrackings } from "../lib/storage/tracking-cache";

interface ShipRow {
    tracking_number: string | null;
    po_numbers: string[] | null;
    status_category: string | null;
    status_display: string | null;
    estimated_delivery_at: string | null;
    delivered_at: string | null;
}

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

async function main(): Promise<void> {
    const db = createClient();
    if (!db) {
        console.error("DB unavailable");
        process.exit(1);
    }

    const before = countActiveTrackings();
    let seen = 0;
    let candidates = 0;
    let registered = 0;
    let skippedDropship = 0;
    let offset = 0;

    for (;;) {
        const { data } = await db
            .from("shipments")
            .select("tracking_number, po_numbers, status_category, status_display, estimated_delivery_at, delivered_at")
            .eq("active", true)
            .is("delivered_at", null)
            .limit(PAGE)
            .offset(offset);
        const rows = (data || []) as ShipRow[];
        if (rows.length === 0) break;
        seen += rows.length;

        for (const row of rows) {
            if (!row.tracking_number) continue;
            const pos = row.po_numbers || [];
            // Dropships are a teammate's domain — never poll them.
            if (pos.length > 0 && pos.every((p) => /dropship/i.test(String(p)))) {
                skippedDropship++;
                continue;
            }
            if (row.status_category === "delivered") continue;
            candidates++;
            if (APPLY) {
                registerTrackingForPolling({
                    trackingNumber: row.tracking_number,
                    poNumbers: pos,
                    statusCategory: row.status_category,
                    statusDisplay: row.status_display,
                    estimatedDeliveryAt: row.estimated_delivery_at,
                });
                registered++;
            }
        }
        offset += PAGE;
    }

    const after = countActiveTrackings();
    console.log(`seen=${seen} candidates=${candidates} skippedDropship=${skippedDropship}`);
    console.log(
        APPLY
            ? `APPLIED: cache ${before} → ${after} active records (${registered} newly registered)`
            : "DRY RUN — pass --apply to register",
    );
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
