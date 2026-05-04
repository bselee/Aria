/**
 * @file    backfill-reconciliation-outcomes.ts
 * @purpose One-shot backfill: reads ap_activity_log rows from the last N days
 *          and synthesizes corresponding reconciliation_outcomes rows.
 *
 * @usage
 *   node --import tsx src/cli/backfill-reconciliation-outcomes.ts           # dry-run (default)
 *   node --import tsx src/cli/backfill-reconciliation-outcomes.ts --live    # write rows
 *   node --import tsx src/cli/backfill-reconciliation-outcomes.ts --days 180
 *
 * Idempotent: each source row maps to a deterministic run_id derived from
 * the ap_activity_log UUID. Re-running produces no duplicates.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createHash } from "crypto";
import { createClient } from "../lib/supabase";

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--live");
const DAYS_BACK = (() => {
  const idx = args.indexOf("--days");
  if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return 90;
})();

// ─── Outcome mapping ──────────────────────────────────────────────────────────
//
// Derived by inspecting actual ap_activity_log data. Only rows that map to one
// of the 8 allowed outcomes are inserted; everything else is skipped.
//
// Allowed outcomes:
//   auto_applied | pending_approval | approved_by_user | rejected_by_user |
//   expired | match_failed | rejected_10x | rejected_invariant

type Outcome =
  | "auto_applied"
  | "pending_approval"
  | "approved_by_user"
  | "rejected_by_user"
  | "expired"
  | "match_failed"
  | "rejected_10x"
  | "rejected_invariant";

/** Returns the outcome or null if this row should be skipped. */
function mapOutcome(actionTaken: string): Outcome | null {
  const a = actionTaken.toLowerCase();

  // "Auto-applied: N changes, N skipped" — reconciler ran and committed changes
  if (/^auto-applied:/.test(a)) return "auto_applied";

  // "Manual run applied: N changes, N skipped" — same semantics, manually triggered
  if (/^manual run applied:/.test(a)) return "auto_applied";

  // "Dashboard approved: N applied, N skipped" — Will clicked Approve on the dashboard
  if (/^dashboard approved:/.test(a)) return "approved_by_user";

  // "Dashboard review required - awaiting approval" — pending_approval (not yet resolved)
  if (/^dashboard review required/.test(a)) return "pending_approval";

  // "No PO match, vendor not found in Finale" — failed to match invoice to any PO
  if (/^no po match/.test(a)) return "match_failed";

  // "Matched to PO #XXXXX" only (no reconciliation action taken beyond match)
  // These rows represent match + forward but no recon write — skip them.
  // We don't have enough info to infer outcome from just a match line.
  // (reconciliation outcomes for these show up as Auto-applied or Dashboard rows)
  if (/^matched to po #/.test(a)) return null;

  // No 10x or invariant rejections were found in the actual data (the "Blocked:"
  // rows are email-level blocks, not reconciliation guardrails). Skip them.

  return null;
}

/**
 * Deterministic run_id: UUIDv4-formatted SHA-256 hash of the source PK.
 * Rerunning on the same source row always produces the same run_id.
 */
function deterministicRunId(sourceId: string): string {
  const hash = createHash("sha256")
    .update(`aria-backfill-recon:${sourceId}`)
    .digest("hex");
  // Format as UUID: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join("-");
}

// ─── Row type from ap_activity_log ───────────────────────────────────────────
interface ActivityRow {
  id: string;
  created_at: string;
  email_from: string | null;
  intent: string;
  action_taken: string;
  metadata: Record<string, unknown> | null;
  reconciliation_report: Record<string, unknown> | null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== backfill-reconciliation-outcomes ===`);
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE"}`);
  console.log(`Window: last ${DAYS_BACK} days\n`);

  const supabase = createClient();
  if (!supabase) {
    console.error("ERROR: Supabase client unavailable — check env vars");
    process.exit(1);
  }

  // ── 1. Fetch source rows (paginated — Supabase default max is 1000/page) ──
  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString();
  const PAGE_SIZE = 1000;
  const sourceRows: ActivityRow[] = [];
  let pageOffset = 0;

  while (true) {
    const { data: rows, error: fetchErr } = await supabase
      .from("ap_activity_log")
      .select(
        "id, created_at, email_from, intent, action_taken, metadata, reconciliation_report"
      )
      .gte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .range(pageOffset, pageOffset + PAGE_SIZE - 1);

    if (fetchErr) {
      console.error("ERROR fetching ap_activity_log:", fetchErr.message);
      process.exit(1);
    }

    const page = (rows ?? []) as ActivityRow[];
    sourceRows.push(...page);
    if (page.length < PAGE_SIZE) break;
    pageOffset += PAGE_SIZE;
  }
  console.log(`Source rows fetched: ${sourceRows.length}`);

  // ── 2. Map rows to outcomes ───────────────────────────────────────────────
  const mappingBreakdown: Record<string, number> = {};
  const skippedBreakdown: Record<string, number> = {};

  type OutcomeRow = {
    run_id: string;
    invoice_id: string | null;
    po_id: string | null;
    vendor_name: string | null;
    outcome: Outcome;
    outcome_meta: Record<string, unknown>;
    duration_ms: null;
    created_at: string;
    resolved_at: string | null;
    _source_id: string; // used for idempotency check, not inserted
  };

  const mapped: OutcomeRow[] = [];

  for (const row of sourceRows) {
    const outcome = mapOutcome(row.action_taken);

    if (outcome === null) {
      // Track what we're skipping
      const key = row.action_taken.length > 80
        ? row.action_taken.slice(0, 80) + "…"
        : row.action_taken;
      skippedBreakdown[key] = (skippedBreakdown[key] ?? 0) + 1;
      continue;
    }

    // Track mapping stats
    mappingBreakdown[outcome] = (mappingBreakdown[outcome] ?? 0) + 1;

    const meta = row.metadata ?? {};
    const vendorName =
      (meta.vendorName as string) ?? row.email_from ?? null;
    const invoiceNumber = (meta.invoiceNumber as string) ?? null;
    const orderId = (meta.orderId as string) ?? null;

    // Terminal-on-write outcomes get resolved_at = created_at
    const isTerminal =
      outcome === "auto_applied" ||
      outcome === "match_failed" ||
      outcome === "rejected_10x" ||
      outcome === "rejected_invariant" ||
      outcome === "approved_by_user" ||
      outcome === "rejected_by_user";

    mapped.push({
      run_id: deterministicRunId(row.id),
      invoice_id: invoiceNumber,
      po_id: orderId,
      vendor_name: vendorName,
      outcome,
      outcome_meta: {
        source_action_taken: row.action_taken,
        source_intent: row.intent,
        source_id: row.id,
        ...(meta.confidence !== undefined && { confidence: meta.confidence }),
        ...(meta.totalDollarImpact !== undefined && {
          total_dollar_impact: meta.totalDollarImpact,
        }),
        ...(meta.overallVerdict !== undefined && {
          overall_verdict: meta.overallVerdict,
        }),
      },
      duration_ms: null,
      created_at: row.created_at,
      resolved_at: isTerminal ? row.created_at : null,
      _source_id: row.id,
    });
  }

  // ── 3. Print mapping breakdown ────────────────────────────────────────────
  console.log("\nMapping breakdown:");
  for (const [outcome, count] of Object.entries(mappingBreakdown).sort()) {
    console.log(`  ${outcome}: ${count}`);
  }

  const totalMapped = mapped.length;
  const totalSkipped = sourceRows.length - totalMapped;
  console.log(`  (skipped / no outcome): ${totalSkipped}`);

  if (Object.keys(skippedBreakdown).length > 0) {
    console.log("\nSkipped action_taken breakdown:");
    const sorted = Object.entries(skippedBreakdown).sort((a, b) => b[1] - a[1]);
    for (const [key, cnt] of sorted) {
      console.log(`  [${cnt}] ${key}`);
    }
  }

  console.log(`\nTotal would-insert: ${totalMapped}`);

  if (DRY_RUN) {
    console.log("\n[DRY-RUN] No rows written. Pass --live to actually insert.");
    return;
  }

  // ── 4. Idempotency check + insert ─────────────────────────────────────────
  const runIds = mapped.map((r) => r.run_id);

  // Fetch already-existing run_ids in one query
  const { data: existing, error: existErr } = await supabase
    .from("reconciliation_outcomes")
    .select("run_id")
    .in("run_id", runIds);

  if (existErr) {
    console.error("ERROR checking existing run_ids:", existErr.message);
    process.exit(1);
  }

  const existingSet = new Set((existing ?? []).map((r: { run_id: string }) => r.run_id));
  const toInsert = mapped.filter((r) => !existingSet.has(r.run_id));
  const alreadyDone = mapped.length - toInsert.length;

  console.log(`\nIdempotency: ${alreadyDone} already backfilled, ${toInsert.length} to insert`);

  if (toInsert.length === 0) {
    console.log("Nothing new to insert — already up to date.");
    return;
  }

  // Strip _source_id before inserting
  const insertPayload = toInsert.map(({ _source_id: _, ...rest }) => rest);

  // Insert in batches of 100
  const BATCH = 100;
  let insertedTotal = 0;
  for (let i = 0; i < insertPayload.length; i += BATCH) {
    const batch = insertPayload.slice(i, i + BATCH);
    const { error: insErr } = await supabase
      .from("reconciliation_outcomes")
      .insert(batch);

    if (insErr) {
      console.error(`ERROR inserting batch starting at ${i}:`, insErr.message);
      process.exit(1);
    }
    insertedTotal += batch.length;
    process.stdout.write(`  Inserted ${insertedTotal}/${toInsert.length}...\r`);
  }

  console.log(`\nInserted: ${insertedTotal} rows`);

  // ── 5. Sanity query ───────────────────────────────────────────────────────
  const { data: summary, error: sumErr } = await supabase
    .from("reconciliation_outcomes")
    .select("outcome")
    .order("outcome");

  if (sumErr) {
    console.error("ERROR reading sanity summary:", sumErr.message);
    return;
  }

  const tally: Record<string, number> = {};
  for (const row of summary ?? []) {
    tally[row.outcome] = (tally[row.outcome] ?? 0) + 1;
  }

  console.log("\nreconciliation_outcomes totals (all rows in table):");
  for (const [outcome, count] of Object.entries(tally).sort()) {
    console.log(`  ${outcome}: ${count}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
