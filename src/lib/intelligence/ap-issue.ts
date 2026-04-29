/**
 * @file    ap-issue.ts
 * @purpose Phase 2 of the agentic issue lifecycle. AP-specific wrappers over
 *          agent-issue.ts so the AP pipeline (ap-agent.ts + reconciler.ts)
 *          can create + advance issues directly instead of relying on the
 *          projection cron to derive them after the fact.
 *
 *          Every helper here is BEST-EFFORT: a hub failure must never block
 *          the AP pipeline. Errors are logged and swallowed. The AP code
 *          path keeps working with whatever DB writes it does today; the
 *          issue ledger is purely additive observability + lifecycle.
 *
 *          Key derivation reuses keyFromFields() from issue-projection.ts
 *          so projection-derived and direct-write keys stay identical.
 *
 *          See docs/plans/2026-04-28-agentic-issue-lifecycle-phase1.md
 *          for Phase 1 ledger semantics; this file is the Phase 2 producer.
 */

import * as agentIssue from "./agent-issue";
import { keyFromFields } from "./issue-projection";

// ── Constants ────────────────────────────────────────────────────────────────
//
// Borrowed from AIOS's "tool/agent registry" pattern — naming agents and
// handoff reasons in one place keeps the issue ledger queryable (e.g. "show
// all handoffs into HANDLER.WILL") and prevents string drift across
// ap-agent.ts + reconciler.ts.

export const HANDLER = {
    AP_AGENT: "ap-agent",
    AP_RECONCILER: "ap-reconciler",
    WILL: "will",
} as const;

export const HANDOFF_REASON = {
    NEEDS_APPROVAL_DASHBOARD: "needs_approval — dashboard review",
    NEEDS_APPROVAL_TELEGRAM: "needs_approval — Telegram",
} as const;

export type ApFlowFields = {
    vendorName?: string | null;
    invoiceNumber?: string | null;
    poNumber?: string | null;
    orderId?: string | null;
    /** Last-resort source binding when no vendor identity is available yet. */
    gmailMessageId?: string | null;
};

/**
 * Build the canonical inputs payload for an AP issue. Centralized so
 * ap-agent.ts (reconcileAndUpdate, dropship path, error path) and
 * reconciler.ts (storePendingApproval) all write identical shapes — which
 * matters for projection's businessFlowKey() to keep colliding on the
 * same key as direct writes.
 */
export function apFlowInputs(
    f: ApFlowFields & { verdict?: string | null; matchStrategy?: string | null; extras?: Record<string, unknown> },
): Record<string, unknown> {
    return {
        invoice_number: f.invoiceNumber ?? null,
        vendor_name: f.vendorName ?? null,
        po_number: f.poNumber ?? null,
        order_id: f.orderId ?? null,
        gmail_message_id: f.gmailMessageId ?? null,
        ...(f.verdict ? { verdict: f.verdict } : {}),
        ...(f.matchStrategy ? { match_strategy: f.matchStrategy } : {}),
        ...(f.extras ?? {}),
    };
}

/**
 * Compute the AP-flow business key. Falls back to gmail_messages:<id> when
 * vendor isn't known (e.g. dropship-forward failures before extraction).
 * Returns null only when nothing identifies the flow at all.
 */
export function apIssueKey(fields: ApFlowFields): string | null {
    const direct = keyFromFields({
        vendorName: fields.vendorName,
        invoiceNumber: fields.invoiceNumber,
        poNumber: fields.poNumber,
        orderId: fields.orderId,
    });
    if (direct) return direct;
    if (fields.gmailMessageId) return `gmail_messages:${fields.gmailMessageId}`;
    return null;
}

function logWarn(stage: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ap-issue] ${stage}: ${msg}`);
}

export type EnsureApIssueArgs = ApFlowFields & {
    title?: string;
    handler?: string;
    nextAction?: string | null;
    lifecycleState?: agentIssue.IssueLifecycleState;
    autonomyState?: agentIssue.IssueAutonomyState | null;
    sourceTable?: string | null;
    sourceId?: string | null;
    priority?: number;
    owner?: string;
    inputs?: Record<string, unknown>;
};

/**
 * Create or advance the AP issue for a flow. Returns the issue id, or null
 * if the hub is disabled / we can't derive a key / the write failed.
 *
 * Callers do NOT need to handle the null case — they can just drop the id
 * and continue. The AP pipeline does not depend on the issue ledger.
 */
export async function ensureApIssue(args: EnsureApIssueArgs): Promise<string | null> {
    try {
        const key = apIssueKey(args);
        if (!key) return null;

        const title = args.title
            ?? defaultTitle(args)
            ?? "AP flow";

        const issue = await agentIssue.createOrAdvance({
            businessFlowKey: key,
            title,
            sourceTable: args.sourceTable ?? null,
            sourceId: args.sourceId ?? null,
            lifecycleState: args.lifecycleState ?? "working",
            autonomyState: args.autonomyState ?? "working",
            currentHandler: args.handler ?? null,
            nextAction: args.nextAction ?? null,
            priority: args.priority,
            owner: args.owner,
            inputs: args.inputs,
        });
        return issue?.id ?? null;
    } catch (err) {
        logWarn("ensureApIssue", err);
        return null;
    }
}

function defaultTitle(f: ApFlowFields): string | null {
    if (f.invoiceNumber && f.vendorName) return `Invoice ${f.invoiceNumber} from ${f.vendorName}`;
    if (f.invoiceNumber) return `Invoice ${f.invoiceNumber}`;
    if (f.poNumber && f.vendorName) return `PO ${f.poNumber} — ${f.vendorName}`;
    if (f.poNumber) return `PO ${f.poNumber}`;
    if (f.vendorName && f.gmailMessageId) return `${f.vendorName} email`;
    return null;
}

/**
 * Look up an existing AP issue by flow fields. Backed by the
 * `idx_agent_issue_business_flow_key` index — O(1) lookup, not a scan.
 *
 * Defaults to OPEN issues only (matching the unique partial index). Pass
 * `{ includeClosed: true }` to also match completed flows — useful when
 * an approve/reject arrives for an issue we already auto-completed in a
 * different code path, so we can append a final event to the same row
 * instead of leaving the decision orphaned.
 */
export async function findApIssue(
    fields: ApFlowFields,
    opts: { includeClosed?: boolean } = {},
): Promise<string | null> {
    try {
        const key = apIssueKey(fields);
        if (!key) return null;
        const issue = await agentIssue.getByBusinessFlowKey(key, !opts.includeClosed);
        return issue?.id ?? null;
    } catch (err) {
        logWarn("findApIssue", err);
        return null;
    }
}

/** Wrap recordHandoff so callers don't need to import agent-issue directly. */
export async function recordApHandoff(
    issueId: string,
    fromHandler: string | null,
    toHandler: string,
    reason: string,
): Promise<void> {
    try {
        await agentIssue.recordHandoff(issueId, fromHandler, toHandler, reason);
    } catch (err) {
        logWarn("recordApHandoff", err);
    }
}

/**
 * Block an AP issue. Per the Phase 1 guardrail, setBlocker is the ONLY path
 * into lifecycle_state=blocked. Callers must pick a real reason from the
 * IssueBlockerReason enum — there's no "soft block".
 */
export async function blockApIssue(
    issueId: string,
    reason: agentIssue.IssueBlockerReason,
    nextAction: string,
): Promise<void> {
    try {
        await agentIssue.setBlocker(issueId, reason, nextAction);
    } catch (err) {
        logWarn("blockApIssue", err);
    }
}

/** Clear an explicit blocker — only path back out of `blocked`. */
export async function unblockApIssue(
    issueId: string,
    resumeState: agentIssue.IssueLifecycleState = "working",
): Promise<void> {
    try {
        await agentIssue.clearBlocker(issueId, resumeState);
    } catch (err) {
        logWarn("unblockApIssue", err);
    }
}

/** Mark the AP issue resolved with structured outputs. */
export async function completeApIssue(
    issueId: string,
    outputs: Record<string, unknown> = {},
): Promise<void> {
    try {
        await agentIssue.complete(issueId, outputs);
    } catch (err) {
        logWarn("completeApIssue", err);
    }
}

/** Link an agent_task row to an AP issue (sets agent_task.issue_id). */
export async function linkApTask(taskId: string, issueId: string): Promise<void> {
    try {
        await agentIssue.linkTask(taskId, issueId);
    } catch (err) {
        logWarn("linkApTask", err);
    }
}
