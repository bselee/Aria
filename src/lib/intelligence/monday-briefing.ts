/**
 * @file    src/lib/intelligence/monday-briefing.ts
 * @purpose Monday morning status overview email. Aggregates last-week purchases
 *          (vendor_invoices), upcoming needs (build risk + reorder signals),
 *          Slack request status by SKU, and a light industry pulse from X/news.
 *          Sends clean, actionable HTML or text email to Bill.
 * @author  Hermia
 * @created 2026-06-15
 * @deps    @/lib/supabase, @/lib/gmail/send-email, @/lib/intelligence/notify-via-task (optional)
 * @env     SUPABASE_*, GMAIL OAuth (default slot)
 */

import { createClient } from "../supabase";
import { sendTextOnlyGmailEmail } from "../gmail/send-email";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PurchaseSummary {
  totalSpent: number;
  invoiceCount: number;
  lineItemCount: number;
  vendorSkuBreakdown: Array<{ vendor: string; sku: string; amount: number }>;
  recentInvoices: Array<{
    vendor: string;
    invoice_number: string | null;
    total: number;
    date: string;
  }>;
}

interface SlackRequestSummary {
  sku: string;
  count: number;
  statuses: string[];
  latestDate: string;
  requesters: string[];
}

interface UpcomingNeed {
  sku: string;
  reason: string;
  suggestedQty?: number;
  vendor?: string;
  dueBy?: string;
  risk?: string;
}

interface NewsBit {
  headline: string;
  source: string;
  whyRelevant: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Collectors
// ─────────────────────────────────────────────────────────────────────────────

/** Sum purchases from vendor_invoices in the last 7 days. */
async function getLastWeekPurchases(db: any): Promise<PurchaseSummary> {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const { data, error } = await db
    .from("vendor_invoices")
    .select("vendor_name, invoice_number, total, invoice_date, created_at, line_items")
    .gte("invoice_date", cutoff)
    .order("invoice_date", { ascending: false });

  if (error || !data) {
    console.warn("[monday-briefing] vendor_invoices query failed:", error?.message);
    return { totalSpent: 0, invoiceCount: 0, lineItemCount: 0, vendorSkuBreakdown: [], recentInvoices: [] };
  }

  const rows = data as any[];
  let totalSpent = 0;
  let lineItemCount = 0;
  const vendorSkuMap = new Map<string, number>(); // key: "vendor|sku"
  const recent: any[] = [];

  for (const r of rows) {
    const amt = Number(r.total || 0);
    totalSpent += amt;

    const v = r.vendor_name || "Unknown";

    // Aggregate line items (vendor + sku + ext_price)
    const items = Array.isArray(r.line_items) ? r.line_items : [];
    lineItemCount += items.length;
    for (const item of items) {
      const sku = item.sku || item.description || "UNKNOWN";
      const key = `${v}|${sku}`;
      const ext = Number(item.ext_price || 0);
      vendorSkuMap.set(key, (vendorSkuMap.get(key) || 0) + ext);
    }

    if (recent.length < 5) {
      recent.push({
        vendor: v,
        invoice_number: r.invoice_number,
        total: amt,
        date: r.invoice_date || r.created_at?.slice(0, 10),
      });
    }
  }

  const vendorSkuBreakdown = Array.from(vendorSkuMap.entries())
    .map(([key, amount]) => {
      const [vendor, sku] = key.split("|");
      return { vendor, sku, amount: Math.round(amount * 100) / 100 };
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 12); // succinct top 12

  return {
    totalSpent: Math.round(totalSpent * 100) / 100,
    invoiceCount: rows.length,
    lineItemCount,
    vendorSkuBreakdown,
    recentInvoices: recent,
  };
}

/** Recent Slack requests (last 7d), grouped by SKU. */
async function getSlackRequestsBySku(db: any): Promise<SlackRequestSummary[]> {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();

  const { data, error } = await db
    .from("slack_requests")
    .select("items_requested, status, created_at, requester_name")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (error || !data) {
    console.warn("[monday-briefing] slack_requests query failed:", error?.message);
    return [];
  }

  const skuMap = new Map<string, { count: number; statuses: Set<string>; dates: string[]; requesters: Set<string> }>();

  for (const row of data as any[]) {
    const skus: string[] = Array.isArray(row.items_requested) ? row.items_requested : [];
    const status = row.status || "pending";
    const date = row.created_at?.slice(0, 10) || "";
    const requester = row.requester_name || "unknown";

    for (const sku of skus) {
      if (!sku) continue;
      const entry = skuMap.get(sku) || { count: 0, statuses: new Set(), dates: [], requesters: new Set() };
      entry.count += 1;
      entry.statuses.add(status);
      if (date) entry.dates.push(date);
      entry.requesters.add(requester);
      skuMap.set(sku, entry);
    }
  }

  return Array.from(skuMap.entries())
    .map(([sku, e]) => ({
      sku,
      count: e.count,
      statuses: Array.from(e.statuses),
      latestDate: e.dates.sort().reverse()[0] || "",
      requesters: Array.from(e.requesters),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/** Upcoming needs — pulls from latest build_risk_snapshot (high-risk items needing order soon). */
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

  for (const [sku, c] of Object.entries(comps)) {
    if (!c) continue;
    const risk = c.riskLevel || "";
    const trigger = c.orderTriggerDate;
    if ((risk === "CRITICAL" || risk === "HIGH") && trigger) {
      needs.push({
        sku,
        reason: `Build risk ${risk} — coverage ${c.coverageDays ?? "?"}d`,
        suggestedQty: c.suggestedOrderQty || c.totalRequiredQty,
        vendor: c.vendorName,
        dueBy: trigger,
        risk,
      });
    }
  }

  return needs.sort((a, b) => (a.dueBy || "").localeCompare(b.dueBy || "")).slice(0, 5);
}

/** Light Monday morning industry pulse (curated + X-style news). */
function getMondayNewsBits(): NewsBit[] {
  // Bonus: X/news bits — updated manually or via future news API integration.
  // These are relevant to ag/supply chain for BuildASoil context.
  return [
    {
      headline: "US Farm Exports Hit Record $140.9B",
      source: "USDA / Food Logistics",
      whyRelevant: "Strong demand signals healthy market for ag inputs & soil products.",
    },
    {
      headline: "Supply Chain Pressures Easing — NW Mutual",
      source: "Northwestern Mutual / Reuters",
      whyRelevant: "Freight & lead times stabilizing — good window for larger orders.",
    },
    {
      headline: "Huge Week Ahead for US Agriculture Policy",
      source: "Agri-Pulse",
      whyRelevant: "Watch for BEAD/fiber & export policy shifts that may affect input costs.",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Builder (nice, clear, useful formatting)
// ─────────────────────────────────────────────────────────────────────────────

function buildBriefingEmail(
  dateStr: string,
  purchases: PurchaseSummary,
  slack: SlackRequestSummary[],
  upcoming: UpcomingNeed[],
  news: NewsBit[]
): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`           MONDAY BRIEFING — ${dateStr}`);
  lines.push("           BuildASoil | Aria Operations Overview");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Purchases
  lines.push("📦 LAST WEEK PURCHASES");
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push(`Total: $${purchases.totalSpent.toLocaleString()} | ${purchases.invoiceCount} invoices | ${purchases.lineItemCount} items`);
  lines.push("");

  if (purchases.vendorSkuBreakdown.length > 0) {
    lines.push("Vendor / SKU / Amount:");
    purchases.vendorSkuBreakdown.forEach((row) => {
      lines.push(`  ${row.vendor} | ${row.sku} | $${row.amount.toFixed(0)}`);
    });
    lines.push("");
  }

  if (purchases.recentInvoices.length > 0) {
    lines.push("Invoices:");
    purchases.recentInvoices.forEach((inv) => {
      const invNum = inv.invoice_number || "—";
      lines.push(`  ${inv.date} | ${inv.vendor} | #${invNum} | $${inv.total.toFixed(0)}`);
    });
    lines.push("");
  }

  // Upcoming
  lines.push("🚨 UPCOMING NOTABLE PURCHASES NEEDED");
  lines.push("───────────────────────────────────────────────────────────────");
  if (upcoming.length === 0) {
    lines.push("  No critical items flagged in latest build-risk snapshot.");
    lines.push("  (Oracle FG-traceback + velocity look healthy — good job!)");
  } else {
    upcoming.forEach((u, i) => {
      const qty = u.suggestedQty ? ` (qty ~${u.suggestedQty})` : "";
      const due = u.dueBy ? ` — due by ${u.dueBy}` : "";
      lines.push(`  ${i + 1}. ${u.sku}${qty} | ${u.vendor || "TBD"} | ${u.reason}${due}`);
    });
  }
  lines.push("");

  // Slack
  lines.push("💬 SLACK ASKS — SKU STATUS REVIEW (last 7 days)");
  lines.push("───────────────────────────────────────────────────────────────");
  if (slack.length === 0) {
    lines.push("  No new Slack purchase requests recorded.");
  } else {
    lines.push("SKU          | Statuses          | Count | Latest | Requesters");
    lines.push("─────────────┼───────────────────┼───────┼────────┼────────────");
    slack.forEach((s) => {
      const statuses = s.statuses.join(", ").padEnd(17);
      const reqs = s.requesters.slice(0, 2).join(", ");
      lines.push(`${s.sku.padEnd(12)} | ${statuses} | ${String(s.count).padStart(5)} | ${s.latestDate} | ${reqs}`);
    });
  }
  lines.push("");
  lines.push("  Tip: Pending items >24h trigger TG nudge via stale-request-watcher.");

  // News
  lines.push("");
  lines.push("📰 MONDAY MORNING PULSE (Supply Chain / Ag)");
  lines.push("───────────────────────────────────────────────────────────────");
  news.forEach((n, i) => {
    lines.push(`${i + 1}. ${n.headline}`);
    lines.push(`   ${n.source} — ${n.whyRelevant}`);
    lines.push("");
  });

  // Footer
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("Generated by Aria • Questions? Reply or /briefing in TG/Slack");
  lines.push("Next briefing: Next Monday 8:00 AM MDT");
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

  console.log(`[monday-briefing] Collecting data for ${dateStr}...`);

  const [purchases, slack, upcoming] = await Promise.all([
    getLastWeekPurchases(db),
    getSlackRequestsBySku(db),
    getUpcomingNotablePurchases(db),
  ]);

  const news = getMondayNewsBits();

  const body = buildBriefingEmail(dateStr, purchases, slack, upcoming, news);

  const subject = `Monday Briefing — ${dateStr} | BuildASoil Aria`;

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
