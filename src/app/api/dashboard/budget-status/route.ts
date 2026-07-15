/**
 * @file    src/app/api/dashboard/budget-status/route.ts
 * @purpose GET endpoint for agent budget status. Returns per-agent spend
 *          vs monthly cap with 80% warning threshold.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const { createClient } = await import("@/lib/supabase");
        const db = createClient();

        if (!db) {
            return NextResponse.json({ agents: [], error: "Database unavailable" });
        }

        const { data, error } = await supabase
            .from("agent_budget")
            .select("agent_id, monthly_usd_cap, current_period_usd_spent, current_period_tokens_spent, current_period_start, paused_until, notes, last_charged_at")
            .order("current_period_usd_spent", { ascending: false });

        if (error) {
            return NextResponse.json({ agents: [], error: error.message });
        }

        const agents = (data || []).map((row: any) => {
            const cap = Number(row.monthly_usd_cap) || 0;
            const spent = Number(row.current_period_usd_spent) || 0;
            const pct = cap > 0 ? (spent / cap) * 100 : 0;

            let status: "normal" | "warning" | "exceeded" | "paused" = "normal";
            if (row.paused_until && new Date(row.paused_until) > new Date()) {
                status = "paused";
            } else if (pct >= 100) {
                status = "exceeded";
            } else if (pct >= 80) {
                status = "warning";
            }

            return {
                agentId: row.agent_id,
                monthlyCap: cap,
                spentUsd: spent,
                spentPct: Math.round(pct),
                tokensSpent: Number(row.current_period_tokens_spent) || 0,
                periodStart: row.current_period_start,
                lastCharged: row.last_charged_at,
                pausedUntil: row.paused_until || null,
                status,
                notes: row.notes,
            };
        });

        const totalSpent = agents.reduce((s: number, a: any) => s + a.spentUsd, 0);
        const totalCap = agents.reduce((s: number, a: any) => s + a.monthlyCap, 0);
        const warnCount = agents.filter((a: any) => a.status === "warning" || a.status === "exceeded").length;

        return NextResponse.json({
            agents,
            summary: {
                totalAgents: agents.length,
                totalSpent,
                totalCap,
                pctSpent: totalCap > 0 ? Math.round((totalSpent / totalCap) * 100) : 0,
                warnedOrExceeded: warnCount,
            },
        });
    } catch (err: any) {
        return NextResponse.json({ agents: [], error: err.message }, { status: 500 });
    }
}
