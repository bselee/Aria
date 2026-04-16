/**
 * @file    feedback-loop.ts
 * @purpose Aria's Kaizen engine — unified feedback loop for continuous improvement.
 *          Captures corrections, outcomes, predictions, engagement, errors, and
 *          vendor reliability signals. Powers weekly self-review, threshold tuning,
 *          and nightly housekeeping.
 *
 *          8 Pillars: Correction · Outcome · Prediction · Engagement ·
 *                     Error Handling · Vendor Reliability · Self-Review · Housekeeping
 * @author  Will / Antigravity
 * @created 2026-03-06
 * @updated 2026-03-06
 * @deps    supabase, memory.ts, @pinecone-database/pinecone
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PINECONE_API_KEY
 */

import { createClient } from "../supabase";
import { remember } from "./memory";

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type FeedbackCategory =
    | "correction"
    | "outcome"
    | "error_pattern"
    | "engagement"
    | "prediction"
    | "vendor_reliability";

export type SubjectType = "vendor" | "sku" | "po" | "invoice" | "alert" | "message" | "build";

export type UserAction = "approved" | "rejected" | "ignored" | "corrected" | "engaged" | "snoozed";

export interface FeedbackEvent {
    category: FeedbackCategory;
    eventType: string;
    agentSource: string;
    subjectType?: SubjectType;
    subjectId?: string;
    prediction?: Record<string, any>;
    actualOutcome?: Record<string, any>;
    accuracyScore?: number;  // 0.0 - 1.0
    userAction?: UserAction;
    contextData?: Record<string, any>;
}

export interface AccuracyMetrics {
    category: string;
    totalEvents: number;
    scoredEvents: number;
    averageAccuracy: number;
    trend: "improving" | "stable" | "declining";
    previousPeriodAccuracy: number | null;
}

export interface VendorReliability {
    vendorName: string;
    overallScore: number;       // 0-100
    onTimePercent: number;
    invoiceAccuracy: number;
    avgResponseDays: number;
    documentQuality: number;
    trend: "improving" | "stable" | "declining";
    recentIssues: string[];
    eventCount: number;
}

export interface HousekeepingReport {
    feedbackEventsPruned: number;
    chatLogsPruned: number;
    exceptionsPruned: number;
    alertsPruned: number;
    pineconeMemoriesPruned: number;
    totalReclaimed: number;
}

// ──────────────────────────────────────────────────
// CORE: RECORD FEEDBACK
// ──────────────────────────────────────────────────

/**
 * Record a feedback event to the central feedback_events table.
 * This is the single entry point for ALL feedback signals in the system.
 * Non-blocking — logs errors but never throws.
 */
export async function recordFeedback(event: FeedbackEvent): Promise<void> {
    try {
        const db = createClient();
        if (!db) {
            console.warn("⚠️ [Kaizen] Supabase unavailable — skipping feedback recording");
            return;
        }

        const { error } = await db.from("feedback_events").insert({
            category: event.category,
            event_type: event.eventType,
            agent_source: event.agentSource,
            subject_type: event.subjectType || null,
            subject_id: event.subjectId || null,
            prediction: event.prediction || {},
            actual_outcome: event.actualOutcome || {},
            accuracy_score: event.accuracyScore ?? null,
            user_action: event.userAction || null,
            context_data: event.contextData || {},
            synced_to_memory: false,
        });

        if (error) {
            console.error(`❌ [Kaizen] Failed to record feedback: ${error.message}`);
            return;
        }

        console.log(`🔄 [Kaizen] Recorded: ${event.category}/${event.eventType} (${event.agentSource})`);
    } catch (err: any) {
        // Never block the calling agent due to feedback recording failure
        console.error(`❌ [Kaizen] recordFeedback error: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────
// ACCURACY ANALYSIS
// ──────────────────────────────────────────────────

// ──────────────────────────────────────────────────
// VENDOR RELIABILITY SCORING
// ──────────────────────────────────────────────────
// VENDOR RELIABILITY SCORING
// ──────────────────────────────────────────────────

/**
 * Compute a reliability score for a vendor based on all feedback signals.
 * Score ranges from 0-100. Pulls from vendor_reliability events plus
 * cross-references reconciliation corrections and PO tracking data.
 *
 * @param vendorName  The vendor to score
 * @param days  Lookback window (default 90 days)
 */
export async function getVendorReliability(
    vendorName: string,
    days: number = 90
): Promise<VendorReliability | null> {
    const db = createClient();
    if (!db) return null;

    try {
        const since = new Date(Date.now() - days * 86400000).toISOString();

        const { data: events, error } = await db
            .from("feedback_events")
            .select("*")
            .eq("subject_type", "vendor")
            .ilike("subject_id", `%${vendorName}%`)
            .gte("created_at", since)
            .order("created_at", { ascending: false });

        if (error) throw error;
        if (!events || events.length === 0) {
            return {
                vendorName,
                overallScore: -1,
                onTimePercent: -1,
                invoiceAccuracy: -1,
                avgResponseDays: -1,
                documentQuality: -1,
                trend: "stable",
                recentIssues: [],
                eventCount: 0,
            };
        }

        // Categorize events by type
        const deliveryEvents = events.filter(e => e.event_type.includes("delivery"));
        const invoiceEvents = events.filter(e => e.event_type.includes("reconcil") || e.event_type.includes("invoice"));
        const responseEvents = events.filter(e => e.event_type.includes("response"));
        const docEvents = events.filter(e => e.event_type.includes("document") || e.event_type.includes("ocr"));

        // Compute sub-scores
        const onTimePercent = deliveryEvents.length > 0
            ? (deliveryEvents.filter(e => (e.accuracy_score ?? 0) >= 0.8).length / deliveryEvents.length) * 100
            : -1;

        const invoiceAccuracy = invoiceEvents.length > 0
            ? (invoiceEvents.filter(e => e.user_action === "approved" || (e.accuracy_score ?? 0) >= 0.8).length / invoiceEvents.length) * 100
            : -1;

        const responseDays = responseEvents
            .map(e => e.actual_outcome?.response_days)
            .filter((d): d is number => typeof d === "number");
        const avgResponseDays = responseDays.length > 0
            ? responseDays.reduce((a, b) => a + b, 0) / responseDays.length
            : -1;

        const documentQuality = docEvents.length > 0
            ? (docEvents.filter(e => (e.accuracy_score ?? 0) >= 0.8).length / docEvents.length) * 100
            : -1;

        // Overall: weighted average of available sub-scores
        const weights = [
            { score: onTimePercent, weight: 0.35 },
            { score: invoiceAccuracy, weight: 0.30 },
            { score: avgResponseDays >= 0 ? Math.max(0, 100 - avgResponseDays * 10) : -1, weight: 0.15 },
            { score: documentQuality, weight: 0.20 },
        ].filter(w => w.score >= 0);

        const totalWeight = weights.reduce((a, b) => a + b.weight, 0);
        const overallScore = totalWeight > 0
            ? Math.round(weights.reduce((a, b) => a + b.score * b.weight, 0) / totalWeight)
            : -1;

        // Recent issues (last 5 negative events)
        const recentIssues = events
            .filter(e => e.user_action === "rejected" || (e.accuracy_score ?? 1) < 0.5)
            .slice(0, 5)
            .map(e => e.event_type.replace(/_/g, " "));

        // Trend: compare first half vs second half of events
        const midpoint = Math.floor(events.length / 2);
        const olderScores = events.slice(midpoint).map(e => e.accuracy_score).filter((s): s is number => s !== null);
        const newerScores = events.slice(0, midpoint).map(e => e.accuracy_score).filter((s): s is number => s !== null);
        const olderAvg = olderScores.length > 0 ? olderScores.reduce((a, b) => a + b, 0) / olderScores.length : null;
        const newerAvg = newerScores.length > 0 ? newerScores.reduce((a, b) => a + b, 0) / newerScores.length : null;

        let trend: "improving" | "stable" | "declining" = "stable";
        if (olderAvg !== null && newerAvg !== null) {
            const diff = newerAvg - olderAvg;
            if (diff > 0.05) trend = "improving";
            else if (diff < -0.05) trend = "declining";
        }

        return {
            vendorName,
            overallScore,
            onTimePercent: Math.round(onTimePercent),
            invoiceAccuracy: Math.round(invoiceAccuracy),
            avgResponseDays: Math.round(avgResponseDays * 10) / 10,
            documentQuality: Math.round(documentQuality),
            trend,
            recentIssues,
            eventCount: events.length,
        };
    } catch (err: any) {
        console.error(`❌ [Kaizen] getVendorReliability error: ${err.message}`);
        return null;
    }
}

// ──────────────────────────────────────────────────
// MEMORY SYNC — Push validated learnings to Pinecone
// ──────────────────────────────────────────────────

/**
 * Sync unsynced feedback events to Pinecone memory.
 * Only syncs events that have a clear learning signal:
 * - Corrections (accuracy_score = 0 or 1)
 * - High-confidence predictions
 * - Vendor reliability changes
 *
 * Batch processes up to 20 events per call to avoid overloading embeddings API.
 */
export async function syncLearningsToMemory(): Promise<number> {
    const db = createClient();
    if (!db) return 0;

    try {
        const { data: events, error } = await db
            .from("feedback_events")
            .select("*")
            .eq("synced_to_memory", false)
            .not("accuracy_score", "is", null)
            .order("created_at", { ascending: true })
            .limit(20);

        if (error) throw error;
        if (!events || events.length === 0) return 0;

        let synced = 0;

        for (const event of events) {
            const learning = buildLearningStatement(event);
            if (!learning) continue;

            try {
                await remember({
                    category: "decision",
                    content: learning,
                    relatedTo: event.subject_id || event.agent_source,
                    source: "KaizenLoop",
                    tags: ["kaizen", event.category, event.event_type],
                    priority: event.accuracy_score !== null && event.accuracy_score < 0.5 ? "high" : "normal",
                });

                await db
                    .from("feedback_events")
                    .update({ synced_to_memory: true })
                    .eq("id", event.id);

                synced++;
            } catch (memErr: any) {
                console.warn(`⚠️ [Kaizen] Memory sync failed for event ${event.id}: ${memErr.message}`);
            }
        }

        if (synced > 0) {
            console.log(`🧠 [Kaizen] Synced ${synced} learnings to Pinecone memory`);
        }

        return synced;
    } catch (err: any) {
        console.error(`❌ [Kaizen] syncLearningsToMemory error: ${err.message}`);
        return 0;
    }
}

/**
 * Convert a feedback event into a natural language learning statement
 * suitable for vector memory storage.
 */
function buildLearningStatement(event: any): string | null {
    const score = event.accuracy_score;
    const type = event.event_type;
    const subject = event.subject_id || "unknown";

    switch (event.category) {
        case "correction":
            if (event.user_action === "rejected") {
                return `LEARNED: For ${subject}, Aria's ${type} was rejected by Will. ` +
                    `Original prediction: ${JSON.stringify(event.prediction)}. ` +
                    `Correct action: ${JSON.stringify(event.actual_outcome)}. ` +
                    `Avoid this mistake pattern in the future.`;
            }
            if (event.user_action === "approved") {
                return `CONFIRMED: For ${subject}, Aria's ${type} was approved. ` +
                    `Prediction was correct: ${JSON.stringify(event.prediction)}.`;
            }
            return null;

        case "prediction":
            if (score !== null && score < 0.5) {
                return `INACCURATE PREDICTION: ${type} for ${subject} scored ${score}. ` +
                    `Predicted: ${JSON.stringify(event.prediction)}. ` +
                    `Actual: ${JSON.stringify(event.actual_outcome)}. ` +
                    `Need to recalibrate this prediction type.`;
            }
            if (score !== null && score >= 0.9) {
                return `ACCURATE PREDICTION: ${type} for ${subject} scored ${score}. ` +
                    `Prediction model is working well for this pattern.`;
            }
            return null;

        case "vendor_reliability":
            return `VENDOR UPDATE: ${subject} — ${type}. ` +
                `Score: ${score !== null ? Math.round(score * 100) : "N/A"}%. ` +
                `Details: ${JSON.stringify(event.actual_outcome)}.`;

        case "error_pattern":
            return `ERROR PATTERN: Agent ${event.agent_source} had ${type}. ` +
                `Resolution: ${event.user_action || "auto"}. ` +
                `Context: ${JSON.stringify(event.context_data)}.`;

        default:
            return null;
    }
}

// ──────────────────────────────────────────────────
// WEEKLY SELF-REVIEW (KAIZEN REPORT)
// ──────────────────────────────────────────────────

/**
 * Generate Aria's weekly Kaizen self-review report.
 * Produces a formatted Telegram message with accuracy metrics,
 * engagement stats, vendor reliability, and improvement proposals.
 *
 * @param days  Period to review (default 7)
 */
export async function generateSelfReview(days: number = 7): Promise<string> {
    const db = createClient();
    if (!db) return "⚠️ Cannot generate self-review — Supabase unavailable.";

    try {
        const since = new Date(Date.now() - days * 86400000).toISOString();

        // 1. Engagement stats
        const { data: engagementData } = await db
            .from("feedback_events")
            .select("event_type, user_action")
            .eq("category", "engagement")
            .gte("created_at", since);

        const engaged = (engagementData || []).filter(e => e.user_action === "engaged").length;
        const ignored = (engagementData || []).filter(e => e.user_action === "ignored").length;
        const totalEngagement = engaged + ignored;
        const engagementRate = totalEngagement > 0 ? Math.round((engaged / totalEngagement) * 100) : 0;

        // 3. Correction stats
        const { data: correctionData } = await db
            .from("feedback_events")
            .select("event_type, user_action")
            .eq("category", "correction")
            .gte("created_at", since);

        const approved = (correctionData || []).filter(e => e.user_action === "approved").length;
        const rejected = (correctionData || []).filter(e => e.user_action === "rejected").length;
        const totalCorrections = approved + rejected;

        // 4. Error patterns
        const { data: errorData } = await db
            .from("feedback_events")
            .select("agent_source, event_type")
            .eq("category", "error_pattern")
            .gte("created_at", since);

        // Build the report
        let report = `📊 <b>ARIA KAIZEN REPORT</b> — Past ${days} Days\n\n`;

        // Engagement section
        report += `\n📬 <b>Engagement</b>\n`;
        if (totalEngagement === 0) {
            report += `  <i>No engagement data yet</i>\n`;
        } else {
            report += `  Messages engaged with: <b>${engaged}/${totalEngagement}</b> (${engagementRate}%)\n`;
            if (ignored > 2) {
                report += `  ⚠️ ${ignored} alerts were ignored — consider reducing noise\n`;
            }
        }

        // Corrections section
        report += `\n✅ <b>Corrections</b>\n`;
        if (totalCorrections === 0) {
            report += `  <i>No corrections recorded yet</i>\n`;
        } else {
            const approvalRate = Math.round((approved / totalCorrections) * 100);
            report += `  Approved: ${approved} | Rejected: ${rejected} | Approval rate: <b>${approvalRate}%</b>\n`;
        }

        // Error patterns
        report += `\n🛡️ <b>Error Patterns</b>\n`;
        if (!errorData || errorData.length === 0) {
            report += `  <i>No errors this period — smooth sailing</i> ⛵\n`;
        } else {
            const byAgent = new Map<string, number>();
            for (const e of errorData) {
                byAgent.set(e.agent_source, (byAgent.get(e.agent_source) || 0) + 1);
            }
            for (const [agent, count] of byAgent) {
                report += `  ${agent}: ${count} error(s)\n`;
            }
        }

        // Learning summary
        const { count: learningSyncCount } = await db
            .from("feedback_events")
            .select("*", { count: "exact", head: true })
            .eq("synced_to_memory", true)
            .gte("created_at", since);

        report += `\n💡 <b>Learnings Synced to Memory:</b> ${learningSyncCount || 0}\n`;

        report += `\n<i>🔄 Kaizen — always improving.</i>`;

        return report;
    } catch (err: any) {
        console.error(`❌ [Kaizen] generateSelfReview error: ${err.message}`);
        return `⚠️ Self-review generation failed: ${err.message}`;
    }
}

// ──────────────────────────────────────────────────
// HOUSEKEEPING — Aria cleans up after herself (掃除)
// ──────────────────────────────────────────────────

/**
 * RETENTION POLICIES (hardcoded — Kaizen discipline):
 *
 * | Store               | Rule                                          | Retention |
 * |---------------------|-----------------------------------------------|-----------|
 * | feedback_events     | synced_to_memory=true AND > 90 days           | DELETE    |
 * | feedback_events     | unscored (accuracy_score IS NULL) AND > 30d   | DELETE    |
 * | feedback_events     | engagement "ignored" AND > 14 days            | DELETE    |
 * | sys_chat_logs       | > 90 days                                     | DELETE    |
 * | ops_agent_exceptions| status != 'pending' AND > 30 days             | DELETE    |
 * | proactive_alerts    | > 90 days                                     | DELETE    |
 * | Pinecone aria-memory| last_recalled_at > 60 days OR never recalled  | DELETE    |
 * | ap_activity_log     | NEVER — audit trail                           | RETAIN    |
 */

const RETENTION = {
    FEEDBACK_SYNCED_DAYS: 90,
    FEEDBACK_UNSCORED_DAYS: 30,
    FEEDBACK_IGNORED_DAYS: 14,
    CHAT_LOGS_DAYS: 90,
    EXCEPTIONS_DAYS: 30,
    ALERTS_DAYS: 90,
    PINECONE_STALE_DAYS: 60,
} as const;

/**
 * Run nightly housekeeping — prune stale data from ALL stores.
 * A bloated database is a broken brain. Aria keeps her own house clean.
 *
 * Returns a report of what was pruned. Logged to console; only sent to
 * Telegram if numbers are surprisingly high (> 500 total).
 */
export async function runHousekeeping(): Promise<HousekeepingReport> {
    const report: HousekeepingReport = {
        feedbackEventsPruned: 0,
        chatLogsPruned: 0,
        exceptionsPruned: 0,
        alertsPruned: 0,
        pineconeMemoriesPruned: 0,
        totalReclaimed: 0,
    };

    const db = createClient();
    if (!db) {
        console.warn("⚠️ [Housekeeping] Supabase unavailable — skipping cleanup");
        return report;
    }

    console.log("🧹 [Housekeeping] Starting nightly cleanup...");

    // ── 1. feedback_events: synced + old ─────────────────────
    try {
        const cutoff90 = new Date(Date.now() - RETENTION.FEEDBACK_SYNCED_DAYS * 86400000).toISOString();
        const { data: syncedOld, error: e1 } = await db
            .from("feedback_events")
            .delete()
            .eq("synced_to_memory", true)
            .lt("created_at", cutoff90)
            .select("id");
        if (!e1 && syncedOld) report.feedbackEventsPruned += syncedOld.length;
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] feedback_events synced cleanup error: ${err.message}`);
    }

    // ── 2. feedback_events: unscored + stale ─────────────────
    try {
        const cutoff30 = new Date(Date.now() - RETENTION.FEEDBACK_UNSCORED_DAYS * 86400000).toISOString();
        const { data: unscoredOld, error: e2 } = await db
            .from("feedback_events")
            .delete()
            .is("accuracy_score", null)
            .lt("created_at", cutoff30)
            .select("id");
        if (!e2 && unscoredOld) report.feedbackEventsPruned += unscoredOld.length;
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] feedback_events unscored cleanup error: ${err.message}`);
    }

    // ── 3. feedback_events: ignored engagement + stale ───────
    try {
        const cutoff14 = new Date(Date.now() - RETENTION.FEEDBACK_IGNORED_DAYS * 86400000).toISOString();
        const { data: ignoredOld, error: e3 } = await db
            .from("feedback_events")
            .delete()
            .eq("category", "engagement")
            .eq("user_action", "ignored")
            .lt("created_at", cutoff14)
            .select("id");
        if (!e3 && ignoredOld) report.feedbackEventsPruned += ignoredOld.length;
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] feedback_events ignored cleanup error: ${err.message}`);
    }

    // ── 4. sys_chat_logs: > 90 days ──────────────────────────
    try {
        const cutoff90 = new Date(Date.now() - RETENTION.CHAT_LOGS_DAYS * 86400000).toISOString();
        const { data: oldLogs, error: e4 } = await db
            .from("sys_chat_logs")
            .delete()
            .lt("created_at", cutoff90)
            .select("id");
        if (!e4 && oldLogs) report.chatLogsPruned = oldLogs.length;
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] sys_chat_logs cleanup error: ${err.message}`);
    }

    // ── 5. ops_agent_exceptions: resolved/escalated/ignored > 30 days ──
    try {
        const cutoff30 = new Date(Date.now() - RETENTION.EXCEPTIONS_DAYS * 86400000).toISOString();
        const { data: oldExceptions, error: e5 } = await db
            .from("ops_agent_exceptions")
            .delete()
            .neq("status", "pending")
            .lt("created_at", cutoff30)
            .select("id");
        if (!e5 && oldExceptions) report.exceptionsPruned = oldExceptions.length;
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] ops_agent_exceptions cleanup error: ${err.message}`);
    }

    // ── 6. proactive_alerts: > 90 days ───────────────────────
    try {
        const cutoff90 = new Date(Date.now() - RETENTION.ALERTS_DAYS * 86400000).toISOString();
        const { data: oldAlerts, error: e6 } = await db
            .from("proactive_alerts")
            .delete()
            .lt("alerted_at", cutoff90)
            .select("id");
        if (!e6 && oldAlerts) report.alertsPruned = oldAlerts.length;
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] proactive_alerts cleanup error: ${err.message}`);
    }

    // ── 7. Pinecone: stale memories never recalled in 60+ days ──
    try {
        report.pineconeMemoriesPruned = await pruneStaleMemories();
    } catch (err: any) {
        console.warn(`⚠️ [Housekeeping] Pinecone cleanup error: ${err.message}`);
    }

    // ── Summary ──────────────────────────────────────────────
    report.totalReclaimed =
        report.feedbackEventsPruned +
        report.chatLogsPruned +
        report.exceptionsPruned +
        report.alertsPruned +
        report.pineconeMemoriesPruned;

    console.log(
        `🧹 [Housekeeping] Nightly cleanup complete:\n` +
        `  feedback_events: ${report.feedbackEventsPruned} pruned\n` +
        `  sys_chat_logs: ${report.chatLogsPruned} pruned (>${RETENTION.CHAT_LOGS_DAYS}d)\n` +
        `  ops_agent_exceptions: ${report.exceptionsPruned} pruned (resolved >${RETENTION.EXCEPTIONS_DAYS}d)\n` +
        `  proactive_alerts: ${report.alertsPruned} pruned (>${RETENTION.ALERTS_DAYS}d)\n` +
        `  Pinecone aria-memory: ${report.pineconeMemoriesPruned} stale memories pruned\n` +
        `  Total reclaimed: ${report.totalReclaimed}`
    );

    return report;
}

/**
 * Prune stale Pinecone memories that haven't been recalled in 60+ days.
 * Uses the `last_recalled_at` metadata field set by recall().
 *
 * Strategy:
 * 1. List vectors in the aria-memory namespace (batch of 100)
 * 2. Check `last_recalled_at` metadata
 * 3. Delete any vector where last_recalled_at is older than 60 days
 *    OR where last_recalled_at is missing (never recalled, and stored_at > 60 days)
 *
 * Returns count of pruned vectors.
 */
async function pruneStaleMemories(): Promise<number> {
    try {
        const { Pinecone } = await import("@pinecone-database/pinecone");
        const apiKey = process.env.PINECONE_API_KEY;
        if (!apiKey) return 0;

        const pc = new Pinecone({ apiKey });
        const indexName = process.env.PINECONE_INDEX || "gravity-memory";
        const indexHost = process.env.PINECONE_MEMORY_HOST;
        const index = indexHost ? pc.index(indexName, indexHost) : pc.index(indexName);

        const namespace = index.namespace("aria-memory");
        const staleCutoff = new Date(Date.now() - RETENTION.PINECONE_STALE_DAYS * 86400000).toISOString();

        // List vectors — Pinecone list() returns IDs in pages
        const listResult = await namespace.listPaginated({ limit: 100 });

        if (!listResult.vectors || listResult.vectors.length === 0) return 0;

        const ids = listResult.vectors.map(v => v.id);
        const fetchResult = await namespace.fetch(ids);

        const idsToDelete: string[] = [];

        for (const [id, record] of Object.entries(fetchResult.records || {})) {
            if (!record?.metadata) continue;

            const meta = record.metadata as Record<string, any>;
            const lastRecalled = meta.last_recalled_at as string | undefined;
            const storedAt = meta.stored_at as string | undefined;

            // Never recalled — check if it's old enough to prune
            if (!lastRecalled) {
                if (storedAt && storedAt < staleCutoff) {
                    idsToDelete.push(id);
                }
                continue;
            }

            // Recalled, but not recently
            if (lastRecalled < staleCutoff) {
                idsToDelete.push(id);
            }
        }

        if (idsToDelete.length > 0) {
            await namespace.deleteMany(idsToDelete);
            console.log(`🧹 [Housekeeping] Pruned ${idsToDelete.length} stale Pinecone memories: ${idsToDelete.join(", ")}`);
        }

        return idsToDelete.length;
    } catch (err: any) {
        console.error(`❌ [Housekeeping] Pinecone prune error: ${err.message}`);
        return 0;
    }
}

/**
 * Format a housekeeping report for Telegram display.
 */
export function formatHousekeepingReport(report: HousekeepingReport): string {
    return (
        `🧹 <b>Housekeeping Report</b>\n\n` +
        `<b>Rows Pruned:</b>\n` +
        `  feedback_events: ${report.feedbackEventsPruned}\n` +
        `  sys_chat_logs: ${report.chatLogsPruned}\n` +
        `  ops_agent_exceptions: ${report.exceptionsPruned}\n` +
        `  proactive_alerts: ${report.alertsPruned}\n` +
        `  Pinecone memories: ${report.pineconeMemoriesPruned}\n\n` +
        `<b>Total reclaimed:</b> ${report.totalReclaimed} rows/vectors\n\n` +
        `<i>🧹 A tidy house is a tidy mind.</i>`
    );
}
