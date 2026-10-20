/**
 * @file    feed-fedex-freight-finals.ts
 * @purpose Glean the FedEx Freight FINAL invoice triples (account / invoice /
 *          amount) from the freight@ mailbox notice bodies and persist them to
 *          the fedex_freight_finals ledger — at arrival, before the ~6-week
 *          mailbox retention drops the notice. Only the three necessary fields
 *          are captured; nothing else.
 *
 *          Idempotent: re-running only inserts not-yet-captured invoices.
 *          Run directly, or via the fedex-freight-finals-feed cron.
 *
 * @usage   node --import tsx --env-file=.env.local src/cli/feed-fedex-freight-finals.ts
 *
 * @author  Hermia
 * @created 2026-10-20
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { captureFedexFreightFinals } from "../lib/freight/fedex-freight-final-feed";

async function main() {
    const inserted = await captureFedexFreightFinals();
    console.log(`[fedex-freight-finals] captured ${inserted} new final invoice(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
