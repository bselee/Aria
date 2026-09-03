/**
 * @file    snapshot-observer.ts
 * @purpose DB reliability guard #2: observe qty_recommendations persistence.
 *          If zero recommendation snapshots were written in the last 24 hours,
 *          the calibration engine is starved (or the writer is dead) — flag
 *          it so the cron layer can route a warning. A healthy system writes
 *          snapshots continuously (one per (product_id, vendor) per run).
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    pg (direct Client — plain count query, no PostgREST)
 * @env     DATABASE_URL (native Postgres 16 on :5432)
 */

import { Client } from "pg";

export interface SnapshotPersistenceResult {
    /** Rows written to qty_recommendations in the last 24 hours. */
    count24h: number;
    /** true when at least one snapshot row was written in the last 24h. */
    healthy: boolean;
}

/**
 * Count qty_recommendations rows written in the last 24 hours and report
 * whether persistence is healthy (n > 0).
 *
 * Never throws: connection/query failures log and return
 * { count24h: 0, healthy: false } — failing closed, so a DB outage also
 * surfaces as an integrity warning rather than being swallowed.
 *
 * @returns { count24h, healthy } — healthy iff count24h > 0.
 */
export async function checkSnapshotPersistence(): Promise<SnapshotPersistenceResult> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
        await client.connect();
        const res = await client.query(
            "SELECT count(*)::int AS n FROM qty_recommendations WHERE recommended_at >= now() - interval '24 hours'"
        );
        const n = Number(res.rows[0]?.n ?? 0);
        return { count24h: n, healthy: n > 0 };
    } catch (err: any) {
        console.error(`[snapshot-observer] count failed: ${err?.message ?? err}`);
        return { count24h: 0, healthy: false };
    } finally {
        try {
            await client.end();
        } catch {
            // Best-effort close — nothing to recover here.
        }
    }
}
