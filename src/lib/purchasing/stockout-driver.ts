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
 *   1. Computes margin = adjustedRunwayDays - leadTimeDays per SKU
 *   2. Buckets into countdown tiers: stockout in ≤14d, ≤7d, ≤3d, TODAY, PAST DUE
 *   3. For each tier, verifies a draft PO exists for the supplier; creates one if not
 *   4. Sends ONE Telegram with the countdown + inline "Send" buttons per draft
 *
 * @created 2026-06-11
 */

import { createClient } from "@/lib/db";
import { FinaleClient } from "@/lib/finale/client";
import { notifyViaTask } from "@/lib/intelligence/notify-via-task";
import { runDrafterAgent, type DrafterAgentResult } from "@/lib/purchasing/drafter-agent";

// ── Countdown thresholds (margin days) ──────────────────────────────────
// margin = adjustedRunwayDays - leadTimeDays
// Negative margin = already past the "should have ordered" window.
const TIERS: Array<{ label: string; emoji: string; maxMargin: number; priority: number }> = [
    { label: "OVERDUE",    emoji: "🚨", maxMargin: -1, priority: 0 },
    { label: "TODAY",      emoji: "🔴", maxMargin: 0,  priority: 0 },
    { label: "3 DAYS",     emoji: "🟠", maxMargin: 3,  priority: 1 },
    { label: "7 DAYS",     emoji: "🟡", maxMargin: 7,  priority: 2 },
    { label: "14 DAYS",    emoji: "⚪", maxMargin: 14, priority: 3 },
];

interface StockoutCandidate {
    productId: string;
    productName: string;
    dailyRate: number;
    stockOnHand: number;
    runwayDays: number;
    adjustedRunwayDays: number;
    leadTimeDays: number;
    margin: number;
    tier: typeof TIERS[number];
    supplierPartyId: string;
    supplierName: string | null;
}

async function computeStockoutCandidates(finale: FinaleClient): Promise<StockoutCandidate[]> {
    const intell = await finale.getPurchasingIntelligence();
    const candidates: StockoutCandidate[] = [];

    for (const item of intell) {
        const dailyRate = item.dailyRate ?? 0;
        if (dailyRate <= 0) continue;

        const runwayDays = item.runwayDays ?? (item.stockOnHand > 0 ? item.stockOnHand / dailyRate : 0);
        const adjustedRunway = item.adjustedRunwayDays ?? runwayDays;
        const leadTime = item.leadTimeDays ?? 21;
        const margin = adjustedRunway - leadTime;

        if (margin > 14) continue;

        const tier = TIERS.find(t => margin <= t.maxMargin);
        if (!tier) continue;

        candidates.push({
            productId: item.productId ?? "",
            productName: item.productName ?? item.productId ?? "?",
            dailyRate,
            stockOnHand: item.stockOnHand ?? 0,
            runwayDays,
            adjustedRunwayDays: adjustedRunway,
            leadTimeDays: leadTime,
            margin: Math.round(margin * 10) / 10,
            tier,
            supplierPartyId: item.supplierPartyId ?? "",
            supplierName: item.supplierName ?? null,
        });
    }

    return candidates;
}

interface SupplierDraftStatus {
    supplierPartyId: string;
    supplierName: string | null;
    candidates: StockoutCandidate[];
    hasExistingDraft: boolean;
    draftOrderId: string | null;
}

async function checkSupplierDrafts(
    candidates: StockoutCandidate[],
): Promise<SupplierDraftStatus[]> {
    const bySupplier = new Map<string, StockoutCandidate[]>();
    for (const c of candidates) {
        const key = c.supplierPartyId || "unknown";
        const list = bySupplier.get(key) ?? [];
        list.push(c);
        bySupplier.set(key, list);
    }

    const sb = createClient();
    const statuses: SupplierDraftStatus[] = [];

    for (const [supplierPartyId, supplierCandidates] of bySupplier) {
        let hasDraft = false;
        let draftId: string | null = null;
        if (sb) {
            const { data } = await sb
                .from("draft_pos")
                .select("draft_po_id")
                .eq("supplier_party_id", supplierPartyId)
                .eq("status", "draft")
                .limit(1);
            hasDraft = !!(data && data.length > 0);
            draftId = data?.[0]?.draft_po_id ?? null;
        }

        statuses.push({
            supplierPartyId,
            supplierName: supplierCandidates[0]?.supplierName ?? null,
            candidates: supplierCandidates.sort((a, b) => a.margin - b.margin),
            hasExistingDraft: hasDraft,
            draftOrderId: draftId,
        });
    }

    return statuses;
}

export async function runStockoutDriver(): Promise<{
    candidates: number;
    draftsCreated: number;
    draftsExisting: number;
    telegramSent: boolean;
}> {
    const finale = new FinaleClient();
    const candidates = await computeStockoutCandidates(finale);

    if (candidates.length === 0) {
        console.log("[stockout-driver] All items have >14d margin — nothing to drive.");
        return { candidates: 0, draftsCreated: 0, draftsExisting: 0, telegramSent: false };
    }

    const supplierStatuses = await checkSupplierDrafts(candidates);

    let draftsCreated = 0;
    const needsDraft = supplierStatuses.filter(v => !v.hasExistingDraft);
    if (needsDraft.length > 0) {
        console.log(`[stockout-driver] ${needsDraft.length} supplier(s) need drafts — running drafter-agent.`);
        const result: DrafterAgentResult = await runDrafterAgent();
        draftsCreated = result.created;
        console.log(`[stockout-driver] Drafter created ${draftsCreated} draft(s).`);

        const updated = await checkSupplierDrafts(candidates);
        supplierStatuses.length = 0;
        supplierStatuses.push(...updated);
    }

    const draftsExisting = supplierStatuses.filter(v => v.hasExistingDraft).length;

    const flat = supplierStatuses.flatMap(v =>
        v.candidates.map(c => ({ ...c, hasDraft: v.hasExistingDraft, draftId: v.draftOrderId }))
    ).sort((a, b) => a.tier.priority - b.tier.priority);

    const lines: string[] = [];
    let currentTier: string | null = null;

    for (const c of flat) {
        if (c.tier.label !== currentTier) {
            currentTier = c.tier.label;
            lines.push(`\n${c.tier.emoji} *${c.tier.label}:*`);
        }
        const supplierTag = c.supplierName ? ` · ${c.supplierName}` : "";
        lines.push(
            `• \`${c.productId}\` — ${Math.round(c.stockOnHand)} on hand, ` +
            `~${c.runwayDays.toFixed(0)}d runway${supplierTag}\n` +
            `  margin: ${c.margin}d ${c.hasDraft ? `| 📋 PO ready (${c.draftId ?? "draft"})` : "| ⏳ no draft"}`
        );
    }

    const goal = [
        `🎯 *Stockout Driver* — ${candidates.length} item(s) in countdown window`,
        `${supplierStatuses.filter(v => v.hasExistingDraft).length} supplier draft(s) ready`,
        draftsCreated > 0 ? `✅ ${draftsCreated} draft(s) just created by drafter` : "",
        lines.join("\n"),
        "\n_Send these drafts now. Every hour = closer to stockout._",
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
                count: flat.filter(c => c.tier.label === t.label).length,
            })).filter(x => x.count > 0),
        },
        priority: 0,
        summaryLabel: "Stockout Driver",
    });

    return {
        candidates: candidates.length,
        draftsCreated,
        draftsExisting,
        telegramSent: true,
    };
}
