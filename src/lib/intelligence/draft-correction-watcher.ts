/**
 * @file    src/lib/intelligence/draft-correction-watcher.ts
 * @purpose Watch threads Aria drafted replies into, and learn from how Bill
 *          actually handled them:
 *
 *            sent unchanged → confirm pattern (no rule needed)
 *            sent edited    → extract Bill's phrasing → learn a `template` rule
 *            deleted unsent → learn a `no_reply` rule (stop drafting for this)
 *
 *          Polls Gmail every ~30m (not daily like the gold-sample collector)
 *          so corrections land within Bill's review window, not a day later.
 *
 *          This is the "apply + learn" layer the gold-sample collector lacks:
 *          it writes to email_reply_rules, which the ACK agent reads before
 *          composing any routine draft.
 *
 * @author  Hermia
 * @created 2026-08-11
 * @deps    ./gmail-sent-reader, ./email-reply-rules, ../db
 */

import { createClient } from "../db";
import { findSentRepliesInThread } from "./gmail-sent-reader";
import {
    applyReplyTemplate,
    findReplyRule,
    inferReplyContext,
    learnReplyRule,
    normalizeVendorKey,
    type ReplyRule,
} from "./email-reply-rules";

// ── Config ───────────────────────────────────────────────────────────────────

/** Look back this many days for draft events. */
const LOOKBACK_DAYS = 7;

/** Draft events younger than this are skipped — Bill hasn't had time to review. */
const MIN_DRAFT_AGE_HOURS = 1;

/** Below this edit ratio we treat the send as "unchanged" (no rule to learn). */
const EDIT_THRESHOLD = 0.15;

/**
 * Edit ratio: what fraction of Bill's sent tokens were NOT present in the
 * draft. 0 = identical, 1 = total rewrite. Higher = he changed more.
 */
function editRatio(draft: string, sent: string): number {
    const dTokens = new Set(
        (draft || "").split(/\s+/).filter(Boolean).map((t) => t.toLowerCase()),
    );
    const sTokens = (sent || "").split(/\s+/).filter(Boolean);
    if (sTokens.length === 0) return 1;
    const changed = sTokens.filter((t) => !dTokens.has(t.toLowerCase())).length;
    return changed / sTokens.length;
}

/** Replace the recipient first name in a sent body with the {name} placeholder. */
function generalizeName(sentBody: string, firstName: string): string {
    if (!firstName || !sentBody) return sentBody;
    const re = new RegExp(`\\b${firstName}\\b`, "gi");
    return sentBody.replace(re, "{name}");
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CorrectionWatchResult {
    scanned: number;
    learned: number;
    confirmed: number;
    noReplyRules: number;
    pending: number;
    errors: number;
    details: Array<{
        threadId: string;
        vendorKey: string;
        context: string;
        outcome: "learned_template" | "learned_no_reply" | "confirmed_unchanged" | "pending";
        error?: string;
    }>;
}

/**
 * Main entry point. Polls un-sampled draft events, checks Gmail for Bill's
 * handling, and learns a rule per corrected draft.
 *
 * @param gmail   Authenticated Gmail API client (injected — no auth here)
 * @param myEmail Bill's address; used to find his sent replies
 */
export async function watchDraftCorrections(
    gmail: any,
    myEmail: string,
): Promise<CorrectionWatchResult> {
    const db = createClient();
    const result: CorrectionWatchResult = {
        scanned: 0,
        learned: 0,
        confirmed: 0,
        noReplyRules: 0,
        pending: 0,
        errors: 0,
        details: [],
    };

    if (!db) {
        console.warn("[draft-correction-watcher] DB unavailable");
        return result;
    }

    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const minAge = new Date(Date.now() - MIN_DRAFT_AGE_HOURS * 3600000).toISOString();

    const { data: events, error: queryErr } = (await db
        .from("feedback_events")
        .select("*")
        .eq("event_type", "email_draft_prepared")
        .gte("created_at", since)
        .lt("created_at", minAge)
        .order("created_at", { ascending: false })
        .limit(50)) as {
        data: Array<{
            id: string;
            subject_id: string | null;
            prediction: Record<string, any> | null;
            actual_outcome: Record<string, any> | null;
        }> | null;
        error: { message: string } | null;
    };

    if (queryErr) {
        console.error(`[draft-correction-watcher] query error: ${queryErr.message}`);
        return result;
    }

    result.scanned = (events || []).length;

    for (const event of events || []) {
        const prediction = (event.prediction || {}) as Record<string, any>;
        const threadId: string | null = prediction?.threadId ?? null;
        const draftBody: string = prediction?.replyBody || "";
        const alreadyResolved = prediction?.correctionResolvedAt != null;

        if (!threadId || alreadyResolved || !draftBody) continue;

        const fromEmail: string = (event.actual_outcome as any)?.fromEmail ?? "";
        const subject: string = (event.actual_outcome as any)?.subject ?? "";
        const kind: string = prediction?.kind ?? "routine";
        const vendorKey = normalizeVendorKey(fromEmail);
        const context = inferReplyContext(kind, subject, draftBody);

        try {
            const sent = await findSentRepliesInThread(gmail, threadId, myEmail);

            if (!sent || !sent.body) {
                // No sent reply. Is the draft still sitting in Drafts?
                const draftStillExists = await draftExists(gmail, prediction?.draftId);
                if (draftStillExists) {
                    result.pending++;
                    result.details.push({ threadId, vendorKey, context, outcome: "pending" });
                    continue;
                }
                // Draft gone AND no sent reply → Bill deleted it unsent.
                await learnReplyRule({
                    vendorKey,
                    context,
                    ruleType: "no_reply",
                    sourceDraftBody: draftBody,
                    sourceEventId: event.id,
                });
                result.noReplyRules++;
                result.learned++;
                result.details.push({ threadId, vendorKey, context, outcome: "learned_no_reply" });
            } else {
                const ratio = editRatio(draftBody, sent.body);
                if (ratio < EDIT_THRESHOLD) {
                    result.confirmed++;
                    result.details.push({ threadId, vendorKey, context, outcome: "confirmed_unchanged" });
                } else {
                    // Bill edited. Generalize his first name to {name} and store.
                    const first = prediction?.firstName || extractNameFromDraft(draftBody);
                    const template = generalizeName(sent.body, first);
                    await learnReplyRule({
                        vendorKey,
                        context,
                        ruleType: "template",
                        template,
                        sourceDraftBody: draftBody,
                        sourceSentBody: sent.body,
                        sourceEventId: event.id,
                    });
                    result.learned++;
                    result.details.push({ threadId, vendorKey, context, outcome: "learned_template" });
                }
            }

            // Mark resolved so we don't re-process this event next poll.
            const updated = { ...prediction, correctionResolvedAt: new Date().toISOString() };
            await db.from("feedback_events").update({ prediction: updated }).eq("id", event.id);
        } catch (err: any) {
            result.errors++;
            result.details.push({ threadId, vendorKey, context, outcome: "pending", error: err.message });
            console.error(`[draft-correction-watcher] error on ${threadId}: ${err.message}`);
        }
    }

    console.log(
        `[draft-correction-watcher] scanned=${result.scanned} learned=${result.learned} ` +
        `noReply=${result.noReplyRules} confirmed=${result.confirmed} pending=${result.pending} errors=${result.errors}`,
    );

    return result;
}

/**
 * True when the Gmail draft (by id) still exists — meaning Bill has not yet
 * sent or discarded it. A 404 (draft gone) is the deleted/sent signal.
 */
async function draftExists(gmail: any, draftId: string | null | undefined): Promise<boolean> {
    if (!draftId) return false; // no id → treat as gone (can't confirm otherwise)
    try {
        await gmail.users.drafts.get({ userId: "me", id: draftId });
        return true;
    } catch {
        return false;
    }
}

/**
 * Pull a first name from the draft body ("Hi Donna," → "Donna") so we can
 * generalize the edited sent body into a reusable {name} template.
 */
function extractNameFromDraft(draftBody: string): string {
    const m = draftBody.match(/^hi\s+([A-Za-z'-]+)\s*,/i) || draftBody.match(/^thanks?\s+([A-Za-z'-]+)/i);
    return m ? m[1] : "";
}

// ── Draft-time application helper ────────────────────────────────────────────

/**
 * Resolve what the ACK agent should draft for a vendor+context, honoring any
 * learned rule. Returns:
 *   { action: "no_reply" }                    — Bill deleted this before; skip drafting
 *   { action: "template", body }              — reuse Bill's own phrasing (name-filled)
 *   { action: "default" }                     — no rule; compose normally
 */
export async function resolveDraftAction(args: {
    from: string;
    kind: string;
    subject: string;
    bodyText: string;
    firstName: string;
}): Promise<
    | { action: "no_reply" }
    | { action: "template"; body: string }
    | { action: "default" }
> {
    const vendorKey = normalizeVendorKey(args.from);
    const context = inferReplyContext(args.kind, args.subject, args.bodyText);
    const rule: ReplyRule | null = await findReplyRule(vendorKey, context);

    if (!rule) return { action: "default" };
    if (rule.ruleType === "no_reply") return { action: "no_reply" };
    if (rule.ruleType === "template" && rule.template) {
        return { action: "template", body: applyReplyTemplate(rule.template, args.firstName) };
    }
    return { action: "default" };
}
