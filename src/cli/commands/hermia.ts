/**
 * @file    hermia.ts
 * @purpose Hermia orchestration commands for Telegram — full operational
 *          control through the Aria bot. Replaces notification-only model
 *          with direct command-and-control.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    telegraf, cognitive-round, budget, memory, ops/observability
 */

import type { BotCommand, BotDeps } from "./types";

/**
 * /cognition — Show recent cognitive round decisions.
 * Hermia's "what I decided and why" reports.
 */
const cognitionCommand: BotCommand = {
    name: "cognition",
    description: "Show recent cognitive round decisions (last 24h)",
    handler: async (ctx, deps) => {
        try {
            const { getRecentDecisions } = await import("@/lib/intelligence/cognitive-round");
            const rounds = getRecentDecisions(24);

            if (rounds.length === 0) {
                await ctx.reply(
                    "🧠 No cognitive rounds logged yet.\n\n" +
                    "The Cognitive Round runs every 15 min.\n" +
                    "Use /priority to force one now.",
                    { parse_mode: "Markdown" },
                );
                return;
            }

            const lines: string[] = [
                "🧠 *Hermia Cognitive Rounds (last 24h)*",
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                "",
            ];

            for (const round of rounds.slice(0, 8)) {
                const priority = round.decision.priority.toUpperCase();
                const icon = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" }[round.decision.priority] || "⚪";
                const time = new Date(round.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

                lines.push(`${icon} *${priority}* \\(${time}\\)`);
                lines.push(`   ${round.decision.summary}`);
                if (round.decision.suppress.length > 0) {
                    lines.push(`   ↓ Suppressed: ${round.decision.suppress.join(", ")}`);
                }
                if (round.decision.boost.length > 0) {
                    lines.push(`   ↑ Boosted: ${round.decision.boost.join(", ")}`);
                }
                lines.push(`   ⏱ ${round.durationMs}ms`);
                lines.push("");
            }

            if (rounds.length > 8) {
                lines.push(`_…and ${rounds.length - 8} more rounds\\._`);
            }

            await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /priority — Force a cognitive round now.
 * Hermia surveys all state and makes an immediate decision.
 */
const priorityCommand: BotCommand = {
    name: "priority",
    description: "Force a cognitive round now (survey state, make decision)",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const { runCognitiveRound } = await import("@/lib/intelligence/cognitive-round");
            const decision = await runCognitiveRound();

            const icon = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" }[decision.priority] || "⚪";

            const lines = [
                `${icon} *Cognitive Round Complete*`,
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                "",
                `*Decision:* ${decision.priority.toUpperCase()}`,
                `*Summary:* ${decision.summary}`,
                "",
            ];

            if (decision.suppress.length > 0) {
                lines.push(`*Suppressed:* ${decision.suppress.join(", ")}`);
            }
            if (decision.boost.length > 0) {
                lines.push(`*Boosted:* ${decision.boost.join(", ")}`);
            }

            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /budget — Show agent budget status.
 * Per-agent spend vs monthly cap with warning thresholds.
 */
const budgetCommand: BotCommand = {
    name: "budget",
    description: "Show agent budget status (spend vs monthly cap)",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const { createClient } = await import("@/lib/supabase");
            const supabase = createClient();

            if (!supabase) {
                await ctx.reply("❌ Supabase unavailable");
                return;
            }

            const { data } = await supabase
                .from("agent_budget")
                .select("agent_id, monthly_usd_cap, current_period_usd_spent, current_period_tokens_spent")
                .order("current_period_usd_spent", { ascending: false });

            if (!data || data.length === 0) {
                await ctx.reply("No budget data. Run `node --import tsx src/cli/seed-agent-budgets.ts` first.");
                return;
            }

            const lines: string[] = [
                "💰 *Agent Budget Status*",
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                "",
            ];

            let totalSpent = 0;
            let totalCap = 0;

            for (const row of data as any[]) {
                const cap = Number(row.monthly_usd_cap) || 0;
                const spent = Number(row.current_period_usd_spent) || 0;
                const pct = cap > 0 ? Math.round((spent / cap) * 100) : 0;
                const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
                const icon = pct >= 100 ? "🔴" : pct >= 80 ? "🟠" : "🟢";

                lines.push(`${icon} \`${String(row.agent_id).padEnd(18)}\` $${spent.toFixed(2)} / $${cap.toFixed(2)}`);
                lines.push(`   ${bar} ${pct}%`);
                totalSpent += spent;
                totalCap += cap;
            }

            const totalPct = totalCap > 0 ? Math.round((totalSpent / totalCap) * 100) : 0;
            lines.push("");
            lines.push(`*Total:* $${totalSpent.toFixed(2)} / $${totalCap.toFixed(2)} (${totalPct}%)`);

            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /memories — Show memory store stats.
 * Local SQLite vector counts per namespace.
 */
const memoriesCommand: BotCommand = {
    name: "memories",
    description: "Show local memory stats (SQLite vector store)",
    handler: async (ctx, deps) => {
        try {
            const { countVectors } = await import("@/lib/storage/memory-store");
            const namespaces = ["aria-memory", "vendor-memory", "insight-index", "session-archive"];

            const lines: string[] = [
                "🧠 *Memory Store Stats*",
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                `Provider: OpenAI text-embedding-3-small (1024d)`,
                `Storage: local SQLite (aria-local.db)`,
                `Backup: Supabase every 6h`,
                "",
            ];

            let total = 0;
            for (const ns of namespaces) {
                const count = countVectors(ns);
                lines.push(`  ${ns.padEnd(22)} ${count} vectors`);
                total += count;
            }

            lines.push(`  ${"".padEnd(22)} ${total} total`);

            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /agents — Show agent heartbeat status.
 * Which agents are healthy, degraded, or stopped.
 */
const agentsCommand: BotCommand = {
    name: "agents",
    description: "Show agent heartbeat status",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const { createClient } = await import("@/lib/supabase");
            const supabase = createClient();

            if (!supabase) {
                await ctx.reply("❌ Supabase unavailable");
                return;
            }

            const { data } = await supabase
                .from("agent_heartbeats")
                .select("agent_name, status, heartbeat_at")
                .order("heartbeat_at", { ascending: false });

            const lines: string[] = [
                "🤖 *Agent Heartbeat Status*",
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                "",
            ];

            if (data && data.length > 0) {
                const now = Date.now();
                for (const hb of data as any[]) {
                    const elapsed = Math.round((now - new Date(hb.heartbeat_at).getTime()) / 1000);
                    const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m`;
                    const icon = hb.status === "healthy"
                        ? "🟢"
                        : hb.status === "degraded" ? "🟠" : "🔴";
                    lines.push(`${icon} \`${String(hb.agent_name).padEnd(22)}\` ${hb.status} (${elapsedStr} ago)`);
                }
            } else {
                lines.push("  No heartbeat data yet.");
            }

            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /ship — Trigger a hot deploy of bot or dashboard code.
 * Usage: /ship bot | /ship dashboard
 */
const shipCommand: BotCommand = {
    name: "ship",
    description: "Hot-deploy: /ship bot | /ship dashboard",
    handler: async (ctx, deps) => {
        const text = (ctx.message as any)?.text || "";
        const target = text.replace("/ship", "").trim().toLowerCase();

        if (!target || !["bot", "dashboard"].includes(target)) {
            await ctx.reply("Usage: `/ship bot` or `/ship dashboard`", { parse_mode: "Markdown" });
            return;
        }

        await ctx.sendChatAction("typing");

        try {
            if (target === "bot") {
                await ctx.reply("🔄 Shipping aria-bot…");
                const { exec } = await import("child_process");
                const { promisify } = await import("util");
                const execAsync = promisify(exec);
                const result = await execAsync("pm2 restart aria-bot", { timeout: 30000 });
                await ctx.reply(`✅ aria-bot restarted\n\`${(result.stdout || result.stderr).slice(0, 200)}\``, { parse_mode: "Markdown" });
            } else {
                await ctx.reply("🔨 Building + shipping dashboard…");
                const { exec } = await import("child_process");
                const { promisify } = await import("util");
                const execAsync = promisify(exec);

                // Build
                const buildResult = await execAsync(
                    "npx next build",
                    { timeout: 300000, env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=12288" } },
                );
                await ctx.reply(`✅ Build complete\n\`${(buildResult.stdout || "").slice(-300)}\``, { parse_mode: "Markdown" });

                // Reload
                const reloadResult = await execAsync("pm2 reload aria-dashboard", { timeout: 30000 });
                await ctx.reply(`✅ Dashboard reloaded\n\`${(reloadResult.stdout || "").slice(0, 200)}\``, { parse_mode: "Markdown" });
            }
        } catch (err: any) {
            await ctx.reply(`❌ Ship failed: ${err.message}\n\`${err.stderr?.slice(0, 300) || ""}\``, { parse_mode: "Markdown" });
        }
    },
};

/**
 * /cost — Weekly LLM cost summary.
 * Pulls from cron_cost_log SQLite table.
 */
const costCommand: BotCommand = {
    name: "cost",
    description: "Show weekly LLM cost breakdown",
    handler: async (ctx, deps) => {
        try {
            const { formatWeeklyCostReport } = await import("@/lib/ops/observability");
            const report = formatWeeklyCostReport();
            await ctx.reply(report, { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /aphealth — AP pipeline health: stuck emails, daily stats, reconciliation.
 */
const apHealthCommand: BotCommand = {
    name: "aphealth",
    description: "AP pipeline health: stuck emails, daily stats",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const { getAPDailyStats, detectStuckEmails, formatAPHealth } = await import("@/lib/intelligence/ap-health");
            const stats = await getAPDailyStats();
            const stuck = await detectStuckEmails();
            const report = formatAPHealth(stats, stuck);
            await ctx.reply(report, { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ Failed: ${err.message}`);
        }
    },
};

/**
 * /ordernow — What needs ordering RIGHT NOW. Manufacturing-first.
 * Cuts through 121 items to show only what will lose money if delayed.
 */
const orderNowCommand: BotCommand = {
    name: "ordernow",
    description: "What needs ordering RIGHT NOW — manufacturing-first",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            // Fetch purchasing data from dashboard API
            const response = await fetch("http://localhost:3001/api/dashboard/purchasing?bust=1");
            if (!response.ok) throw new Error(`Purchasing API returned ${response.status}`);

            const data = await response.json();
            if (!data.groups || data.groups.length === 0) {
                await ctx.reply("No purchasing data available. The scanner may still be running.");
                return;
            }

            const { buildOrderingReport, formatOrderingReport } = await import("@/lib/intelligence/ordering-urgency");
            const report = buildOrderingReport(data.groups);
            const formatted = formatOrderingReport(report);
            await ctx.reply(formatted, { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ ${err.message}`);
        }
    },
};

/**
 * /ball — Crystal Ball projection. What happens if nothing is ordered today?
 * Shows stockout dates, build impact, and monthly revenue at risk.
 */
const ballCommand: BotCommand = {
    name: "ball",
    description: "Crystal Ball: what happens if nothing is ordered today",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const response = await fetch("http://localhost:3001/api/dashboard/purchasing?bust=1");
            if (!response.ok) throw new Error(`Purchasing API returned ${response.status}`);

            const data = await response.json();
            if (!data.groups || data.groups.length === 0) {
                await ctx.reply("No purchasing data available. The scanner may still be running.");
                return;
            }

            const { buildCrystalBallReport, formatCrystalBallReport } = await import("@/lib/intelligence/crystal-ball");
            const report = buildCrystalBallReport(data.groups);
            const formatted = formatCrystalBallReport(report);
            await ctx.reply(formatted, { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ ${err.message}`);
        }
    },
};

/**
 * /orderguard — Check vendor cycle guard for the current purchasing data.
 * Shows which vendors already have active POs and which would fail the cycle guard.
 */
const orderGuardCommand: BotCommand = {
    name: "orderguard",
    description: "Vendor cycle guard — find fragmented POs before committing",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const response = await fetch("http://localhost:3001/api/dashboard/purchasing?bust=1");
            if (!response.ok) throw new Error(`Purchasing API returned ${response.status}`);

            const data = await response.json();
            if (!data.groups || data.groups.length === 0) {
                await ctx.reply("No purchasing data available. The scanner may still be running.");
                return;
            }

            const { evaluateVendorCycle } = await import("@/lib/purchasing/vendor-order-cycle");
            const lines: string[] = [];
            lines.push(`🛡️ *Vendor Cycle Guard — Multi-PO Flag Check*`);
            lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

            // Only show vendors with actionable items
            const activeGroups = data.groups.filter((g: any) =>
                g.items?.some((i: any) =>
                    (i.urgency === "critical" || i.urgency === "warning") && i.suggestedQty > 0
                )
            );

            if (activeGroups.length === 0) {
                await ctx.reply("✅ No vendors with urgent items. Cycle guard clear.");
                return;
            }

            let flagCount = 0;
            for (const group of activeGroups.slice(0, 10)) {
                const vendorName = group.vendorName;

                // Use vendor party ID to look up recent POs from the dashboard data
                const recentPOs = group.items
                    ?.filter((i: any) => i.openPOs?.length > 0)
                    .flatMap((i: any) => (i.openPOs || []).map((po: any) => ({
                        orderId: po.orderId || "",
                        orderDate: po.orderDate || null,
                        status: po.status || "ORDER_LOCKED",
                        supplier: vendorName,
                    }))) || [];

                // Deduplicate by orderId
                const uniquePOs = [...new Map(recentPOs.map((p: any) => [p.orderId, p])).values()];

                const cycleResult = evaluateVendorCycle(uniquePOs as any, {
                    vendorName,
                    vendorPartyId: group.vendorPartyId || "",
                    exception: undefined,
                });

                if (cycleResult.decision === "routine_locked") {
                    flagCount++;
                    lines.push(`⚠️ *${vendorName}* — ${cycleResult.blockingPOs.length} active PO(s) in cycle`);
                    lines.push(`   Blocking: ${cycleResult.blockingPOs.map((p: any) => `#${p.orderId} (${p.orderDate?.split("T")[0] || "unknown"})`).join(", ")}`);
                    lines.push(`   Ignored canceled: ${cycleResult.ignoredCanceled} | Dropship: ${cycleResult.ignoredDropship}`);
                    lines.push("");
                }
            }

            if (flagCount === 0) {
                lines.push("✅ All vendor cycles clear for current urgent items.");
            } else {
                lines.push(`\n${flagCount} vendor(s) flagged. Consider consolidating before committing new POs.`);
            }

            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ ${err.message}`);
        }
    },
};

/**
 * /hermia — Agent accountability hierarchy. Who owns what, who's failing.
 */
const hermiaCommand: BotCommand = {
    name: "hermia",
    description: "Agent hierarchy — who owns what, accountability board",
    handler: async (ctx, deps) => {
        try {
            const { getOrchestrator } = await import("@/lib/intelligence/hermes-orchestrator");
            const orch = getOrchestrator();

            // Register heartbeats from current state
            const { createClient } = await import("@/lib/supabase");
            const supabase = createClient();
            if (supabase) {
                const { data: heartbeats } = await supabase
                    .from("agent_heartbeats")
                    .select("agent_name, status, heartbeat_at")
                    .order("heartbeat_at", { ascending: false });

                if (heartbeats) {
                    for (const hb of heartbeats as any[]) {
                        const elapsed = Date.now() - new Date(hb.heartbeat_at).getTime();
                        const status: "healthy" | "degraded" | "stopped" =
                            elapsed > 900000 ? "stopped" :
                            elapsed > 450000 ? "degraded" : "healthy";
                        await orch.registerHeartbeat(hb.agent_name, status);
                    }
                }
            }

            const report = orch.formatAgentHierarchy();
            await ctx.reply(report, { parse_mode: "Markdown" });
        } catch (err: any) {
            await ctx.reply(`❌ ${err.message}`);
        }
    },
};

/**
 * /followup — Follow-up SOP. Checks for unanswered Slack requests (>24h)
 * and vendor POs without confirmation (>48h).
 */
const followupCommand: BotCommand = {
    name: "followup",
    description: "Follow-up SOP — unanswered Slack requests + unconfirmed POs",
    handler: async (ctx, deps) => {
        await ctx.sendChatAction("typing");

        try {
            const { buildFollowUpReport, formatFollowUpReport } = await import("@/lib/slack/followup-sop");
            const report = await buildFollowUpReport();
            const formatted = formatFollowUpReport(report);
            await ctx.reply(formatted, { parse_mode: "Markdown" });
        } catch (err: any) {
                await ctx.reply(`❌ ${err.message}`);
            }
        },
        };

        /**
        * /email — Email pipeline triage. Shows queue health, stuck items,
        * slow vendor acks, and draft follow-ups. Ninja-grade visibility.
        */
        const emailCommand: BotCommand = {
        name: "email",
        description: "Email pipeline triage — queues, stuck items, slow vendors",
        handler: async (ctx, deps) => {
            await ctx.sendChatAction("typing");

            try {
                const { buildEmailTriageReport, formatEmailTriageReport } = await import("@/lib/intelligence/email-triage");
                const report = await buildEmailTriageReport();
                const formatted = formatEmailTriageReport(report);
                await ctx.reply(formatted, { parse_mode: "Markdown" });
            } catch (err: any) {
                await ctx.reply(`❌ ${err.message}`);
            }
        },
        };

        // ── Export: MUST come after all command definitions ─────────────────────────
        // const declarations are not hoisted — referencing them before init crashes.

        export const hermiaCommands: BotCommand[] = [
        cognitionCommand,
        priorityCommand,
        orderNowCommand,
        ballCommand,
        orderGuardCommand,
        followupCommand,
        emailCommand,
        budgetCommand,
        memoriesCommand,
        agentsCommand,
        hermiaCommand,
        shipCommand,
        costCommand,
        apHealthCommand,
        ];