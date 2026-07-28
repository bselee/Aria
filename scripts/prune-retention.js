#!/usr/bin/env node
/**
 * @file     scripts/prune-retention.js
 * @purpose  Reclaim disk space from email_inbox_queue and cron_runs.
 *           Safe to run repeatedly — all operations are idempotent.
 *
 *           1. VACUUM FULL email_inbox_queue  (reclaims bloat: ~100 MB expected)
 *           2. VACUUM FULL cron_runs           (reclaims index/heap bloat)
 *           3. VACUUM ANALYZE both tables      (refresh planner stats)
 *           4. Print before/after size deltas
 *
 *           The retention deletion for cron_runs (>30 days) and the trigger
 *           that nulls bodies on terminal email status are set up in the
 *           migration file. This script focuses on VACUUM FULL + reporting.
 *
 *           Exit code:
 *             0 — success (even if 0 rows affected)
 *             non-zero — real DB error
 *
 * @author  Hermia
 * @created 2026-07-28
 * @deps    pg (already in node_modules)
 * @env     DATABASE_URL — full connection string (read from .env.local by the
 *          cron job). Falls back to the local aria DB with NO embedded
 *          credential; supply PGPASSWORD out of band for that path.
 *
 * USAGE:
 *   node --env-file=.env.local scripts/prune-retention.js
 *   # or explicitly:
 *   DATABASE_URL=postgresql://user:pass@host:5432/db node scripts/prune-retention.js
 */

const { Client } = require("pg");

// NOTE: never hardcode a password here — the repo is committed. DATABASE_URL
// comes from .env.local; the fallback is credential-free on purpose so a
// misconfigured env fails loudly at connect() instead of silently using a
// stale baked-in secret.
const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://aria@localhost:5432/aria";

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function getSizes(client) {
  const { rows } = await client.query(`
    SELECT
      relname,
      pg_total_relation_size(relid) AS total_bytes,
      pg_relation_size(relid)        AS heap_bytes,
      pg_size_pretty(pg_total_relation_size(relid)) AS total_pretty,
      n_live_tup                     AS row_count
    FROM pg_stat_user_tables
    WHERE relname IN ('email_inbox_queue', 'cron_runs')
    ORDER BY relname
  `);
  const map = {};
  for (const r of rows) map[r.relname] = r;
  return map;
}

async function main() {
  const client = new Client({ connectionString: CONNECTION });
  await client.connect();

  try {
    // ---- Measure BEFORE ----
    // ANALYZE first: pg_stat_user_tables.n_live_tup is an estimate refreshed by
    // (auto)analyze, and a stale one made the BEFORE report nonsense (137 rows
    // reported against an actual 126 322). Cheap on these table sizes.
    await client.query("ANALYZE public.email_inbox_queue");
    await client.query("ANALYZE public.cron_runs");

    console.log("=== BEFORE ===");
    const before = await getSizes(client);
    for (const [tbl, info] of Object.entries(before)) {
      console.log(
        `  ${tbl.padEnd(22)} ${info.row_count.toString().padStart(7)} rows  ` +
          `total=${info.total_pretty.padStart(8)}  heap=${fmt(Number(info.heap_bytes)).padStart(8)}`
      );
    }

    // ---- Run retention if migration hasn't been applied yet ----
    // Delete cron_runs older than 30 days (safe to run unconditionally)
    const delResult = await client.query(`
      DELETE FROM public.cron_runs
      WHERE started_at < NOW() - INTERVAL '30 days'
    `);
    console.log(`\n  cron_runs: deleted ${delResult.rowCount} rows older than 30 days`);

    // ---- VACUUM FULL — reclaims heap from bloat ----
    // VACUUM FULL acquires an ACCESS EXCLUSIVE lock — on a local dev DB
    // this is instant (< 1 s). On a production replica it would need a
    // maintenance window.
    console.log("\n  VACUUM FULL email_inbox_queue ...");
    await client.query("VACUUM FULL public.email_inbox_queue");
    console.log("  done.");

    console.log("  VACUUM FULL cron_runs ...");
    await client.query("VACUUM FULL public.cron_runs");
    console.log("  done.");

    // ---- VACUUM ANALYZE (updates pg_stat_user_tables for next getSizes) ----
    console.log("  VACUUM ANALYZE ...");
    await client.query("VACUUM ANALYZE public.email_inbox_queue");
    await client.query("VACUUM ANALYZE public.cron_runs");
    console.log("  done.\n");

    // ---- Measure AFTER ----
    console.log("=== AFTER ===");
    const after = await getSizes(client);
    for (const [tbl, info] of Object.entries(after)) {
      const b4 = before[tbl];
      const saved = Number(b4.heap_bytes) - Number(info.heap_bytes);
      console.log(
        `  ${tbl.padEnd(22)} ${info.row_count.toString().padStart(7)} rows  ` +
          `total=${info.total_pretty.padStart(8)}  heap=${fmt(Number(info.heap_bytes)).padStart(8)}  ` +
          `reclaimed=${fmt(saved)}`
      );
    }

    console.log("\n✓ prune-retention complete.");
    process.exit(0);
  } catch (err) {
    console.error("✗ prune-retention failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
