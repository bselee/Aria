/**
 * @file    src/cli/sync-bag-artwork.ts
 * @purpose CLI for the bag artwork repository sync (Phase 2). Defaults to a
 *          dry run (export + diff, no writes); --live applies schema,
 *          row upserts, transition events, BOM link discovery, and
 *          completion alerts to local Postgres.
 * @author  Hermia
 * @created 2026-10-28
 * @deps    ../lib/artwork/bag-artwork-sync, ../lib/artwork/schema
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, DATABASE_URL, PGRST_URL
 *
 * Usage:
 *   node --import tsx src/cli/sync-bag-artwork.ts          # dry run
 *   node --import tsx src/cli/sync-bag-artwork.ts --live   # write to Postgres
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { syncBagArtwork } from '../lib/artwork/bag-artwork-sync';
import { closeBagArtworkPool } from '../lib/artwork/schema';

(async () => {
    const live = process.argv.includes('--live');
    try {
        const result = await syncBagArtwork({ live });
        console.log(`\n${live ? 'LIVE' : 'DRY-RUN'} sync complete.`);
        console.log(`rows: ${result.rows}`);
        if (result.events.length > 0) {
            console.log('events:');
            for (const e of result.events) {
                console.log(`  - ${e.kind.padEnd(12)} ${e.artworkSku.padEnd(14)} ${e.fromTab ?? ''} -> ${e.toTab ?? ''}${e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? ` (status ${e.fromStatus} -> ${e.toStatus})` : ''}`);
            }
        } else {
            console.log('events: none (no change since last sync)');
        }
        if (result.links.length > 0) {
            console.log(`links: ${result.links.length}`);
            for (const l of result.links) console.log(`  - ${l.componentSku.padEnd(14)} <- ${l.artworkSku.padEnd(14)} [${l.source}]`);
        }
        if (result.alerts.length > 0) {
            console.log(`alerts: ${result.alerts.length}`);
            for (const a of result.alerts) console.log(`  - ${a.componentSku} (${a.artworkSku}) runway ${a.runwayDays}d`);
        }
        if (result.unlinked.length > 0) {
            console.log(`unlinked after seed+BOM: ${result.unlinked.join(', ')}`);
        }
        if (result.orphans.length > 0) {
            console.log(`orphan rows (no SKU): ${result.orphans.join(' ; ')}`);
        }
        if (live) console.log('\n✅ wrote bag_artwork rows to Postgres');
        else console.log('\nℹ️ dry run — pass --live to write to Postgres');
        process.exit(0);
    } catch (err: unknown) {
        console.error('❌ sync failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
    } finally {
        await closeBagArtworkPool().catch(() => undefined);
    }
})();
