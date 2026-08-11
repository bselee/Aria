#!/usr/bin/env node
/**
 * @file     scripts/prune-retention.js
 * @purpose  Reclaim disk space from email_inbox_queue and cron_runs.
 *           Safe to run repeatedly — all operations are idempotent.
 *
 *           1. Batched DELETE of cron_runs older than 14 days (PROGRESS BAR)
 *           2. Batched DELETE of email_inbox_queue older than 30 days (email retention)
 *           3. VACUUM FULL + ANALYZE both tables
 *           4. Print before/after size deltas
 *
 *           KAIZEN(2026-08-11): Switched from single DELETE to batched DELETE
 *           (5 000 rows per batch with 100 ms inter-batch pause) to avoid ETIMEDOUT
 *           on large tables. Retention window tightened from 30d to 14d for cron_runs.
 *
 *           Exit code:
 *             0 — success (even if 0 rows affected)
 *             non-zero — real DB error
 *
 * @author  Hermia / Aria Implementer
 * @created 2026-07-28, updated 2026-08-11
 * @deps    pg (already in node_modules)
 * @env     DATABASE_URL — full connection string (read from .env.local by the
 *          cron job). Falls back to the local aria DB with NO embedded
 *          credential; supply PGPASSWORD out of band for that path.
 *
 * USAGE:
 *   node --env-file=.env.local scripts/prune-retention.js
 *   # or explicitly:
 *   DATABASE_URL=postgresql://user:***@host:5432/db node scripts/prune-retention.js
 */

const { Client } = require("pg");

// NOTE: never hardcode a password here — the repo is committed. DATABASE_URL
// comes from .env.local; the fallback is credential-free on purpose so a
// misconfigured env fails loudly at connect() instead of silently using a
// stale baked-in secret.
const CONNECTION =
  process.env.DATABASE_URL ||
  "postgresql://aria@localhost:5432/aria";

/** Batch size for batched DELETE. Kept small enough to avoid long locks. */
const BATCH_SIZE = 5_000;

/** Millisecond pause between batches — gives Postgres a breath. */
const BATCH_PAUSE_MS = 100;

/** Retention threshold for cron_runs (retain 14 days). */
const CRON_RETENTION_DAYS = 14;

/** Retention threshold for email_inbox_queue (retain 30 days). */
const EMAIL_RETENTION_DAYS = 30;

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

/**
 * Batch-delete old rows from a table using a timestamp column.
 * Reports progress every batch so cron logs show liveness.
 */
async function batchedDelete(client, table, column, retentionDays, label) {
  const countRes = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM public.${table} WHERE ${column} < NOW() - INTERVAL '${retentionDays} days'`
  );
  const totalToDelete = Number(countRes.rows[0].cnt);

  console.log(`\n[${label}] ${totalToDelete} rows to delete (>${retentionDays}d old)`);

  if (totalToDelete === 0) {
    console.log(`[${label}] Nothing to prune.`);
    return 0;
  }

  let deleted = 0;
  let batch = 0;

  // Use a loop with LIMIT — each DELETE removes up to BATCH_SIZE rows
  // and the loop continues until 0 rows affected.
  while (true) {
    const delRes = await client.query(
      `DELETE FROM public.${table}
       WHERE id IN (
         SELECT id FROM public.${table}
         WHERE ${column} < NOW() - INTERVAL '${retentionDays} days'
         ORDER BY id
         LIMIT $1
       )`,
      [BATCH_SIZE]
    );

    const batchRows = delRes.rowCount ?? 0;
    if (batchRows === 0) break;

    deleted += batchRows;
    batch++;
    const pct = ((deleted / totalToDelete) * 100).toFixed(1);
    console.log(
      `[${label}] batch ${batch}: ${deleted}/${totalToDelete} (${pct}%) — ${batchRows} rows deleted`
    );

    if (batchRows < BATCH_SIZE) break; // last batch — fewer than limit
    await sleep(BATCH_PAUSE_MS);
  }

  console.log(`[${label}] Done: ${deleted} rows deleted.`);
  return deleted;
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

    // ---- Retention delete (batched) ----
    await batchedDelete(client, "cron_runs", "started_at", CRON_RETENTION_DAYS, "cron_runs");
    await batchedDelete(client, "email_inbox_queue", "created_at", EMAIL_RETENTION_DAYS, "email_inbox_queue");

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