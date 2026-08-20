/**
 * @file    src/lib/intelligence/monday-briefing.ts
 * @purpose Monday morning status overview email. Reports on last week's
 *          receivings (PO_RECEIVED activity), invoice-PO matches completed
 *          (RECONCILIATION_AUTO_APPLIED / RECONCILIATION resolved verdicts),
 *          and PO spend created last week (Finale orderDate). Also surfaces
 *          overdue build-risk items and pending asks.
 *          Sends clean, actionable text email to Bill.
 * @author  Hermia
 * @created 2026-06-15
 * @updated 2026-07-27 — Rewrite (Kaizen): receivings/matching framing
 *          replaces raw invoice-total dump per Bill's direction. Also fixes
 *          the underlying zombie-process duplicate-send bug (see
 *          shutdown-guard.ts + start-bot.ts PID guard).
 * @deps    @/lib/db, @/lib/gmail/send-email, @/lib/finale/client
 * @env     SUPABASE_*, GMAIL OAuth (default slot)
 */

import { createClient } from "../db";
import { sendTextOnlyGmailEmail } from "../gmail/send-email";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ReceivingSummary {
  count: number;
  totalValue: number;
  rows: Array<{ poId: string; supplier: string; total: number }>;
}

interface MatchSummary {
  autoApplied: number;
  noChangeMatches: number;
  blocked: number;
  errors: number;
  rows: Array<{ orderId: string; invoiceNumber: string; vendorName: string; verdict: string }>;
}

interface PoSpendSummary {
  count: number;
  totalValue: number;
  rows: Array<{ orderId: string; supplier: string; total: number; orderDate: string }>;
}

interface UpcomingNeed {
  sku: string;
  reason: string;
  suggestedQty?: number;
  vendor?: string;
  dueBy?: string;
  risk?: string;
  overdueDays?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers — "last week" = previous Mon-Fri (business week), not rolling 7d
// ─────────────────────────────────────────────────────────────────────────────

/** Returns [mondayIso, fridayIso] for the ISO week immediately before today's week. */
function getPreviousBusinessWeek(today: Date): { start: string; end: string } {
  const day = today.getDay(); // 0=Sun..6=Sat
  // Days back to *this* week's Monday, then subtract 7 more for last week's Monday.
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - daysSinceMonday);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);

  const lastFriday = new Date(lastMonday);
  lastFriday.setDate(lastMonday.getDate() + 4);
  // End-of-day boundary for the Friday cutoff
  lastFriday.setHours(23, 59, 59, 999);

  return {
    start: lastMonday.toISOString().slice(0, 10),
    end: lastFriday.toISOString().slice(0, 10),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Collectors
// ─────────────────────────────────────────────────────────────────────────────

/** POs received (ap_activity_log intent=PO_RECEIVED) in the previous business week. */
async function getLastWeekReceivings(db: any, weekStart: string, weekEnd: string): Promise<ReceivingSummary> {
  const { data, error } = await db
    .from("ap_activity_log")
    .select("metadata, created_at")
    .eq("intent", "PO_RECEIVED")
    .gte("created_at", `${weekStart}T00:00:00Z`)
    .lte("created_at", `${weekEnd}T23:59:59Z`)
    .order("created_at", { ascending: false });

  if (error || !data) {
    console.warn("[monday-briefing] receivings query failed:", error?.message);
    return { count: 0, totalValue: 0, rows: [] };
  }

  const rows = (data as any[]).map((r) => ({
    poId: String(r.metadata?.poId ?? "?"),
    supplier: String(r.metadata?.supplier ?? "Unknown"),
    total: Number(r.metadata?.total) || 0,
  }));

  return {
    count: rows.length,
    totalValue: Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100,
    rows: rows.slice(0, 15),
  };
}

/**
 * Invoice-PO matches completed in the previous business week.
 * Pulls RECONCILIATION_AUTO_APPLIED (auto-completed) plus RECONCILIATION rows
 * whose verdict resolved to auto_approve/no_change (manually confirmed matches
 * that didn't need a Finale write). Blocked/error rows are counted separately
 * so the summary distinguishes "matched cleanly" from "needs a human."
 */
async function getLastWeekMatches(db: any, weekStart: string, weekEnd: string): Promise<MatchSummary> {
  const { data, error } = await db
    .from("ap_activity_log")
    .select("intent, metadata, created_at")
    .in("intent", ["RECONCILIATION_AUTO_APPLIED", "RECONCILIATION_ERROR"])
    .gte("created_at", `${weekStart}T00:00:00Z`)
    .lte("created_at", `${weekEnd}T23:59:59Z`)
    .order("created_at", { ascending: false });

  if (error || !data) {
    console.warn("[monday-briefing] matches query failed:", error?.message);
    return { autoApplied: 0, noChangeMatches: 0, blocked: 0, errors: 0, rows: [] };
  }

  const rows: MatchSummary["rows"] = [];
  let autoApplied = 0;
  let noChangeMatches = 0;
  let errors = 0;

  for (const r of data as any[]) {
    const meta = r.metadata || {};
    const orderId = String(meta.orderId ?? meta.poId ?? "?");
    const invoiceNumber = String(meta.invoiceNumber ?? "?");
    const vendorName = String(meta.vendorName ?? meta.vendor ?? "Unknown");

    if (r.intent === "RECONCILIATION_AUTO_APPLIED") {
      const hadChanges = meta.changeSummary && meta.changeSummary !== "no changes";
      if (hadChanges) autoApplied += 1;
      else noChangeMatches += 1;
      rows.push({ orderId, invoiceNumber, vendorName, verdict: hadChanges ? "applied" : "confirmed" });
    } else if (r.intent === "RECONCILIATION_ERROR") {
      errors += 1;
    }
  }

  return { autoApplied, noChangeMatches, blocked: 0, errors, rows: rows.slice(0, 15) };
}

/** PO spend created (Finale issue_date) in the previous business week. Best-effort via local DB mirror. */
async function getLastWeekPoSpend(db: any, weekStart: string, weekEnd: string): Promise<PoSpendSummary> {
  // po-sync.ts mirrors Finale POs into the local `purchase_orders` table (2h
  // refresh cadence). Query the mirror rather than hitting Finale live to
  // keep this cron cheap and fast.
  const { data, error } = await db
    .from("purchase_orders")
    .select("po_number, vendor_name, total_amount, issue_date")
    .gte("issue_date", weekStart)
    .lte("issue_date", weekEnd)
    .order("issue_date", { ascending: false });

  if (error || !data) {
    console.warn("[monday-briefing] PO spend query failed (local mirror unavailable):", error?.message);
    return { count: 0, totalValue: 0, rows: [] };
  }

  const rows = (data as any[]).map((r) => ({
    orderId: String(r.po_number),
    supplier: String(r.vendor_name ?? "Unknown"),
    total: Number(r.total_amount) || 0,
    orderDate: String(r.issue_date ?? ""),
  }));

  return {
    count: rows.length,
    totalValue: Math.round(rows.reduce((s, r) => s + r.total, 0) * 100) / 100,
    rows: rows.slice(0, 15),
  };
}


/**
 * Upcoming needs — pulls from latest build_risk_snapshot (high-risk items needing
 * order soon). Flags items with dueBy in the past as overdue rather than silently
 * listing a stale date, and rounds fractional quantities (upstream calc bug —
 * tracked separately, see purchasing-calibration-audit skill).
 */
async function getUpcomingNotablePurchases(db: any): Promise<UpcomingNeed[]> {
  const { data, error } = await db
    .from("build_risk_snapshots")
    .select("components, generated_at")
    .order("generated_at", { ascending: false })
    .limit(1);

  if (error || !data || !data[0]) {
    console.log("[monday-briefing] No build_risk_snapshot for upcoming needs.");
    return [];
  }

  const comps = (data[0].components || {}) as Record<string, any>;
  const needs: UpcomingNeed[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const [sku, c] of Object.entries(comps)) {
    if (!c) continue;
    const risk = c.riskLevel || "";
    const trigger = c.orderTriggerDate;
    if ((risk === "CRITICAL" || risk === "HIGH") && trigger) {
      const overdueDays = trigger < todayIso
        ? Math.floor((Date.now() - new Date(trigger).getTime()) / 86400000)
        : undefined;
      const rawQty = c.suggestedOrderQty || c.totalRequiredQty;
      needs.push({
        sku,
        reason: `Build risk ${risk} — coverage ${c.coverageDays != null ? Math.round(c.coverageDays) : "?"}d`,
        suggestedQty: rawQty != null ? Math.round(rawQty) : undefined,
        vendor: c.vendorName,
        dueBy: trigger,
        risk,
        overdueDays,
      });
    }
  }

  // Overdue-first, then soonest due
  return needs
    .sort((a, b) => {
      const aOverdue = a.overdueDays ?? -1;
      const bOverdue = b.overdueDays ?? -1;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      return (a.dueBy || "").localeCompare(b.dueBy || "");
    })
    .slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Builder — action-first, empty-states explicit, no filler content
// ─────────────────────────────────────────────────────────────────────────────

function buildBriefingEmail(
  dateStr: string,
  weekStart: string,
  weekEnd: string,
  receivings: ReceivingSummary,
  matches: MatchSummary,
  poSpend: PoSpendSummary,
  upcoming: UpcomingNeed[]
): string {
  const lines: string[] = [];
  const overdueCount = upcoming.filter((u) => u.overdueDays != null).length;

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`  ARIA BRIEFING — ${dateStr}`);
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // ── Action-needed block (only if there's something to act on) ──
  if (upcoming.length > 0) {
    const headline = overdueCount > 0
      ? `ACTION NEEDED — ${upcoming.length} builds at CRITICAL/HIGH risk (${overdueCount} past due)`
      : `ACTION NEEDED — ${upcoming.length} builds at CRITICAL/HIGH risk`;
    lines.push(headline);
    lines.push("───────────────────────────────────────────────────────────────");
    upcoming.forEach((u) => {
      const qty = u.suggestedQty ? `qty ~${u.suggestedQty}` : "qty ?";
      const vendor = u.vendor || "UNRESOLVED data gap";
      const dueNote = u.overdueDays != null
        ? `was due ${u.dueBy} (${u.overdueDays}d overdue)`
        : `due ${u.dueBy}`;
      lines.push(`  ${u.sku.padEnd(9)} ${qty.padEnd(10)} ${vendor.padEnd(24)} ${dueNote}`);
    });
    lines.push("");
  }

  // ── Receivings ──
  lines.push(`RECEIVED LAST WEEK (${weekStart} – ${weekEnd})`);
  lines.push("───────────────────────────────────────────────────────────────");
  if (receivings.count === 0) {
    lines.push("  None received.");
  } else {
    lines.push(`  ${receivings.count} POs received · $${receivings.totalValue.toLocaleString()}`);
    receivings.rows.forEach((r) => {
      lines.push(`    PO ${r.poId.padEnd(8)} ${r.supplier.padEnd(28)} $${r.total.toFixed(0)}`);
    });
  }
  lines.push("");

  // ── Invoice-PO matches ──
  lines.push("INVOICE-PO MATCHING LAST WEEK");
  lines.push("───────────────────────────────────────────────────────────────");
  const totalMatched = matches.autoApplied + matches.noChangeMatches;
  if (totalMatched === 0 && matches.errors === 0) {
    lines.push("  No reconciliations processed.");
  } else {
    lines.push(`  ${totalMatched} matched (${matches.autoApplied} applied w/ changes, ${matches.noChangeMatches} confirmed no-change)`);
    if (matches.errors > 0) {
      lines.push(`  ${matches.errors} errored — needs review in dashboard > Active Purchases`);
    }
    matches.rows.forEach((m) => {
      lines.push(`    PO ${m.orderId.padEnd(8)} inv ${m.invoiceNumber.padEnd(12)} ${m.vendorName.padEnd(22)} ${m.verdict}`);
    });
  }
  lines.push("");

  // ── PO spend created ──
  lines.push(`POs CREATED LAST WEEK (${weekStart} – ${weekEnd})`);
  lines.push("───────────────────────────────────────────────────────────────");
  if (poSpend.count === 0) {
    lines.push("  No POs created (or local Finale mirror unavailable — check dashboard).");
  } else {
    lines.push(`  ${poSpend.count} POs · $${poSpend.totalValue.toLocaleString()}`);
    poSpend.rows.forEach((p) => {
      lines.push(`    PO ${p.orderId.padEnd(8)} ${p.supplier.padEnd(28)} $${p.total.toFixed(0)}  (${p.orderDate})`);
    });
  }
  lines.push("");

  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("Full detail: dashboard.buildasoil → Active Purchases");
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate and email the Monday Briefing.
 * Queries live data, builds formatted report, sends via Gmail (default slot).
 * Safe to run — only emails on Monday.
 */
export async function generateAndSendMondayBriefing(): Promise<void> {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon
  if (day !== 1) {
    console.log("[monday-briefing] Not Monday — skipping email.");
    return;
  }

  const db = createClient();
  if (!db) {
    console.error("[monday-briefing] Supabase client unavailable.");
    return;
  }

  const dateStr = today.toISOString().slice(0, 10);
  const { start: weekStart, end: weekEnd } = getPreviousBusinessWeek(today);

  console.log(`[monday-briefing] Collecting data for ${dateStr} (prior week ${weekStart}..${weekEnd})...`);

  const [receivings, matches, poSpend, upcoming] = await Promise.all([
    getLastWeekReceivings(db, weekStart, weekEnd),
    getLastWeekMatches(db, weekStart, weekEnd),
    getLastWeekPoSpend(db, weekStart, weekEnd),
    getUpcomingNotablePurchases(db),
  ]);

  const body = buildBriefingEmail(dateStr, weekStart, weekEnd, receivings, matches, poSpend, upcoming);

  const subject = `Aria Briefing — ${dateStr}`;

  try {
    const result = await sendTextOnlyGmailEmail({
      to: "bill.selee@buildasoil.com",
      subject,
      body,
      tokenName: "default",
    });

    if (result.messageId) {
      console.log(`[monday-briefing] Email sent successfully. Message ID: ${result.messageId}`);
    } else {
      console.warn("[monday-briefing] Email send returned no messageId.");
    }
  } catch (err: any) {
    console.error("[monday-briefing] Failed to send email:", err?.message ?? err);
    throw err;
  }
}
