/**
 * @file    smoke-merged-state.ts
 * @purpose One-shot smoke test for the 2026-04-29 merge (b16a60a).
 *          Walks the kernel + issue ledger + budget table by calling lib
 *          functions directly — no HTTP, no dashboard, no Telegram. Run
 *          with `node --import tsx src/cli/smoke-merged-state.ts`.
 *
 *          Reports counts + a single sample issue's timeline so we can
 *          verify the merged code is reachable from production.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { listIssues, getCurrentlyHandlingCounts } from "../lib/intelligence/agent-issue";
import { getCommandBoardIssues, getCommandBoardIssueDetail } from "../lib/command-board/service";
import { listTools } from "../lib/agents/tool-registry";
import { ensureCopilotToolsRegistered } from "../lib/agents/register-copilot-tools";
import { ensureFinaleToolsRegistered } from "../lib/agents/register-finale-tools";
import { ensureGmailToolsRegistered } from "../lib/agents/register-gmail-tools";
import { ensureMemoryToolsRegistered } from "../lib/agents/register-memory-tools";
import { checkBudget } from "../lib/agents/budget";
import { createClient } from "../lib/db";

async function main() {
    console.log("─── Aria stabilization smoke ───\n");

    // 1. Issue ledger reachability
    console.log("[1] Issue ledger");
    const issues = await listIssues({ limit: 50 });
    const counts = await getCurrentlyHandlingCounts();
    const byState: Record<string, number> = {};
    for (const i of issues) byState[i.lifecycle_state] = (byState[i.lifecycle_state] ?? 0) + 1;
    console.log(`  total open+recent issues: ${issues.length}`);
    console.log(`  by lifecycle:`, byState);
    console.log(`  currentlyHandling map size: ${Object.keys(counts).length}`);
    if (Object.keys(counts).length > 0) {
        const top = Object.entries(counts).slice(0, 5).map(([h, c]) =>
            `    ${h.padEnd(20)} working=${c.working} blocked=${c.blocked} waiting=${c.waitingExternal} total=${c.total}`,
        ).join("\n");
        console.log(top);
    }

    // 2. Tool Registry catalog
    console.log("\n[2] Tool Registry");
    ensureCopilotToolsRegistered();
    ensureFinaleToolsRegistered();
    ensureGmailToolsRegistered();
    ensureMemoryToolsRegistered();
    const tools = listTools();
    const byCategory: Record<string, number> = {};
    for (const t of tools) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
    console.log(`  total registered: ${tools.length}`);
    console.log(`  by category:`, byCategory);

    // 3. Budget table reachable
    console.log("\n[3] Per-agent budgets");
    const sb = createClient();
    if (sb) {
        const { data } = await sb.from("agent_budget").select("agent_id, monthly_usd_cap, current_period_usd_spent, paused_until");
        const rows = (data ?? []) as Array<{ agent_id: string; monthly_usd_cap: number; current_period_usd_spent: number; paused_until: string | null }>;
        console.log(`  agents with budgets: ${rows.length}`);
        for (const r of rows.sort((a, b) => Number(b.current_period_usd_spent) - Number(a.current_period_usd_spent)).slice(0, 5)) {
            const cap = Number(r.monthly_usd_cap).toFixed(2);
            const spent = Number(r.current_period_usd_spent).toFixed(2);
            const pct = (Number(r.current_period_usd_spent) / Number(r.monthly_usd_cap) * 100).toFixed(0);
            console.log(`    ${r.agent_id.padEnd(22)} $${spent} / $${cap}  (${pct}%)${r.paused_until ? "  PAUSED" : ""}`);
        }
        // checkBudget round-trip
        const sample = rows[0];
        if (sample) {
            const check = await checkBudget(sample.agent_id);
            console.log(`  checkBudget("${sample.agent_id}") → allowed=${check.allowed}${check.reason ? ` reason=${check.reason}` : ""}`);
        }
    } else {
        console.log("  (Supabase unavailable — skipping)");
    }

    // 4. Command-board service reads (used by /api/command-board/issues + bot /issues)
    console.log("\n[4] Command-board service surface");
    const list = await getCommandBoardIssues({ limit: 5 });
    console.log(`  getCommandBoardIssues: ${list.issues.length} returned, total=${list.total}`);
    if (list.issues[0]) {
        const detail = await getCommandBoardIssueDetail(list.issues[0].id);
        console.log(`  getCommandBoardIssueDetail("${list.issues[0].id}"):`);
        console.log(`    title: ${detail?.title}`);
        console.log(`    state: ${detail?.lifecycle_state}, owner=${detail?.owner}, blocker=${detail?.blocker_reason ?? "none"}`);
        console.log(`    linked tasks: ${detail?.tasks?.length ?? 0}`);
        console.log(`    timeline events: ${detail?.timeline?.length ?? 0}`);
        if (detail?.timeline && detail.timeline.length > 0) {
            const recent = detail.timeline.slice(0, 5);
            for (const e of recent) {
                console.log(`      ${e.created_at?.slice(11, 19) ?? ""}  ${e.event_type}`);
            }
        }
    }

    // 5. Tool-call audit row sanity check
    console.log("\n[5] task_history tool_call audit rows (last 24h)");
    if (sb) {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const { data, count } = await sb
            .from("task_history")
            .select("agent_name, input_summary", { count: "exact" })
            .eq("event_type", "tool_call")
            .gte("created_at", since)
            .limit(5)
            .order("created_at", { ascending: false });
        console.log(`  tool_call events in last 24h: ${count ?? 0}`);
        if (data && data.length > 0) {
            for (const r of data as Array<{ agent_name: string; input_summary: string }>) {
                console.log(`    ${r.agent_name.padEnd(20)} ${r.input_summary?.slice(0, 80)}`);
            }
        } else {
            console.log("  (none yet — tool-call audits land as migrated paths fire)");
        }
    }

    console.log("\n─── smoke complete ───");
}

main().catch(err => {
    console.error("smoke failed:", err);
    process.exit(1);
});
