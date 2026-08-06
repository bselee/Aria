/**
 * @file    src/lib/intelligence/gold-sample-collector.ts
 * @purpose Collect gold voice samples from Bill's sent replies in threads
 *          where Aria prepared a draft. When Bill edits a draft and sends,
 *          his final language is ground truth for the voice model.
 *
 *          Runs as a daily cron — not real-time — because Bill typically
 *          reviews and sends drafts within 1–2 days. We scan the last 7 days
 *          of draft events to find newly completed send cycles.
 *
 * HOW IT WORKS
 *   1. Query feedback_events → email_draft_prepared (last 7 days)
 *   2. For each with a threadId AND not yet sampled → findSentRepliesInThread
 *   3. If Bill sent a reply after the draft was created → log email_gold_sample
 *      with the draft body vs sent body + compute a simple diff ratio
 *   4. Mark the draft as sampled (update prediction.goldSampledAt) so we
 *      don't re-process
 *
 * Non-goals:
 *   - Does not train a model (pure collection)
 *   - Does not auto-correct future drafts (that's a later pass)
 *   - Does not block any pipeline (all errors are logged, never thrown)
 *
 * @author  Hermia
 * @created 2026-08-06
 * @deps    ./feedback-loop, ./gmail-sent-reader, ./db
 */

import { createClient } from "../db";
import { recordFeedback, type FeedbackCategory } from "./feedback-loop";
import { findSentRepliesInThread } from "./gmail-sent-reader";

// ── Config ───────────────────────────────────────────────────────────────────

/** Look back this many days for draft events. */
const LOOKBACK_DAYS = 7;

/** Draft events older than this can be harvested. Bill edits/sends within
 *  ~2 days; waiting 48h avoids premature "gold" on unreviewed drafts. */
const MIN_DRAFT_AGE_HOURS = 2;

/** Simple diff: what fraction of non-whitespace tokens changed? */
function tokenDiffRatio(draft: string, sent: string): number {
    const dTokens = draft.split(/\s+/).filter(Boolean);
    const sTokens = sent.split(/\s+/).filter(Boolean);
    if (sTokens.length === 0) return 1; // empty sent = total rewrite (unlikely)
    const dSet = new Set(dTokens.map((t) => t.toLowerCase()));
    const changed = sTokens.filter((t) => !dSet.has(t.toLowerCase())).length;
    return changed / sTokens.length;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface GoldSampleResult {
    /** Number of draft events scanned. */
    scanned: number;
    /** Number of gold samples collected (Bill sent + we logged). */
    goldCollected: number;
    /** Number of drafts where Bill had not yet replied. */
    noReplyYet: number;
    /** Errors (transient Gmail API failures, etc). */
    errors: number;
    details: Array<{
        threadId: string;
        draftBody: string;
        sentBody: string | null;
        diffRatio: number | null;
        error?: string;
    }>;
}

/**
 * Main entry point. Call with an authenticated Gmail client (default slot
 * for bill.selee@buildasoil.com).
 *
 * @param gmail  Authenticated Gmail API client (injected)
 * @param myEmail Email address whose Sent folder to read (bill.selee@...)
 */
export async function collectGoldSamples(
    gmail: any,
    myEmail: string,
): Promise<GoldSampleResult> {
    const db = createClient();
    const result: GoldSampleResult = {
        scanned: 0,
        goldCollected: 0,
        noReplyYet: 0,
        errors: 0,
        details: [],
    };

    if (!db) {
        console.warn("[gold-sample-collector] DB unavailable");
        return result;
    }

    // ── 1. Find draft events not yet marked as sampled ──────────────────
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    const minAge = new Date(Date.now() - MIN_DRAFT_AGE_HOURS * 3600000).toISOString();

    const { data: events, error: queryErr } = await db
        .from("feedback_events")
        .select("*")
        .eq("event_type", "email_draft_prepared")
        .gte("created_at", since)
        .lt("created_at", minAge) // exclude fresh drafts Bill hasn't reviewed
        .order("created_at", { ascending: false })
        .limit(50);

    if (queryErr) {
        console.error(`[gold-sample-collector] query error: ${queryErr.message}`);
        return result;
    }

    result.scanned = (events || []).length;

    for (const event of events || []) {
        const prediction = (event.prediction || {}) as Record<string, any>;
        const threadId: string | null = prediction?.threadId ?? null;
        const draftBody: string = prediction?.replyBody || "";
        const alreadySampled = prediction?.goldSampledAt != null;

        if (!threadId || alreadySampled || !draftBody) continue;

        try {
            const sent = await findSentRepliesInThread(gmail, threadId, myEmail);

            if (!sent || !sent.body) {
                result.noReplyYet++;
                result.details.push({
                    threadId,
                    draftBody,
                    sentBody: null,
                    diffRatio: null,
                });
                continue;
            }

            const diff = tokenDiffRatio(draftBody, sent.body);

            // Log the gold sample
            await recordFeedback({
                category: "correction" as FeedbackCategory,
                eventType: "email_gold_sample",
                agentSource: "gold-sample-collector",
                subjectType: "message",
                subjectId: event.subject_id,
                prediction: {
                    draftBody,
                    sentBody: sent.body,
                    diffRatio: diff,
                    draftId: prediction.draftId ?? null,
                    threadId,
                },
                actualOutcome: {
                    fromEmail: (event.actual_outcome as any)?.fromEmail ?? null,
                    collectedAt: new Date().toISOString(),
                },
                contextData: {
                    kind: prediction.kind ?? null,
                    sourceEventId: event.id,
                },
            });

            // Mark the draft event as sampled so we don't re-process
            const updatedPrediction = { ...prediction, goldSampledAt: new Date().toISOString() };
            await db
                .from("feedback_events")
                .update({ prediction: updatedPrediction })
                .eq("id", event.id);

            result.goldCollected++;
            result.details.push({
                threadId,
                draftBody,
                sentBody: sent.body,
                diffRatio: diff,
            });

            console.log(
                `[gold-sample-collector] ✅ Gold sample: thread=${threadId} diff=${(diff * 100).toFixed(0)}%`,
            );
        } catch (err: any) {
            result.errors++;
            result.details.push({
                threadId,
                draftBody,
                sentBody: null,
                diffRatio: null,
                error: err.message,
            });
            console.error(`[gold-sample-collector] Error on thread ${threadId}: ${err.message}`);
        }
    }

    console.log(
        `[gold-sample-collector] Done: scanned=${result.scanned} ` +
        `gold=${result.goldCollected} noreply=${result.noReplyYet} errors=${result.errors}`,
    );

    return result;
}
