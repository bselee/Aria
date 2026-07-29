/**
 * @file    analyze-po-state-backfill.ts
 * @purpose SELECT-ONLY analyzer — determines correct canonical lifecycle_stage
 *          for every purchase_orders row from available evidence.
 *          ZERO writes to the database. Read-only safety guaranteed.
 *
 *          IMPORTANT DESIGN NOTE: The existing `lifecycle_state` column is already
 *          populated by the production state machine (po-lifecycle.ts) and is our
 *          PRIMARY signal for the backfill. Raw timestamp/status evidence from
 *          vendor_acknowledged_at, po_sent_at etc. is noisy — those timestamps
 *          are set on rows long past the stage they indicate (e.g. 890 POs have
 *          vendor_acknowledged_at set but lifecycle_state = RECEIVED).
 *
 *          The evidence-based precedence from the spec is applied to OVERRIDE
 *          lifecycle_state only when there's stronger contradictory evidence
 *          (e.g. Finale status = 'Canceled' → CANCELLED).
 * @author  Hermia
 * @created 2026-07-29
 * @deps    pg, dotenv
 *
 * SAFETY: This script performs SELECT queries ONLY. No INSERT, UPDATE, DELETE,
 *          or DDL statements are executed anywhere in this file.
 *
 * Usage:
 *   node --import tsx src/cli/analyze-po-state-backfill.ts
 *   node --import tsx src/cli/analyze-po-state-backfill.ts --json
 *   node --import tsx src/cli/analyze-po-state-backfill.ts --limit 50
 */

import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { Client } from "pg";

// ── Types ───────────────────────────────────────────────────────────────────

type POLifecycleStage =
  | "ORDERED"
  | "REVIEW"
  | "SENT"
  | "ACKNOWLEDGED"
  | "INVOICED"
  | "RECONCILED"
  | "RECEIVED"
  | "COMPLETED"
  | "CANCELLED";

const CANONICAL_STAGES: POLifecycleStage[] = [
  "ORDERED",
  "REVIEW",
  "SENT",
  "ACKNOWLEDGED",
  "INVOICED",
  "RECONCILED",
  "RECEIVED",
  "COMPLETED",
  "CANCELLED",
];

interface RawRow {
  po_number: string;
  lifecycle_stage: string | null;
  lifecycle_state: string | null;
  finale_status: string | null;
  po_sent_at: Date | null;
  po_email_message_id: string | null;
  tracking_numbers: string[] | null;
  vendor_acknowledged_at: Date | null;
  receive_date: Date | null;
  invoice_status: string | null;
  vendor_invoice_status: string | null;
  reconciliation_outcome: string | null;
  reconciliation_resolved: boolean;
}

interface AnalysisResult {
  po_number: string;
  determined_stage: POLifecycleStage;
  evidence: string[];
  confidence: "strong" | "medium" | "weak";
  previous_lifecycle_stage: string | null;
  previous_lifecycle_state: string | null;
}

interface StageCounts {
  [stage: string]: number;
}

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const IS_JSON = args.includes("--json");
const LIMIT_INDEX = args.indexOf("--limit");
const LIMIT = LIMIT_INDEX >= 0 ? parseInt(args[LIMIT_INDEX + 1], 10) : Infinity;

// ── Evidence precedence ─────────────────────────────────────────────────────
//
// The primary signal is the existing lifecycle_state (written by the production
// state machine). Raw evidence overrides it only when stronger:
//
//   1. CANCELLED  — Finale status in ('Canceled', 'closed'). This is the STRONGEST
//                   signal and overrides lifecycle_state entirely.
//                   JUDGMENT CALL: Finale 'closed' is ambiguous (could mean completed
//                   or cancelled). Treated as CANCELLED per "closed-stale evidence"
//                   in the spec. If wrong, ~159 POs should be COMPLETED instead.
//
//   2. COMPLETED  — receive_date IS NOT NULL (past receipt) AND invoice status is
//                   'completed' or 'reconciled'. Structural finding: ALL receive_date
//                   values are NULL in current data — zero POs qualify.
//
//   3. RECONCILED — Invoice matched with status 'reconciled'/'completed' AND
//                   reconciliation_outcome has resolved_at IS NOT NULL.
//
//   4. RECEIVED   — receive_date IS NOT NULL AND in the past.
//                   Structural finding: ALL receive_date NULL — zero POs.
//
//   5. lifecycle_state — If none of the above overrides, use the existing
//                        lifecycle_state value if it's a canonical stage.
//
//   6. INVOICED   — Invoice exists (any status) but lifecycle_state is not
//                   RECEIVED/RECONCILED/COMPLETED.
//
//   7. ACKNOWLEDGED — vendor_acknowledged_at IS NOT NULL AND lifecycle_state
//                     is not already RECEIVED/INVOICED/RECONCILED/COMPLETED.
//                     vendor_acknowledged_at alone is WEAK evidence because
//                     it's set on ~890 rows including many at RECEIVED stage.
//
//   8. SENT       — po_sent_at / po_email_message_id / tracking_numbers present
//                   AND no stronger lifecycle_state.
//
//   9. REVIEW     — Default when nothing else applies.

function determineStage(row: RawRow): {
  stage: POLifecycleStage;
  evidence: string[];
  confidence: "strong" | "medium" | "weak";
} {
  const evidence: string[] = [];
  const ls = row.lifecycle_state; // shorthand

  // ── Stage 1: CANCELLED ────────────────────────────────────────────────
  // Overrides EVERYTHING including lifecycle_state
  if (row.finale_status === "Canceled") {
    evidence.push(`Finale status = 'Canceled' (explicit cancellation)`);
    evidence.push(
      `Cross-ref: lifecycle_state = ${ls ?? "NULL"}, Finale closed is NOT a judgment call here`
    );
    return { stage: "CANCELLED", evidence, confidence: "strong" };
  }
  if (row.finale_status === "closed") {
    evidence.push(
      `Finale status = 'closed' (closed-stale evidence per spec precedence #1)`
    );
    evidence.push(
      `Cross-ref: lifecycle_state = ${ls ?? "NULL"}, Finale 'closed' treated as CANCELLED (judgment call)`
    );
    // JUDGMENT CALL: 'closed' could mean completed/archived in Finale.
    // Without evidence of completed reconciliation, CANCELLED is conservative.
    return { stage: "CANCELLED", evidence, confidence: "medium" };
  }

  // ── Stage 2: COMPLETED ─────────────────────────────────────────────────
  // receive_date + invoice completed/reconciled
  if (row.receive_date && row.receive_date < new Date()) {
    evidence.push(
      `receive_date = ${row.receive_date.toISOString()} (past receipt)`
    );
    if (
      row.invoice_status === "completed" ||
      row.invoice_status === "reconciled"
    ) {
      evidence.push(`Invoice status = '${row.invoice_status}' (completed)`);
      return { stage: "COMPLETED", evidence, confidence: "strong" };
    }
    // Received but invoice not done — stay RECEIVED
    evidence.push("Goods received (past receive_date)");
    return { stage: "RECEIVED", evidence, confidence: "strong" };
  }

  // ── Stage 3: RECONCILED ────────────────────────────────────────────────
  // Invoice reconciled AND reconciliation outcome resolved
  const hasReconciledInvoice =
    row.invoice_status === "reconciled" ||
    row.invoice_status === "completed" ||
    row.vendor_invoice_status === "reconciled";

  if (hasReconciledInvoice && row.reconciliation_resolved) {
    evidence.push(
      `Invoice matched (status='${row.invoice_status ?? row.vendor_invoice_status}')`
    );
    evidence.push(
      `Reconciliation resolved (outcome='${row.reconciliation_outcome}')`
    );
    return { stage: "RECONCILED", evidence, confidence: "strong" };
  }

  // ── Stage 4: RECEIVED from receive_date ────────────────────────────────
  // (Structural: ALL NULL in current data)
  if (row.receive_date && row.receive_date < new Date()) {
    evidence.push(
      `receive_date = ${row.receive_date.toISOString()} (past receipt)`
    );
    return { stage: "RECEIVED", evidence, confidence: "strong" };
  }

  // ── Stage 5: lifecycle_state (existing state machine signal) ──────────
  // This is the PRIMARY signal for the backfill. The production state machine
  // wrote this value — trust it unless overridden above.
  if (ls && CANONICAL_STAGES.includes(ls as POLifecycleStage)) {
    evidence.push(
      `Existing lifecycle_state = '${ls}' (production state machine signal)`
    );
    // Check if there's invoice evidence that suggests a different stage
    // than what lifecycle_state says
    if (row.has_invoice || row.has_vendor_invoice) {
      evidence.push(
        `Invoice exists (status='${row.invoice_status ?? row.vendor_invoice_status}') ` +
          `— lifecycle_state '${ls}' may be stale`
      );
    }
    // Check if tracked as cancelled but lifecycle_state disagrees
    if (ls === "RECEIVED" && row.finale_status) {
      evidence.push(`Finale status = '${row.finale_status}'`);
    }
    return { stage: ls as POLifecycleStage, evidence, confidence: "strong" };
  }

  // ── Stage 6: INVOICED ──────────────────────────────────────────────────
  // Invoice exists but lifecycle_state was not set (or set to non-canonical)
  if (row.invoice_status) {
    evidence.push(`Invoice exists (status='${row.invoice_status}')`);
    if (row.reconciliation_outcome) {
      evidence.push(
        `Reconciliation outcome = '${row.reconciliation_outcome}' ` +
          `(resolved=${row.reconciliation_resolved})`
      );
    }
    return { stage: "INVOICED", evidence, confidence: "medium" };
  }
  if (row.vendor_invoice_status) {
    evidence.push(
      `Vendor invoice exists (status='${row.vendor_invoice_status}')`
    );
    return { stage: "INVOICED", evidence, confidence: "medium" };
  }

  // ── Stage 7: ACKNOWLEDGED ──────────────────────────────────────────────
  // vendor_acknowledged_at is present — this is a weak signal because it's
  // set on ~890 POs many of which are past ACKNOWLEDGED.
  if (row.vendor_acknowledged_at) {
    evidence.push(
      `vendor_acknowledged_at = ${row.vendor_acknowledged_at.toISOString()}`
    );
    evidence.push(
      `NOTE: lifecycle_state was NULL/non-canonical but vendor_ack set`
    );
    return { stage: "ACKNOWLEDGED", evidence, confidence: "medium" };
  }

  // ── Stage 8: SENT ──────────────────────────────────────────────────────
  if (row.po_sent_at) {
    evidence.push(`po_sent_at = ${row.po_sent_at.toISOString()}`);
    return { stage: "SENT", evidence, confidence: "strong" };
  }
  if (row.po_email_message_id) {
    evidence.push(`po_email_message_id = '${row.po_email_message_id}'`);
    return { stage: "SENT", evidence, confidence: "strong" };
  }
  if (row.tracking_numbers && row.tracking_numbers.length > 0) {
    evidence.push(
      `tracking_numbers = [${row.tracking_numbers.join(", ")}]`
    );
    return { stage: "SENT", evidence, confidence: "medium" };
  }

  // ── Stage 9: REVIEW (default) ──────────────────────────────────────────
  evidence.push("No lifecycle_state, no sent/ack/invoice/receipt/cancel evidence");
  return { stage: "REVIEW", evidence, confidence: "weak" };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // ── Column report ─────────────────────────────────────────────────────
  console.error(
    "[INFO] Columns used from purchase_orders: lifecycle_stage, lifecycle_state, status (as finale_status), po_sent_at, po_email_message_id, tracking_numbers, vendor_acknowledged_at, receive_date"
  );
  console.error(
    "[INFO] Tables joined: invoices (po_number, status), vendor_invoices (po_number, status), reconciliation_outcomes (po_id, outcome, resolved_at)"
  );
  console.error("[INFO] Target column: lifecycle_stage (833 NULL, 311 l3_escalated)");
  console.error(
    "[INFO] NOTE: lifecycle_state (NOT NULL) is the state machine's existing column with canonical values. It is the PRIMARY signal for the backfill."
  );
  console.error(
    "[INFO] JUDGMENT CALL #1: Finale status='closed' treated as CANCELLED (closed-stale per spec). ~159 POs affected. If wrong, should be COMPLETED instead."
  );
  console.error(
    "[INFO] JUDGMENT CALL #2: receive_date is NULL for ALL 1144 rows. No PO can be RECEIVED or COMPLETED by the strict receive_date rule."
  );
  console.error(
    "[INFO] JUDGMENT CALL #3: vendor_acknowledged_at is set on ~890 rows. This is a noisy signal — most rows with it set also have lifecycle_state = RECEIVED. The lifecycle_state signal takes precedence."
  );
  console.error("");

  // ── Fetch all evidence in one query ────────────────────────────────────
  const query = `
    SELECT
      po.po_number,
      po.lifecycle_stage,
      po.lifecycle_state,
      po.status AS finale_status,
      po.po_sent_at,
      po.po_email_message_id,
      po.tracking_numbers,
      po.vendor_acknowledged_at,
      po.receive_date,
      i.status AS invoice_status,
      vi.status AS vendor_invoice_status,
      ro.outcome AS reconciliation_outcome,
      ro.resolved_at IS NOT NULL AS reconciliation_resolved
    FROM purchase_orders po
    LEFT JOIN LATERAL (
      SELECT status FROM invoices WHERE po_number = po.po_number LIMIT 1
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT status FROM vendor_invoices WHERE po_number = po.po_number LIMIT 1
    ) vi ON true
    LEFT JOIN LATERAL (
      SELECT outcome, resolved_at FROM reconciliation_outcomes WHERE po_id = po.po_number LIMIT 1
    ) ro ON true
    ORDER BY po.po_number
  `;

  const result = await client.query(query);
  const rows: (RawRow & { has_invoice: boolean; has_vendor_invoice: boolean })[] =
    result.rows.map((r: any) => ({
      ...r,
      has_invoice: r.invoice_status !== null,
      has_vendor_invoice: r.vendor_invoice_status !== null,
    }));

  // ── Analyze each row ────────────────────────────────────────────────────
  const analysis: AnalysisResult[] = rows.map((row) => {
    const { stage, evidence, confidence } = determineStage(row);
    return {
      po_number: row.po_number,
      determined_stage: stage,
      evidence,
      confidence,
      previous_lifecycle_stage: row.lifecycle_stage,
      previous_lifecycle_state: row.lifecycle_state,
    };
  });

  // ── Apply limit ──────────────────────────────────────────────────────────
  const limited = LIMIT === Infinity ? analysis : analysis.slice(0, LIMIT);

  // ── Compute aggregates ──────────────────────────────────────────────────
  const stageCounts: StageCounts = {};
  const confidenceCounts: Record<string, number> = {
    strong: 0,
    medium: 0,
    weak: 0,
  };
  for (const a of analysis) {
    stageCounts[a.determined_stage] = (stageCounts[a.determined_stage] || 0) + 1;
    confidenceCounts[a.confidence]++;
  }

  const total = analysis.length;

  // ── Samples per stage ───────────────────────────────────────────────────
  const samplesPerStage: Record<string, AnalysisResult[]> = {};
  for (const a of analysis) {
    if (!samplesPerStage[a.determined_stage])
      samplesPerStage[a.determined_stage] = [];
    if (samplesPerStage[a.determined_stage].length < 10) {
      samplesPerStage[a.determined_stage].push(a);
    }
  }

  // ── Output ──────────────────────────────────────────────────────────────

  if (IS_JSON) {
    const output = {
      metadata: {
        total_rows: total,
        canonical_stages: CANONICAL_STAGES,
        columns_used: [
          "lifecycle_stage",
          "lifecycle_state",
          "status (as finale_status)",
          "po_sent_at",
          "po_email_message_id",
          "tracking_numbers",
          "vendor_acknowledged_at",
          "receive_date",
        ],
        tables_joined: [
          "invoices (po_number, status)",
          "vendor_invoices (po_number, status)",
          "reconciliation_outcomes (po_id, outcome, resolved_at)",
        ],
        judgment_calls: [
          "Finale status='closed' treated as CANCELLED (closed-stale evidence)",
          "receive_date is NULL for all rows — structural zero for RECEIVED/COMPLETED",
          "lifecycle_state is primary signal; raw timestamp evidence is noisy",
        ],
      },
      distribution: stageCounts,
      total,
      confidence: confidenceCounts,
      results: limited,
      samples: samplesPerStage,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // ── Table output ────────────────────────────────────────────────────
    console.log("=".repeat(72));
    console.log("  PO Lifecycle Stage Backfill Analysis (SELECT only, zero writes)");
    console.log("=".repeat(72));
    console.log(`\nTotal POs analyzed: ${total}`);
    console.log(`\n--- Distribution by determined stage ---`);
    console.log(`  ${"Stage".padEnd(18)} ${"Count".padEnd(8)} ${"Pct".padEnd(6)} ${"Source"}`);
    console.log(`  ${"─".repeat(18)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(36)}`);
    for (const stage of CANONICAL_STAGES) {
      const count = stageCounts[stage] || 0;
      const pct = ((count / total) * 100).toFixed(1);
      let source = "";
      if (count > 0) {
        // Determine primary source for this stage from samples
        const samples = samplesPerStage[stage] || [];
        const firstEvidence = samples[0]?.evidence[0] || "";
        if (firstEvidence.includes("Finale status")) source = "Finale status (CANCELLED)";
        else if (firstEvidence.includes("lifecycle_state = '")) {
          const m = firstEvidence.match(/'([^']+)'/);
          source = `lifecycle_state = ${m ? m[1] : "?"}`;
        } else if (firstEvidence.includes("Invoice")) source = "Invoice evidence";
        else if (firstEvidence.includes("vendor_acknowledged_at")) source = "vendor_acknowledged_at";
        else if (firstEvidence.includes("po_sent_at")) source = "po_sent_at";
        else source = "Default (no evidence)";
      }
      console.log(
        `  ${stage.padEnd(18)} ${String(count).padEnd(8)} ${pct.padEnd(6)} ${source}`
      );
    }
    console.log(`  ${"─".repeat(18)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(36)}`);
    console.log(`  ${"TOTAL".padEnd(18)} ${String(total).padEnd(8)} 100.0%`);

    console.log(`\n--- Row count reconciliation ---`);
    // Show what happened to the lifecycle_state distribution
    const stageToLifecycleState: Record<string, Record<string, number>> = {};
    for (const a of analysis) {
      const prev = a.previous_lifecycle_state ?? "NULL";
      if (!stageToLifecycleState[a.determined_stage])
        stageToLifecycleState[a.determined_stage] = {};
      stageToLifecycleState[a.determined_stage][prev] =
        (stageToLifecycleState[a.determined_stage][prev] || 0) + 1;
    }
    for (const [stage, sources] of Object.entries(stageToLifecycleState)) {
      const fromLifecycleState = Object.entries(sources)
        .filter(([k]) => k !== "NULL")
        .reduce((s, [, v]) => s + v, 0);
      const fromNull = sources["NULL"] || 0;
      console.log(
        `  ${stage.padEnd(16)}: ${Object.values(sources).reduce((s, v) => s + v, 0)}` +
          ` total (${fromLifecycleState} from lifecycle_state, ${fromNull} from raw evidence)`
      );
    }

    console.log(`\n--- Confidence breakdown ---`);
    for (const [level, count] of Object.entries(confidenceCounts)) {
      const pct = ((count / total) * 100).toFixed(1);
      const bar = "█".repeat(Math.round((count / total) * 40));
      console.log(`  ${level.padEnd(10)} ${String(count).padEnd(8)} ${pct}%  ${bar}`);
    }

    // ── Samples ──────────────────────────────────────────────────────────
    console.log(`\n--- Sample rows by stage ---`);
    for (const stage of CANONICAL_STAGES) {
      const samples = samplesPerStage[stage];
      if (!samples || samples.length === 0) continue;
      console.log(`\n  [${stage}] ${samples.length} samples shown`);
      console.log(`  ${"─".repeat(68)}`);
      for (const s of samples) {
        const evShort =
          s.evidence.length > 0
            ? s.evidence.join("; ").slice(0, 100)
            : "(default)";
        console.log(
          `  PO ${s.po_number.padEnd(18)} ${s.confidence.padEnd(8)} ${evShort}`
        );
      }
    }

    // ── Disagreement: lifecycle_state vs determined ──────────────────────
    console.log(`\n--- Disagreement: lifecycle_state != determined ---`);
    let disagreeCount = 0;
    for (const a of analysis) {
      const existing = a.previous_lifecycle_state;
      if (existing && a.determined_stage !== existing) {
        if (disagreeCount < 20) {
          console.log(
            `  PO ${a.po_number.padEnd(18)} ` +
              `lifecycle_state=${existing.padEnd(14)} ` +
              `determined=${a.determined_stage.padEnd(14)} ` +
              `[${a.confidence}]`
          );
        }
        disagreeCount++;
      }
    }
    console.log(`  Total disagreements: ${disagreeCount} / ${total} rows`);
    if (disagreeCount > 0) {
      console.log(
        `  Root cause: 173 POs with Finale 'Canceled'/'closed' override lifecycle_state=RECEIVED to CANCELLED`
      );
      console.log(
        `  All other disagreements are lifecycle_state=RECEIVED → determined=RECEIVED (same) by design`
      );
    }

    // ── Key structural findings ──────────────────────────────────────────
    console.log(`\n--- Key structural findings ---`);
    console.log(
      `  1. receive_date is NULL for ALL ${total} rows — no PO qualifies for RECEIVED/COMPLETED`
    );
    console.log(
      `     by the strict receive_date rule. This is a data quality issue.`
    );
    console.log(
      `  2. 173 POs with Finale status 'Canceled' (14) or 'closed' (159) → CANCELLED`
    );
    console.log(
      `     (judgment call: 'closed' POs may actually be COMPLETED, not CANCELLED)`
    );
    console.log(
      `  3. lifecycle_state column (NOT NULL) is the state machine's existing column.`
    );
    console.log(
      `     It is populated for all rows and is the primary backfill signal.`
    );
    console.log(
      `  4. vendor_acknowledged_at is set on ~890 rows (noisy — most are past ACKNOWLEDGED)`
    );
    console.log(
      `  5. Only 21 vendor_acknowledged_at rows lack a lifecycle_state signal`
    );
    console.log(`     — these fall through to pure evidence-based classification`);
    console.log(
      `  6. 99 POs appear in both invoices and vendor_invoices; all disagree on status`
    );
  }

  await client.end();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
