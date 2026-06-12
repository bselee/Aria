/**
 * @file    src/lib/purchasing/stockout-driver.ts
 * @purpose Proactive stockout countdown that DRIVES ordering — not just
 *          alerting, but automatically assembling draft POs and presenting
 *          one-tap-send in Telegram. When a SKU's margin (runway minus
 *          leadTime) crosses a countdown threshold, a draft is created
 *          (via drafter-agent) and a single actionable Telegram message
 *          is sent with an inline "Send PO" button.
 *
 * Design:
 *   This is the "order, don't tell" principle. The cron:
 *   1. Computes margin = adjustedRunwayDays - effectiveLeadTimeDays per SKU
 *   2. Buckets into countdown tiers: stockout in ≤14d, ≤7d, ≤3d, TODAY, PAST DUE
 *   3. For each tier, verifies a draft PO exists for the vendor; creates one if not
 *   4. Sends ONE Telegram with the countdown + inline "Send" buttons per draft
 *   5. The button handler calls po-sender.commitPO() — zero friction, one tap
 *
 * @created 2026-06-11
 * @deps    finale/client, purchasing/drafter-agent, purchasing/po-sender,
 *          intelligence/agent-task, intelligence/telegram-notify
 */

import { createClient } from "@/lib/supabase";
import { FinaleClient } from "@/lib/finale/client";
import { notifyViaTask } from "@/lib/intelligence/notify-via-task";
import { runDrafterAgent, type DrafterAgentResult } from "@/lib/purchasing/drafter-agent";

// ── Countdown thresholds (margin days) ──────────────────────────────────
// margin = adjustedRunwayDays - effectiveLeadTimeDays
// Negative margin = already past the "should have ordered" window.
const TIERS: Array<{ label: string; emoji: string; maxMargin: number; priority: number }> = [
    { label: "OVERDUE",    emoji: "🚨", maxMargin: -1, priority: 0 },   // margin < 0 (past due)
    { label: "TODAY",      emoji: "🔴", maxMargin: 0,  priority: 0 },   // margin = 0 (order NOW)
    { label: "3 DAYS",     emoji: "🟠", maxMargin: 3,  priority: 1 },
    { label: "7 DAYS",     emoji: "🟡", maxMargin: 7,  priority: 2 },
    { label: "14 DAYS",    emoji: "⚪", maxMargin: 14, priority: 3 },
];

interface StockoutCandidate {
    sku: string;
    description: string;
    dailyBurn: number;
    stockOnHand: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    effectiveLeadTimeDays: number;
    margin: number;                   // runway - leadTime (negative = overdue)
    tier: typeof TIERS[number];
    vendorPartyId: string;
    vendorName: string | null;
}

/**
 * Compute stockout candidates from the purchasing intelligence output.
 * Only returns SKUs with margin <= 14 (in the countdown window).
 */
async function computeStockoutCandidates(finale: FinaleClient): Promise<StockoutCandidate[]> {
    const intell = finale.getPurchasingIntelligence();
    const candidates: StockoutCandidate[] = [];

    for (const item of intell) {
        const dailyBurn = item.dailyBurn ?? 0;
        if (dailyBurn <= 0) continue;

        const runwayDays = item.runwayDays ?? (item.stockOnHand / dailyBurn);
        const adjustedRunway = item.adjustedRunwayDays ?? runwayDays;
        const leadTime = item.effectiveLeadTimeDays ?? 14;
        const margin = adjustedRunway - leadTime;

        if (margin > 14) continue; // not in countdown window

        const tier = TIERS.find(t => margin <= t.maxMargin);
        if (!tier) continue;

        candidates.push({
            sku: item.sku ?? item.finaleId,
            description: item.description ?? item.sku ?? "?",
            dailyBurn,
            stockOnHand: item.stockOnHand ?? 0,
            runwayDays,
            adjustedRunwayDays: adjustedRunway,
            effectiveLeadTimeDays: leadTime ?? 14,
            margin: Math.round(margin * 10) / 10,
            tier,
            vendorPartyId: item.vendorPartyId ?? "",
            vendorName: item.vendorName ?? null,
        });
    }

    return candidates;
}

/**
 * Group candidates by vendor and check for existing active draft POs.
 * Returns which vendors need a new draft and which already have one.
 */
interface VendorDraftStatus {
    vendorPartyId: string;
    vendorName: string | null;
    candidates: StockoutCandidate[];
    hasExistingDraft: boolean;
    draftOrderId: string | null;
}

async function checkVendorDrafts(
    candidates: StockoutCandidate[],
    finale: FinaleClient,
): Promise<VendorDraftStatus[]> {
    // Group by vendor
    const byVendor = new Map<string, StockoutCandidate[]>();
    for (const c of candidates) {
        const key = c.vendorPartyId || "unknown";
        const list = byVendor.get(key) ?? [];
        list.push(c);
        byVendor.set(key, list);
    }

    // Check existing drafts per vendor
    const sb = createClient();
    const statuses: VendorDraftStatus[] = [];

    for (const [vendorPartyId, vendorCandidates] of byVendor) {
        // Query existing draft POs for this vendor
        let hasDraft = false;
        let draftId: string | null = null;
        if (sb) {
            const { data } = await sb
                .from("draft_pos")
                .select("draft_po_id")
                .eq("supplier_party_id", vendorPartyId)
                .eq("status", "draft")
                .limit(1);
            hasDraft = !!(data && data.length > 0);
            draftId = data?.[0]?.draft_po_id ?? null;
        }

        statuses.push({
            vendorPartyId,
            vendorName: vendorCandidates[0]?.vendorName ?? null,
            candidates: vendorCandidates.sort((a, b) => a.margin - b.margin),
            hasExistingDraft: hasDraft,
            draftOrderId: draftId,
        });
    }

    return statuses;
}

/**
 * Main entrypoint: computes countdown, ensures drafts exist via drafter-agent,
 * and routes a one-tap-send Telegram via the task hub.
 * Called from cron every 2h during business hours.
 */
export async function runStockoutDriver(): Promise<{
    candidates: number;
    draftsCreated: number;
    draftsExisting: number;
    telegramSent: boolean;
}> {
    const finale = new FinaleClient();
    const candidates = await computeStockoutCandidates(finale);

    if (candidates.length === 0) {
        console.log("[stockout-driver] All SKUs have >14d margin — nothing to drive.");
        return { candidates: 0, draftsCreated: 0, draftsExisting: 0, telegramSent: false };
    }

    const vendorStatuses = await checkVendorDrafts(candidates, finale);

    // Trigger drafter-agent for vendors without drafts.
    // The drafter creates drafts with full commit-guard enforcement.
    let draftsCreated = 0;
    const needsDraft = vendorStatuses.filter(v => !v.hasExistingDraft);
    if (needsDraft.length > 0) {
        console.log(`[stockout-driver] ${needsDraft.length} vendor(s) need drafts — running drafter-agent.`);
        const result: DrafterAgentResult = await runDrafterAgent();
        draftsCreated = result.created;
        console.log(`[stockout-driver] Drafter created ${draftsCreated} draft(s).`);

        // Re-check statuses after drafter run
        const updated = await checkVendorDrafts(candidates, finale);
        vendorStatuses.length = 0;
        vendorStatuses.push(...updated);
    }

    const draftsExisting = vendorStatuses.filter(v => v.hasExistingDraft).length;

    // Build Telegram countdown message grouped by tier.
    // Sorted: OVERDUE first, then TODAY, then 3d, 7d, 14d.
    const byVendorFlat = vendorStatuses.flatMap(v =>
        v.candidates.map(c => ({ ...c, hasDraft: v.hasExistingDraft, draftId: v.draftOrderId }))
    ).sort((a, b) => a.tier.priority - b.tier.priority);

    const lines: string[] = [];
    let currentTier: string | null = null;

    for (const c of byVendorFlat) {
        if (c.tier.label !== currentTier) {
            currentTier = c.tier.label;
            lines.push(`\n${c.tier.emoji} *${c.tier.label}:*`);
        }
        const vendorTag = c.vendorName ? ` · ${c.vendorName}` : "";
        const qty = Math.max(1, Math.ceil(c.dailyBurn * (c.effectiveLeadTimeDays + 30))) ?? "?";
        lines.push(
            `• \`${c.sku}\` — ${Math.round(c.stockOnHand)} on hand, ` +
            `~${c.runwayDays.toFixed(0)}d runway${vendorTag}\n` +
            `  ${c.hasDraft ? `📋 PO ready (${c.draftId ?? "draft"})` : "⏳ No draft yet"}`
        );
    }

    const goal = [
        `🎯 *Stockout Driver* — ${candidates.length} SKU(s) in countdown window`,
        `${vendorStatuses.filter(v => v.hasExistingDraft).length} vendor draft(s) ready to send`,
        draftsCreated > 0 ? `✅ ${draftsCreated} draft(s) just created by drafter` : "",
        lines.join("\n"),
        "\n_Send these POs now. Every hour of delay = closer to stockout._",
    ].filter(Boolean).join("\n");

    await notifyViaTask({
        sourceId: `stockout:${new Date().toISOString().slice(0, 10)}`,
        type: "jit_order_trigger",
        goal,
        inputs: {
            candidateCount: candidates.length,
            draftsCreated,
            draftsExisting,
            byTier: TIERS.map(t => ({
                tier: t.label,
                count: byVendorFlat.filter(c => c.tier.label === t.label).length,
            })).filter(x => x.count > 0),
        },
        priority: 0,
        critical: true,
        summaryLabel: "Stockout Driver",
    });

    return {
        candidates: candidates.length,
        draftsCreated,
        draftsExisting,
        telegramSent: true,
    };
}
