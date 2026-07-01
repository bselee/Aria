/**
 * @file    src/cli/email-tracking-ingest.ts
 * @purpose CLI entry point for email tracking ingest pipeline.
 *          Calls runEmailTrackingIngest() with proper env loading.
 * @author  Hermia
 * @created 2026-07-01 (replaced dead stub)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { runEmailTrackingIngest } from "../lib/tracking/email-tracking-ingest";

async function main() {
    console.log("[email-tracking-ingest] Starting Gmail scan for tracking numbers...");
    const results = await runEmailTrackingIngest();
    const totalNew = results.reduce((s, r) => s + r.newEmails, 0);
    const totalTracking = results.reduce((s, r) => s + r.trackingFound, 0);
    const totalUpserted = results.reduce((s, r) => s + r.upserted, 0);
    console.log(
        `[email-tracking-ingest] Done: ${results.length} accounts, ` +
        `${totalNew} new emails, ${totalTracking} w/ tracking, ${totalUpserted} upserted`
    );
    if (totalTracking === 0) {
        console.log("[email-tracking-ingest] No tracking numbers found — this is normal if no shipping confirmations arrived recently.");
    }
}

main().catch((err) => {
    console.error(`[email-tracking-ingest] Fatal: ${err.message}`);
    process.exit(1);
});
