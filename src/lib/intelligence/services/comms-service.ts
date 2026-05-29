/**
 * @file comms-service.ts
 * @purpose Communication service for daily/weekly summaries and notifications
 * @created 2026-05-29
 * @author Bill Selee
 * @extracted-from ops-manager.ts Phase 1 of OpsManager split
 */

import { Telegraf } from 'telegraf';
import { createClient } from '../../supabase';
import { finaleClient } from '../../finale/client';
import { CalendarClient } from '../../google/calendar';
import { loadActivePurchases } from '../../purchasing/active-purchases';
import * as agentTask from '../agent-task';

export class CommsService {
  constructor(private bot: Telegraf) {}

  /**
   * Send daily summary report to Telegram.
   * Schedule: Mon-Fri only (no weekends).
   * - Monday: light, meaningful review of previous week
   * - Tuesday-Thursday: standard daily ops summary
   * - Friday: weekly wrap-up summary (WeeklySummary fires 1 min later for detailed version)
   *
   * Phase 1a Task 5: AP reconciliation observability block prepended to the digest.
   */
  async sendDailySummary() {
    const dow = new Date().toLocaleString('en-US', { weekday: 'long', timeZone: 'America/Denver' });
    const isMonday = dow === 'Monday';
    const isFriday = dow === 'Friday';

    if (isMonday) {
      console.log("📊 Preparing Monday Previous-Week Review...");
    } else if (isFriday) {
      console.log("📊 Preparing Friday Weekly Wrap...");
    } else {
      console.log("📊 Preparing Daily PO Summary...");
    }

    const chatId = process.env.TELEGRAM_CHAT_ID || "";
    const blocks: string[] = [];

    // Block 1: AP reconciliation observability.
    try {
      const reconStatusModule = await import("@/lib/runtime/observability/recon-status");
      const reconStatusAny = reconStatusModule as any;
      const formatMorningApBlock =
        reconStatusModule.formatMorningApBlock ??
        reconStatusAny.default?.formatMorningApBlock ??
        reconStatusAny["module.exports"]?.formatMorningApBlock;
      if (typeof formatMorningApBlock !== "function") {
        throw new Error("formatMorningApBlock export unavailable");
      }
      const apBlock = await formatMorningApBlock();
      if (apBlock && String(apBlock).trim().length > 0) {
        blocks.push(String(apBlock).trim());
      }
    } catch (err: any) {
      console.warn("[CommsService] AP morning block failed (non-fatal):", err.message);
      blocks.push(`📬 AP: error ${err.message}`);
    }

    // Block 2: POs in flight — count by lifecycle stage.
    try {
      const purchases = await loadActivePurchases(finaleClient, 60);
      const counts = new Map<string, number>();
      for (const p of purchases) {
        const stage = (p as any).lifecycleStage || "unknown";
        counts.set(stage, (counts.get(stage) ?? 0) + 1);
      }
      const total = purchases.length;
      const lines = [`📦 *POs in flight* (${total} total)`];
      const ordered = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      for (const [stage, count] of ordered) {
        lines.push(`  • ${stage}: ${count}`);
      }
      if (ordered.length === 0) {
        lines.push("  • none");
      }
      blocks.push(lines.join("\n"));
    } catch (err: any) {
      console.warn("[CommsService] POs-in-flight block failed:", err.message);
      blocks.push(`📦 POs in flight: error ${err.message}`);
    }

    // Block 2.5: PO receivings in last 24h (rolls up what used to be
    // per-event Telegram pings — Activity is the spine, this block is
    // the daily digest).
    try {
      const supabase = createClient();
      if (supabase) {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const { data } = await supabase
          .from("ap_activity_log")
          .select("metadata")
          .eq("intent", "PO_RECEIVED")
          .gte("created_at", since)
          .limit(100);
        const rows = (data ?? []) as Array<{ metadata: any }>;
        if (rows.length === 0) {
          blocks.push("📦 *Received today*: none");
        } else {
          const totalValue = rows.reduce((s, r) => s + (Number(r.metadata?.total) || 0), 0);
          const sample = rows.slice(0, 3).map(r => `  • PO #${r.metadata?.poId} — ${r.metadata?.supplier ?? "?"} ($${(Number(r.metadata?.total) || 0).toFixed(0)})`);
          const more = rows.length > 3 ? `\n  • …+${rows.length - 3} more` : "";
          blocks.push(`📦 *Received today* (${rows.length}, $${totalValue.toFixed(0)})\n${sample.join("\n")}${more}`);
        }
      }
    } catch (err: any) {
      console.warn("[CommsService] Receivings block failed:", err.message);
    }

    // Block 3: Builds today (next 24h).
    try {
      const calendar = new CalendarClient();
      const events = await calendar.getAllUpcomingBuilds(2);
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // YYYY-MM-DD
      const tomorrow = new Date(Date.now() + 86400000)
        .toLocaleDateString("en-CA", { timeZone: "America/Denver" });
      const todays = events.filter(e => e.startDate === today || e.startDate === tomorrow);
      if (todays.length === 0) {
        blocks.push(`🏗 *Builds today*: none scheduled in the next 24h`);
      } else {
        const sample = todays.slice(0, 3).map(e => `  • ${e.startDate}: ${e.title || "(untitled)"}`);
        const more = todays.length > 3 ? `\n  • …+${todays.length - 3} more` : "";
        blocks.push(`🏗 *Builds today* (${todays.length} in next 24h)\n${sample.join("\n")}${more}`);
      }
    } catch (err: any) {
      console.warn("[CommsService] Builds-today block failed:", err.message);
      blocks.push(`🏗 Builds today: not available (${err.message})`);
    }

    // Block 4: Tasks awaiting Will.
    try {
      const needs = await agentTask.listTasks({ status: ["NEEDS_APPROVAL"], limit: 200 });
      const failedWill = (await agentTask.listTasks({ status: ["FAILED"], owner: "will", limit: 200 })) ?? [];
      const total = needs.length + failedWill.length;
      const lines = [`✋ *Tasks awaiting Will* (${total} total)`];
      if (total === 0) {
        lines.push("  • inbox clear");
      } else {
        if (needs.length > 0) lines.push(`  • needs approval: ${needs.length}`);
        if (failedWill.length > 0) lines.push(`  • failed (Will-owned): ${failedWill.length}`);
        const top = [...needs, ...failedWill].slice(0, 3);
        for (const t of top) {
          const goal = String((t as any).goal || (t as any).type || "task").slice(0, 80);
          lines.push(`    – ${goal}`);
        }
      }
      blocks.push(lines.join("\n"));
    } catch (err: any) {
      console.warn("[CommsService] Tasks-awaiting-Will block failed:", err.message);
      blocks.push(`✋ Tasks awaiting Will: error ${err.message}`);
    }

    // Assemble + cap under ~3000 chars, then send as a single Telegram message.
    let body = blocks.join("\n\n");
    const MAX_CHARS = 3000;
    if (body.length > MAX_CHARS) {
      body = body.slice(0, MAX_CHARS - 20) + "\n…(truncated)";
    }
    if (chatId && body.length > 0) {
      try {
        await this.bot.telegram.sendMessage(chatId, body, { parse_mode: "Markdown" });
      } catch (err: any) {
        console.warn("[CommsService] daily summary send failed, retrying without markdown:", err.message);
        try {
          await this.bot.telegram.sendMessage(chatId, body);
        } catch (err2: any) {
          console.error("[CommsService] daily summary send failed completely:", err2.message);
        }
      }
    }
  }

  /**
   * Send weekly summary report to Telegram (8:01 AM Fridays).
   * Detailed trend analysis — complements the Friday daily summary.
   */
  async sendWeeklySummary() {
    console.log("📊 Preparing Weekly Summary (Aria vs Finale retro)...");
    try {
      const { summarizeAriaVsFinale } = await import("../../purchasing/calibration-engine");
      const summary = await summarizeAriaVsFinale(7);
      const chatId = process.env.TELEGRAM_CHAT_ID || "";

      if (summary.totalSamples === 0) {
        if (chatId) {
          await this.bot.telegram.sendMessage(chatId,
            "📊 *Weekly Reorder Retro*\n\nNo calibrated recommendations in the last 7 days yet — calibration loop needs received POs to score against. Check back next week.",
            { parse_mode: "Markdown" }
          );
        }
        return;
      }

      const lines: string[] = [];
      lines.push("📊 *Weekly Reorder Retro — Aria vs Finale*");
      lines.push(`Calibrated samples: ${summary.totalSamples} (${summary.coveredSamples} comparable to Finale)`);
      if (summary.medianAriaErrorPct != null) {
        lines.push(`Aria median error: ${summary.medianAriaErrorPct >= 0 ? "+" : ""}${summary.medianAriaErrorPct.toFixed(0)}%`);
      }
      if (summary.medianFinaleErrorPct != null) {
        lines.push(`Finale median error: ${summary.medianFinaleErrorPct >= 0 ? "+" : ""}${summary.medianFinaleErrorPct.toFixed(0)}%`);
      }
      lines.push(`Aria under Finale: ${summary.ariaUnderFinaleCount} · Aria over: ${summary.ariaOverFinaleCount}`);

      if (summary.bestAriaWins.length > 0) {
        lines.push("\n*Best Aria wins (saved over Finale):*");
        for (const w of summary.bestAriaWins.slice(0, 3)) {
          lines.push(`  • ${w.productId} (${w.vendorName ?? "?"}) — Aria ${w.ariaErrorPct >= 0 ? "+" : ""}${w.ariaErrorPct}% vs Finale ${w.finaleErrorPct >= 0 ? "+" : ""}${w.finaleErrorPct}%`);
        }
      }
      if (summary.worstAriaMisses.length > 0) {
        lines.push("\n*Worst Aria misses (>=25% error):*");
        for (const m of summary.worstAriaMisses.slice(0, 3)) {
          lines.push(`  • ${m.productId} (${m.vendorName ?? "?"}) — recommended ${m.recommendedQty}, actual ${m.actualConsumed} (${m.errorPct >= 0 ? "+" : ""}${m.errorPct}%)`);
        }
      }

      if (chatId) {
        await this.bot.telegram.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
      }
    } catch (err: any) {
      console.error("[CommsService] weekly summary failed:", err.message);
    }
  }
}
