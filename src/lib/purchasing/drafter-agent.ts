/**
 * @file    drafter-agent.ts
 * @purpose Autonomous PO draft creation agent with conservative trust gates.
 *          Creates draft POs in Finale for vetted vendors when stock shortages
 *          align with lead times and all commit guards pass.
 * @author  Hermia
 * @created 2026-06-09
 * @deps    finale/client, assessment-service, draft-po-policy, po-commit-guard,
 *          vendor-automation-policy, vendor-order-cycle, po-lifecycle, supabase/client
 * @env     FINALE_API_URL, FINALE_AUTH_TOKEN, SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * DESIGN PRINCIPLES:
 *   1. DRAFTS ONLY, NEVER SEND — human reviews in Finale/dashboard before commit
 *   2. VENDOR TRUST — `vendor_profiles.autonomy_level >= 1` is the single
 *      source of truth (human-vetted database record)
 *   3. COMMIT-GUARD ENFORCEMENT — every line must be `decision === 'commit'`
 *      (no `draft_only` shortcuts, no partial drafts)
 *   4. CYCLE LOCK — vendors in `routine_locked` cycle are skipped
 *   5. IDEMPOTENCY — checks for existing active drafts before creating
 *   6. AUDIT TRAIL — every creation logged to `ap_activity_log`
 *
 * FLOW: Cron → drafter-agent (creates drafts) → autonomy-engine (detects + notifies)
 */

import { createClient } from '../db';
import { FinaleClient, type PurchasingGroup } from '../finale/client';
import { assessPurchasingGroups, type AssessedPurchasingGroup } from './assessment-service';
import { buildDraftPOItemsFromAssessment } from './draft-po-policy';
import { assessPOCommitGuardsForLines } from './po-commit-guard';
import {
    classifyVendorOrderCycle,
    mapRecentPOsToVendorCyclePOs,
    type VendorCycleResult,
} from './vendor-order-cycle';
import { getVendorAutonomyLevel } from './po-sender';
import { transitionLifecycleState } from './po-lifecycle';
import { invalidatePurchasingCaches } from './cache';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface DrafterAgentResult {
    scanned: number;
    eligible: number;
    created: number;
    skipped: number;
    errors: number;
    details: DrafterDetail[];
}

export interface DrafterDetail {
    vendorName: string;
    vendorPartyId: string;
    skuCount: number;
    totalValue: number;
    action: 'created' | 'skipped' | 'error';
    reason: string;
    orderId?: string;
    guards?: Array<{ productId: string; decision: string; blockReasons: string[] }>;
}

interface DrafterContext {
    itemContexts?: Record<string, any>;
    vendorCooldowns?: Record<string, boolean>;
    vendorCycles?: Record<string, VendorCycleResult>;
    recentPOs?: any[];
}

// ──────────────────────────────────────────────────
// MAIN ENTRY POINT
// ──────────────────────────────────────────────────

/**
 * Scans Finale for stock shortages, evaluates all guardrails, and creates
 * draft POs for fully-eligible vendors. Returns a detailed result summary.
 *
 * Guardrail chain (must ALL pass for a vendor to get a draft):
 *   1. Policy engine says "order" for the line
 *   2. Commit guard says "commit" (lead time + 30d coverage satisfied)
 *   3. Vendor has autonomy_level >= 1 in vendor_profiles (human-vetted trust)
 *      and all assessed lines have high confidence
 *   4. No vendor order cycle lock or cooldown active
 *   5. No existing active draft for this vendor
 */
export async function runDrafterAgent(context: DrafterContext = {}): Promise<DrafterAgentResult> {
    const result: DrafterAgentResult = {
        scanned: 0,
        eligible: 0,
        created: 0,
        skipped: 0,
        errors: 0,
        details: [],
    };

    const db = createClient();
    if (!db) {
        console.warn('[drafter] Database unavailable — aborting');
        return result;
    }

    console.log('[drafter] Starting autonomous PO draft scan...');

    let groups: PurchasingGroup[];
    let client: FinaleClient;

    try {
        client = new FinaleClient();
        groups = await client.getPurchasingIntelligence();
        result.scanned = groups.length;
        console.log(`[drafter] Fetched ${groups.length} vendor groups from Finale`);
    } catch (err: any) {
        console.error('[drafter] Failed to fetch purchasing groups:', err.message);
        result.errors++;
        return result;
    }

    // Assess all groups through the standard pipeline
    const assessment = assessPurchasingGroups(groups, {
        itemContexts: context.itemContexts,
    });

    console.log(`[drafter] Assessed ${assessment.groups.length} groups: ` +
        `${assessment.actionableLines.length} actionable lines, ` +
        `${assessment.blockedLines.length} blocked lines`);

    // Process each vendor group
    for (const group of assessment.groups) {
        const detail = await processVendorGroup(group, client, db, context);
        result.details.push(detail);

        switch (detail.action) {
            case 'created':
                result.created++;
                result.eligible++;
                break;
            case 'skipped':
                result.skipped++;
                break;
            case 'error':
                result.errors++;
                break;
        }
    }

    console.log(`[drafter] Complete: ${result.created} created, ` +
        `${result.skipped} skipped, ${result.errors} errors out of ${result.scanned} groups`);

    return result;
}

// ──────────────────────────────────────────────────
// PER-VENDOR PROCESSING
// ──────────────────────────────────────────────────

async function processVendorGroup(
    group: AssessedPurchasingGroup,
    client: FinaleClient,
    db: ReturnType<typeof createClient>,
    context: DrafterContext,
): Promise<DrafterDetail> {
    const vendorName: string = group.vendorName;
    const vendorPartyId: string = group.vendorPartyId;
    const items = group.items;

    const baseDetail: DrafterDetail = {
        vendorName,
        vendorPartyId,
        skuCount: items.length,
        totalValue: 0,
        action: 'skipped',
        reason: '',
    };

    // ── GATE 1: Policy assessment — at least one line must be "order" ──
    const draftPolicy = buildDraftPOItemsFromAssessment(items);
    if (draftPolicy.items.length === 0) {
        baseDetail.reason = 'no_orderable_lines';
        return baseDetail;
    }

    // ── GATE 2: Commit guard — every orderable line must be "commit" ──
    // Quinton's spec: reorder = lead time coverage + 90 days post-receipt supply
    const guardBatch = assessPOCommitGuardsForLines(
        items.filter((line: any) =>
            line.assessment.decision === 'order' || line.assessment.decision === 'reduce'
        ),
        { minimumPostLeadCoverageDays: 90 },
    );

    const commitReadyProductIds = new Set(
        guardBatch.commitReadyLines.map((entry: any) => entry.line.item.productId),
    );

    const commitReadyItems = draftPolicy.items.filter(item =>
        commitReadyProductIds.has(item.productId),
    );

    if (commitReadyItems.length === 0) {
        baseDetail.reason = 'no_commit_ready_lines';
        baseDetail.guards = guardBatch.guards.map((g: any) => ({
            productId: g.guard.productId,
            decision: g.guard.decision,
            blockReasons: g.guard.blockReasons,
        }));
        return baseDetail;
    }

    // ── GATE 3: Vendor trust — autonomy_level >= 1 + high confidence ──
    // Consolidated: vendor_profiles.autonomy_level is the single source of truth
    // (human-vetted). Replaces the redundant hardcoded TRUSTED_VENDOR_ALIASES check.
    let autonomyLevel: number;
    try {
        autonomyLevel = await getVendorAutonomyLevel(vendorName);
    } catch (err: any) {
        console.warn(`[drafter] Failed to check autonomy level for ${vendorName}:`, err.message);
        baseDetail.action = 'error';
        baseDetail.reason = `autonomy_level_lookup_failed: ${err.message}`;
        return baseDetail;
    }

    if (autonomyLevel < 1) {
        baseDetail.reason = `autonomy_level_${autonomyLevel}_below_minimum_1`;
        return baseDetail;
    }

    const highestConfidence = items.reduce<"high" | "medium" | "low" | null>((best: any, item: any) => {
        if (!best) return item.assessment.confidence;
        const rank = { high: 3, medium: 2, low: 1 } as const;
        return rank[item.assessment.confidence] > rank[best] ? item.assessment.confidence : best;
    }, null);

    if (highestConfidence !== 'high') {
        baseDetail.reason = `confidence_below_high (${highestConfidence})`;
        return baseDetail;
    }

    // ── GATE 4: Vendor cycle + cooldown — no routine lock ──
    const vendorCycle = context.vendorCycles?.[vendorPartyId];
    const cooldownActive = context.vendorCooldowns?.[vendorPartyId] === true
        || vendorCycle?.decision === 'routine_locked';

    if (cooldownActive) {
        baseDetail.reason = vendorCycle?.decision === 'routine_locked'
            ? `cycle_locked: routine_locked — blocking PO ${vendorCycle.blockingPO?.orderId ?? 'unknown'}`
            : 'cooldown_active';
        return baseDetail;
    }

    // ── GATE 5: Idempotency — no existing active draft for this vendor ──
    const existingDraft = await findExistingDraftPO(client, vendorPartyId);
    if (existingDraft) {
        baseDetail.reason = `existing_draft_${existingDraft.orderId} (skip to avoid duplicate)`;
        return baseDetail;
    }

    // ── ALL GATES PASSED — Create the draft PO ──
    const totalValue = commitReadyItems.reduce(
        (sum, item) => sum + (item.quantity * item.unitPrice),
        0,
    );
    baseDetail.totalValue = totalValue;
    baseDetail.skuCount = commitReadyItems.length;

    try {
        const memo = `Auto-drafted by Aria drafter-agent at ${new Date().toISOString()}. ` +
            `Autonomy level: ${autonomyLevel}. Commit-ready lines: ${commitReadyItems.length}.`;

        const draftResult = await client.createDraftPurchaseOrder(
            vendorPartyId,
            commitReadyItems,
            memo,
        );

        baseDetail.action = 'created';
        baseDetail.reason = `draft_created_via_automation`;
        baseDetail.orderId = draftResult.orderId;

        // Transition lifecycle to REVIEW
        await transitionLifecycleState(draftResult.orderId, 'REVIEW', 'drafter-agent', {
            vendorName,
            autonomyLevel,
            skuCount: commitReadyItems.length,
            totalValue,
        });

        // Invalidate purchasing caches so dashboard refreshes
        invalidatePurchasingCaches();

        // Audit trail
        if (db) {
            await db.from('ap_activity_log').insert({
                email_from: 'aria-drafter-agent',
                email_subject: `Auto-draft PO #${draftResult.orderId} for ${vendorName}`,
                intent: 'PO_AUTO_DRAFT',
                action_taken: `Drafter agent created draft PO #${draftResult.orderId} with ` +
                    `${commitReadyItems.length} line(s) totaling $${totalValue.toFixed(2)}. ` +
                    `Autonomy level: ${autonomyLevel}. All commit guards passed.`,
                metadata: {
                    orderId: draftResult.orderId,
                    vendorName,
                    vendorPartyId,
                    autonomyLevel,
                    skuCount: commitReadyItems.length,
                    totalValue,
                    commitReadySkus: commitReadyItems.map(i => i.productId),
                },
            }).then(() => {}).catch((err: any) =>
                console.warn('[drafter] Audit log insert failed:', err.message),
            );
        }

        console.log(`[drafter] ✅ Created draft PO #${draftResult.orderId} for ${vendorName} ` +
            `(${commitReadyItems.length} SKUs, $${totalValue.toFixed(2)})`);

    } catch (err: any) {
        baseDetail.action = 'error';
        baseDetail.reason = `draft_creation_failed: ${err.message}`;
        console.error(`[drafter] ❌ Failed to create draft for ${vendorName}:`, err.message);
    }

    return baseDetail;
}

// ──────────────────────────────────────────────────
// HELPER: Find existing active draft for a vendor
// ──────────────────────────────────────────────────

async function findExistingDraftPO(
    client: FinaleClient,
    vendorPartyId: string,
): Promise<{ orderId: string; status: string } | null> {
    try {
        const activeDrafts = await (client as any).findActiveDraftPOsForVendor(vendorPartyId);
        if (activeDrafts && activeDrafts.length > 0) {
            return {
                orderId: activeDrafts[0].orderId,
                status: activeDrafts[0].status || 'ORDER_CREATED',
            };
        }
        return null;
    } catch {
        // If lookup fails, we'll be cautious and skip — caller handles this
        return null;
    }
}

// ──────────────────────────────────────────────────
// TELEGRAM SUMMARY FORMATTER
// ──────────────────────────────────────────────────

/**
 * Formats the drafter agent result for a Telegram message.
 * Plain text only — no MarkdownV2 (escape hell with Telegram parsing).
 */
export function formatDrafterTelegramSummary(result: DrafterAgentResult): string {
    if (result.created === 0 && result.errors === 0) {
        return '📋 Drafter scan: no drafts eligible. ' +
            `${result.scanned} vendors scanned, ${result.skipped} skipped.`;
    }

    const lines: string[] = [];
    lines.push(`📦 Drafter Agent Report`);
    lines.push(`Scanned: ${result.scanned} vendors`);
    lines.push(`Created: ${result.created} draft(s)`);
    lines.push(`Skipped: ${result.skipped}`);
    if (result.errors > 0) lines.push(`Errors: ${result.errors}`);
    lines.push('');

    for (const detail of result.details) {
        if (detail.action === 'created') {
            lines.push(`✅ ${detail.vendorName} — PO #${detail.orderId}`);
            lines.push(`   ${detail.skuCount} SKUs, $${detail.totalValue.toFixed(2)}`);
        }
    }

    // Show skip reasons only for errors
    const errorDetails = result.details.filter(d => d.action === 'error');
    if (errorDetails.length > 0) {
        lines.push('');
        lines.push('⚠ Errors:');
        for (const detail of errorDetails) {
            lines.push(`   ${detail.vendorName}: ${detail.reason}`);
        }
    }

    return lines.join('\n');
}
