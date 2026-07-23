/**
 * @file    src/cli/seed-agent-budgets.ts
 * @purpose Seed and verify agent_budget rows for all Aria agents.
 *          Run once to establish cost tracking, then chargeBudget()
 *          auto-creates rows for new agents at $25 default cap.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/agents/budget, dotenv
 *
 * Usage:
 *   node --import tsx src/cli/seed-agent-budgets.ts
 *
 * Monthly caps based on estimated usage:
 *   ap-identifier     $15  — ~1000 classifications/day (mostly free tier)
 *   ap-reconciler     $20  — ~50 invoice parsings/day
 *   acknowledgement   $5   — ~100 intent classifications/day (free tier)
 *   supervisor        $3   — error classification (now mostly regex)
 *   tracking-parser   $5   — ~20 tracking extractions/day
 *   vendor-comms      $10  — ~10 vendor email drafts/day
 *   ops-summaries     $5   — 2 summaries/day
 *   nightshift        $10  — overnight bulk Haiku classification
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@/lib/db";
import { checkBudget, chargeBudget, estimateCostUsd } from "@/lib/agents/budget";

interface AgentBudgetConfig {
    agent_id: string;
    monthly_usd_cap: number;
    notes: string;
}

const BUDGETS: AgentBudgetConfig[] = [
    { agent_id: "ap-identifier", monthly_usd_cap: 15.00, notes: "Email classification (free-tier OpenRouter for triage)" },
    { agent_id: "ap-reconciler", monthly_usd_cap: 25.00, notes: "Invoice parsing + PO matching + reconciliation" },
    { agent_id: "acknowledgement", monthly_usd_cap: 5.00, notes: "Vendor email acknowledgment intent classification" },
    { agent_id: "supervisor", monthly_usd_cap: 3.00, notes: "Error remediation classification (now mostly regex)" },
    { agent_id: "tracking-parser", monthly_usd_cap: 5.00, notes: "Tracking number extraction from emails" },
    { agent_id: "vendor-comms", monthly_usd_cap: 10.00, notes: "Vendor PO follow-up + ETA request drafting" },
    { agent_id: "ops-summaries", monthly_usd_cap: 5.00, notes: "Daily/weekly summary + build risk generation" },
    { agent_id: "nightshift", monthly_usd_cap: 10.00, notes: "Overnight Haiku pre-classification of unprocessed AP" },
    { agent_id: "invoice-parser", monthly_usd_cap: 15.00, notes: "PDF invoice line-item extraction" },
    { agent_id: "pdf-extractor", monthly_usd_cap: 10.00, notes: "PDF-to-text + OCR fallback (vision model)" },
    { agent_id: "purchasing-intel", monthly_usd_cap: 10.00, notes: "Purchasing intelligence + rocket text explanations" },
    { agent_id: "build-parser", monthly_usd_cap: 5.00, notes: "Calendar event → build/BOM extraction" },
];

async function main() {
    console.log("\n💰 Agent Budget Seeding\n");

    const db = createClient();
    if (!db) {
        console.error("❌ Supabase client unavailable — check env vars.");
        process.exit(1);
    }

    let created = 0;
    let existing = 0;

    for (const config of BUDGETS) {
        const { data, error } = await db
            .from("agent_budget")
            .select("agent_id")
            .eq("agent_id", config.agent_id)
            .maybeSingle();

        if (error) {
            console.warn(`  ⚠️ ${config.agent_id}: query error — ${error.message}`);
            continue;
        }

        if (data) {
            // Update caps if changed
            await db.from("agent_budget").update({
                monthly_usd_cap: config.monthly_usd_cap,
                notes: config.notes,
                updated_at: new Date().toISOString(),
            }).eq("agent_id", config.agent_id);
            existing++;
            console.log(`  ✅ ${config.agent_id.padEnd(22)} $${config.monthly_usd_cap.toFixed(2)}/mo (updated)`);
        } else {
            await db.from("agent_budget").insert({
                agent_id: config.agent_id,
                monthly_usd_cap: config.monthly_usd_cap,
                current_period_start: new Date().toISOString(),
                current_period_usd_spent: 0,
                current_period_tokens_spent: 0,
                notes: config.notes,
            });
            created++;
            console.log(`  🆕 ${config.agent_id.padEnd(22)} $${config.monthly_usd_cap.toFixed(2)}/mo (new)`);
        }
    }

    const totalCap = BUDGETS.reduce((sum, b) => sum + b.monthly_usd_cap, 0);

    console.log(`\n  ─────────────────────────────────────`);
    console.log(`  Created: ${created}  Updated: ${existing}  Total cap: $${totalCap.toFixed(2)}/mo`);
    console.log(`\n📊 Next: chargeBudget() will auto-track per-agent spend.`);
    console.log(`   View budget status at /api/dashboard/budget-status\n`);
}

main().catch(err => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
});
