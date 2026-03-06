# Aria Kaizen Feedback Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a unified feedback loop system that captures corrections, outcomes, predictions, engagement, errors, vendor reliability, and weekly self-review — enabling Aria to continuously improve (Kaizen).

**Architecture:** One central Supabase table (`feedback_events`) stores all feedback signals. One central module (`src/lib/intelligence/feedback-loop.ts`) provides `recordFeedback()`, `analyzeAccuracy()`, `getVendorReliability()`, `generateSelfReview()`, `syncLearningsToMemory()`, and `proposeThresholdAdjustments()`. Existing modules (reconciler, ops-manager, supervisor) are wired to emit feedback events at their decision points. A weekly cron produces a Kaizen report.

**Tech Stack:** TypeScript, Supabase (Postgres), Pinecone (vector memory), Telegraf (Telegram bot), Zod (schemas)

**Design Doc:** `docs/plans/2026-03-06-feedback-loop-design.md`

---

## Phase 1: Foundation

### Task 1: Create `feedback_events` Supabase Migration

**Files:**
- Create: `supabase/migrations/20260306_create_feedback_events.sql`

**Step 1: Write the migration SQL**

```sql
-- Migration: feedback_events table — Aria's Kaizen feedback loop
-- Created: 2026-03-06
-- Rollback: DROP TABLE IF EXISTS feedback_events;
--
-- DECISION(2026-03-06): Single table for ALL feedback signals.
-- Categories: correction, outcome, error_pattern, engagement, prediction, vendor_reliability
-- This table is the source of truth for Aria's self-improvement metrics.

CREATE TABLE IF NOT EXISTS feedback_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,

    -- What kind of feedback signal
    category        TEXT NOT NULL CHECK (category IN (
        'correction', 'outcome', 'error_pattern',
        'engagement', 'prediction', 'vendor_reliability'
    )),

    -- Specific event type (e.g. 'reconciliation_rejected', 'po_created_after_suggestion')
    event_type      TEXT NOT NULL,

    -- Which agent generated this signal
    agent_source    TEXT NOT NULL,

    -- What entity this feedback is about
    subject_type    TEXT CHECK (subject_type IN (
        'vendor', 'sku', 'po', 'invoice', 'alert', 'message', 'build', NULL
    )),
    subject_id      TEXT,

    -- What Aria predicted/recommended
    prediction      JSONB DEFAULT '{}'::jsonb,

    -- What actually happened
    actual_outcome  JSONB DEFAULT '{}'::jsonb,

    -- Accuracy score (0.00 to 1.00) — null if not yet scoreable
    accuracy_score  NUMERIC(3,2) CHECK (accuracy_score IS NULL OR (accuracy_score >= 0 AND accuracy_score <= 1)),

    -- What the user did in response
    user_action     TEXT CHECK (user_action IN (
        'approved', 'rejected', 'ignored', 'corrected', 'engaged', 'snoozed', NULL
    )),

    -- Extra context
    context_data    JSONB DEFAULT '{}'::jsonb,

    -- Has this learning been synced to Pinecone memory?
    synced_to_memory BOOLEAN DEFAULT false
);

-- Indexes for common query patterns
CREATE INDEX idx_feedback_events_category_created ON feedback_events (category, created_at DESC);
CREATE INDEX idx_feedback_events_agent_created ON feedback_events (agent_source, created_at DESC);
CREATE INDEX idx_feedback_events_subject ON feedback_events (subject_type, subject_id) WHERE subject_type IS NOT NULL;
CREATE INDEX idx_feedback_events_unsynced ON feedback_events (synced_to_memory) WHERE synced_to_memory = false;
CREATE INDEX idx_feedback_events_accuracy ON feedback_events (category, accuracy_score) WHERE accuracy_score IS NOT NULL;

ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable all for service role" ON feedback_events
    USING (true) WITH CHECK (true);

COMMENT ON TABLE feedback_events IS 'Aria Kaizen feedback loop — every signal of "was Aria right?" flows through this table for accuracy tracking, self-review, and continuous improvement.';
```

**Step 2: Apply the migration**

Run: `node --import tsx _run_migration.js supabase/migrations/20260306_create_feedback_events.sql`
Expected: Migration applied successfully, table created.

**Step 3: Commit**

```bash
git add supabase/migrations/20260306_create_feedback_events.sql
git commit -m "feat(feedback): create feedback_events table for Kaizen loop"
```

---

### Task 2: Create Central `feedback-loop.ts` Module — Types and `recordFeedback()`

**Files:**
- Create: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Write the module with types and recordFeedback**

```typescript
/**
 * @file    feedback-loop.ts
 * @purpose Aria's Kaizen engine — unified feedback loop for continuous improvement.
 *          Captures corrections, outcomes, predictions, engagement, errors, and
 *          vendor reliability signals. Powers weekly self-review and threshold tuning.
 * @author  Will / Antigravity
 * @created 2026-03-06
 * @updated 2026-03-06
 * @deps    supabase, memory.ts
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "../supabase";
import { remember, recall } from "./memory";

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
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/lib/intelligence/feedback-loop.ts 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"`
Expected: No output (clean compile).

**Step 3: Commit**

```bash
git add src/lib/intelligence/feedback-loop.ts
git commit -m "feat(feedback): add feedback-loop module with recordFeedback()"
```

---

### Task 3: Add `analyzeAccuracy()` to feedback-loop.ts

**Files:**
- Modify: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Add analyzeAccuracy function**

Append to the module after `recordFeedback()`:

```typescript
// ──────────────────────────────────────────────────
// ACCURACY ANALYSIS
// ──────────────────────────────────────────────────

/**
 * Compute accuracy metrics for a given category/agent over a time period.
 * Compares current period to previous period of same length for trend detection.
 *
 * @param category  Filter by feedback category (optional — all if omitted)
 * @param agentSource  Filter by agent (optional)
 * @param days  Number of days to analyze (default 7)
 */
export async function analyzeAccuracy(
    category?: FeedbackCategory,
    agentSource?: string,
    days: number = 7
): Promise<AccuracyMetrics[]> {
    const db = createClient();
    if (!db) return [];

    try {
        const now = new Date();
        const periodStart = new Date(now.getTime() - days * 86400000);
        const prevPeriodStart = new Date(periodStart.getTime() - days * 86400000);

        // Current period
        let currentQuery = db
            .from("feedback_events")
            .select("category, accuracy_score")
            .gte("created_at", periodStart.toISOString())
            .not("accuracy_score", "is", null);

        if (category) currentQuery = currentQuery.eq("category", category);
        if (agentSource) currentQuery = currentQuery.eq("agent_source", agentSource);

        const { data: currentData, error: currentError } = await currentQuery;
        if (currentError) throw currentError;

        // Previous period (for trend)
        let prevQuery = db
            .from("feedback_events")
            .select("category, accuracy_score")
            .gte("created_at", prevPeriodStart.toISOString())
            .lt("created_at", periodStart.toISOString())
            .not("accuracy_score", "is", null);

        if (category) prevQuery = prevQuery.eq("category", category);
        if (agentSource) prevQuery = prevQuery.eq("agent_source", agentSource);

        const { data: prevData } = await prevQuery;

        // Group by category
        const grouped = new Map<string, { scores: number[]; prevScores: number[] }>();

        for (const row of (currentData || [])) {
            const cat = row.category;
            if (!grouped.has(cat)) grouped.set(cat, { scores: [], prevScores: [] });
            grouped.get(cat)!.scores.push(Number(row.accuracy_score));
        }

        for (const row of (prevData || [])) {
            const cat = row.category;
            if (!grouped.has(cat)) grouped.set(cat, { scores: [], prevScores: [] });
            grouped.get(cat)!.prevScores.push(Number(row.accuracy_score));
        }

        const results: AccuracyMetrics[] = [];

        for (const [cat, data] of grouped) {
            const avg = data.scores.length > 0
                ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length
                : 0;
            const prevAvg = data.prevScores.length > 0
                ? data.prevScores.reduce((a, b) => a + b, 0) / data.prevScores.length
                : null;

            let trend: "improving" | "stable" | "declining" = "stable";
            if (prevAvg !== null) {
                const diff = avg - prevAvg;
                if (diff > 0.05) trend = "improving";
                else if (diff < -0.05) trend = "declining";
            }

            results.push({
                category: cat,
                totalEvents: data.scores.length + data.prevScores.length,
                scoredEvents: data.scores.length,
                averageAccuracy: Math.round(avg * 100) / 100,
                trend,
                previousPeriodAccuracy: prevAvg !== null ? Math.round(prevAvg * 100) / 100 : null,
            });
        }

        return results;
    } catch (err: any) {
        console.error(`❌ [Kaizen] analyzeAccuracy error: ${err.message}`);
        return [];
    }
}
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/feedback-loop.ts
git commit -m "feat(feedback): add analyzeAccuracy() with trend detection"
```

---

### Task 4: Add `getVendorReliability()` to feedback-loop.ts

**Files:**
- Modify: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Add vendor reliability function**

Append after `analyzeAccuracy()`:

```typescript
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

        // Get all feedback events for this vendor
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
                overallScore: -1,   // No data
                onTimePercent: -1,
                invoiceAccuracy: -1,
                avgResponseDays: -1,
                documentQuality: -1,
                trend: "stable",
                recentIssues: [],
                eventCount: 0,
            };
        }

        // Categorize events
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
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/feedback-loop.ts
git commit -m "feat(feedback): add getVendorReliability() scoring"
```

---

### Task 5: Add `syncLearningsToMemory()` to feedback-loop.ts

**Files:**
- Modify: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Add memory sync function**

Append after `getVendorReliability()`:

```typescript
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
        // Get unsynced events that have actionable learnings
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
            // Build a learning statement from the feedback
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

                // Mark as synced
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
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/feedback-loop.ts
git commit -m "feat(feedback): add syncLearningsToMemory() for Pinecone integration"
```

---

### Task 6: Add `generateSelfReview()` and `detectDrift()` to feedback-loop.ts

**Files:**
- Modify: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Add self-review and drift detection functions**

Append after `syncLearningsToMemory()`:

```typescript
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

        // 1. Accuracy metrics by category
        const accuracy = await analyzeAccuracy(undefined, undefined, days);

        // 2. Engagement stats
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

        // 5. Drift detection
        const driftAlerts = await detectDrift(days);

        // Build the report
        let report = `📊 <b>ARIA KAIZEN REPORT</b> — Past ${days} Days\n\n`;

        // Accuracy section
        report += `🎯 <b>Accuracy</b>\n`;
        if (accuracy.length === 0) {
            report += `  <i>No scored predictions yet — learning in progress</i>\n`;
        } else {
            for (const m of accuracy) {
                const arrow = m.trend === "improving" ? "⬆️" : m.trend === "declining" ? "⬇️" : "➡️";
                const pct = Math.round(m.averageAccuracy * 100);
                const prevPct = m.previousPeriodAccuracy !== null ? Math.round(m.previousPeriodAccuracy * 100) : null;
                const prevStr = prevPct !== null ? ` (was ${prevPct}%)` : "";
                report += `  ${arrow} ${m.category}: <b>${pct}%</b> (${m.scoredEvents} events)${prevStr}\n`;
            }
        }

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
            // Group by agent
            const byAgent = new Map<string, number>();
            for (const e of errorData) {
                byAgent.set(e.agent_source, (byAgent.get(e.agent_source) || 0) + 1);
            }
            for (const [agent, count] of byAgent) {
                report += `  ${agent}: ${count} error(s)\n`;
            }
        }

        // Drift alerts
        if (driftAlerts.length > 0) {
            report += `\n⚠️ <b>Drift Detected</b>\n`;
            for (const alert of driftAlerts) {
                report += `  ${alert}\n`;
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
// DRIFT DETECTION
// ──────────────────────────────────────────────────

/**
 * Detect accuracy drift — when a domain's accuracy is dropping significantly.
 * Returns human-readable alert strings for any domain below threshold.
 *
 * @param windowDays  Comparison window (current vs. previous period)
 */
export async function detectDrift(windowDays: number = 7): Promise<string[]> {
    const alerts: string[] = [];
    const DRIFT_THRESHOLD = 0.60;  // Alert if accuracy drops below 60%
    const SIGNIFICANT_DROP = 0.15; // Alert if accuracy drops >15 points

    try {
        const metrics = await analyzeAccuracy(undefined, undefined, windowDays);

        for (const m of metrics) {
            if (m.averageAccuracy < DRIFT_THRESHOLD && m.scoredEvents >= 3) {
                alerts.push(
                    `📉 ${m.category} accuracy at ${Math.round(m.averageAccuracy * 100)}% ` +
                    `(${m.scoredEvents} events) — below ${DRIFT_THRESHOLD * 100}% threshold`
                );
            }

            if (m.previousPeriodAccuracy !== null && m.scoredEvents >= 3) {
                const drop = m.previousPeriodAccuracy - m.averageAccuracy;
                if (drop > SIGNIFICANT_DROP) {
                    alerts.push(
                        `📉 ${m.category} dropped ${Math.round(drop * 100)} points ` +
                        `(${Math.round(m.previousPeriodAccuracy * 100)}% → ${Math.round(m.averageAccuracy * 100)}%)`
                    );
                }
            }
        }
    } catch (err: any) {
        console.error(`❌ [Kaizen] detectDrift error: ${err.message}`);
    }

    return alerts;
}

// ──────────────────────────────────────────────────
// THRESHOLD ADJUSTMENT PROPOSALS
// ──────────────────────────────────────────────────

/**
 * Analyze feedback patterns and propose threshold adjustments.
 * E.g., if reconciliation auto-approvals at 3-4% range are always approved,
 * suggest raising the auto-approve threshold.
 *
 * Returns human-readable proposals. Does NOT auto-apply.
 */
export async function proposeThresholdAdjustments(): Promise<string[]> {
    const db = createClient();
    if (!db) return [];

    const proposals: string[] = [];

    try {
        // Check reconciliation approval patterns
        const { data: reconData } = await db
            .from("feedback_events")
            .select("prediction, user_action")
            .eq("category", "correction")
            .ilike("event_type", "%reconcil%")
            .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());

        if (reconData && reconData.length >= 5) {
            const approved = reconData.filter(e => e.user_action === "approved");
            const rejected = reconData.filter(e => e.user_action === "rejected");

            if (approved.length > 0 && rejected.length === 0) {
                proposals.push(
                    `🔧 Reconciler: ${approved.length} approvals, 0 rejections in 30 days. ` +
                    `Consider raising auto-approve threshold for faster processing.`
                );
            }

            if (rejected.length > 0) {
                // Analyze rejection reasons
                const rejectionReasons = rejected
                    .map(e => e.prediction?.reason || "unknown")
                    .filter(Boolean);
                
                const uniqueReasons = [...new Set(rejectionReasons)];
                if (uniqueReasons.length > 0) {
                    proposals.push(
                        `🔧 Reconciler: ${rejected.length} rejection(s). ` +
                        `Common reasons: ${uniqueReasons.join(", ")}. ` +
                        `Consider adding specific handling for these patterns.`
                    );
                }
            }
        }

        // Check alert engagement — are we sending too many alerts that get ignored?
        const { data: alertData } = await db
            .from("feedback_events")
            .select("event_type, user_action")
            .eq("category", "engagement")
            .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());

        if (alertData && alertData.length >= 10) {
            const byType = new Map<string, { engaged: number; ignored: number }>();
            for (const e of alertData) {
                const key = e.event_type;
                if (!byType.has(key)) byType.set(key, { engaged: 0, ignored: 0 });
                const stats = byType.get(key)!;
                if (e.user_action === "engaged") stats.engaged++;
                else if (e.user_action === "ignored") stats.ignored++;
            }

            for (const [type, stats] of byType) {
                const total = stats.engaged + stats.ignored;
                if (total >= 5 && stats.ignored / total > 0.7) {
                    proposals.push(
                        `📉 Alert "${type}" is ignored ${Math.round(stats.ignored / total * 100)}% of the time ` +
                        `(${stats.ignored}/${total}). Consider reducing frequency or removing.`
                    );
                }
            }
        }
    } catch (err: any) {
        console.error(`❌ [Kaizen] proposeThresholdAdjustments error: ${err.message}`);
    }

    return proposals;
}
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/feedback-loop.ts
git commit -m "feat(feedback): add generateSelfReview(), detectDrift(), proposeThresholdAdjustments()"
```

---

## Phase 2: Wiring Signal Sources

### Task 7: Wire Reconciler to Emit Corrections

**Files:**
- Modify: `src/lib/finale/reconciler.ts`

**Step 1: Add import and recordFeedback calls**

At the top of `reconciler.ts`, add the import:
```typescript
import { recordFeedback } from "../intelligence/feedback-loop";
```

Inside `approvePendingReconciliation()` — after a successful approval (when `success: true` is about to be returned), add:
```typescript
// Kaizen: record successful approval as correction feedback
await recordFeedback({
    category: "correction",
    eventType: "reconciliation_approved",
    agentSource: "reconciler",
    subjectType: "invoice",
    subjectId: pending.result.invoiceNumber,
    prediction: {
        verdict: pending.result.overallVerdict,
        priceChanges: pending.result.priceChanges.length,
        feeChanges: pending.result.feeChanges.length,
        totalDollarImpact: pending.result.totalDollarImpact,
    },
    actualOutcome: { userDecision: "approved", appliedCount: applied.length },
    accuracyScore: 1.0,
    userAction: "approved",
    contextData: { orderId: pending.result.orderId, vendorName: pending.result.vendorName },
});
```

Inside `rejectPendingReconciliation()` — after a successful rejection, add:
```typescript
// Kaizen: record rejection as correction feedback
await recordFeedback({
    category: "correction",
    eventType: "reconciliation_rejected",
    agentSource: "reconciler",
    subjectType: "invoice",
    subjectId: pending.result.invoiceNumber,
    prediction: {
        verdict: pending.result.overallVerdict,
        priceChanges: pending.result.priceChanges.length,
        feeChanges: pending.result.feeChanges.length,
        totalDollarImpact: pending.result.totalDollarImpact,
    },
    actualOutcome: { userDecision: "rejected" },
    accuracyScore: 0.0,
    userAction: "rejected",
    contextData: { orderId: pending.result.orderId, vendorName: pending.result.vendorName },
});
```

**Step 2: Commit**

```bash
git add src/lib/finale/reconciler.ts
git commit -m "feat(feedback): wire reconciler approve/reject to Kaizen feedback loop"
```

---

### Task 8: Wire Supervisor Agent to Emit Error Patterns

**Files:**
- Modify: `src/lib/intelligence/supervisor-agent.ts`

**Step 1: Add import and recordFeedback calls**

At the top of `supervisor-agent.ts`, add:
```typescript
import { recordFeedback } from "./feedback-loop";
```

In the `supervise()` method, after each remedy decision (ESCALATE, RETRY, IGNORE), replace or supplement the existing `remember()` calls with `recordFeedback()`:

After ESCALATE block:
```typescript
// Kaizen: record error pattern
await recordFeedback({
    category: "error_pattern",
    eventType: `agent_crash_escalated`,
    agentSource: rootCause.agent_name,
    subjectType: "alert",
    subjectId: rootCause.id,
    prediction: { autoRemedy: "ESCALATE" },
    actualOutcome: { resolution: "escalated_to_human" },
    accuracyScore: null,
    contextData: { errorMessage: rootCause.error_message, stack: (rootCause.error_stack || "").slice(0, 500) },
});
```

After RETRY block:
```typescript
await recordFeedback({
    category: "error_pattern",
    eventType: `agent_crash_retried`,
    agentSource: rootCause.agent_name,
    subjectType: "alert",
    subjectId: rootCause.id,
    prediction: { autoRemedy: "RETRY" },
    actualOutcome: { resolution: "organic_retry" },
    accuracyScore: null,
    contextData: { errorMessage: rootCause.error_message },
});
```

After IGNORE block:
```typescript
await recordFeedback({
    category: "error_pattern",
    eventType: `agent_crash_ignored`,
    agentSource: rootCause.agent_name,
    subjectType: "alert",
    subjectId: rootCause.id,
    prediction: { autoRemedy: "IGNORE" },
    actualOutcome: { resolution: "noise_filtered" },
    accuracyScore: null,
    contextData: { errorMessage: rootCause.error_message },
});
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/supervisor-agent.ts
git commit -m "feat(feedback): wire supervisor-agent to Kaizen error pattern tracking"
```

---

### Task 9: Wire OpsManager — Engagement Tracking and Kaizen Crons

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`

**Step 1: Add import**

At the top of `ops-manager.ts`, add:
```typescript
import { recordFeedback, generateSelfReview, syncLearningsToMemory } from "./feedback-loop";
```

**Step 2: Add engagement tracking after daily summary**

In the `sendDailySummary()` method (or wherever the daily summary is sent), after the Telegram message is sent, schedule a delayed engagement check:

```typescript
// Kaizen: Check engagement 30 minutes after sending summary
setTimeout(async () => {
    try {
        const db = createClient();
        if (!db) return;

        // Check if Will sent any messages in the 30 min after the summary
        const thirtyMinAgo = new Date(Date.now() - 30 * 60000).toISOString();
        const { data: recentMessages } = await db
            .from("sys_chat_logs")
            .select("content")
            .eq("source", "telegram")
            .eq("role", "user")
            .gte("created_at", thirtyMinAgo);

        const wasEngaged = (recentMessages || []).length > 0;

        await recordFeedback({
            category: "engagement",
            eventType: "daily_summary",
            agentSource: "ops_manager",
            subjectType: "message",
            userAction: wasEngaged ? "engaged" : "ignored",
            contextData: { messageCount: (recentMessages || []).length },
        });
    } catch (err: any) {
        console.error(`⚠️ [Kaizen] Engagement check failed: ${err.message}`);
    }
}, 30 * 60 * 1000); // 30 minutes
```

**Step 3: Add Kaizen weekly cron and memory sync cron**

In the `start()` method, add two new cron schedules:

```typescript
// Kaizen weekly self-review — Fridays at 8:15 AM Denver
cron.schedule("15 8 * * 5", () => this.safeRun("Kaizen Self-Review", async () => {
    console.log("📊 [Kaizen] Generating weekly self-review...");
    const report = await generateSelfReview(7);

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
        await this.bot.telegram.sendMessage(chatId, report, { parse_mode: "HTML" });
    }

    // Sync learnings to memory
    const synced = await syncLearningsToMemory();
    console.log(`🧠 [Kaizen] Synced ${synced} learnings to Pinecone memory.`);
}), { timezone: "America/Denver" });

// Kaizen memory sync — daily at 9:00 PM Denver (end of business)
cron.schedule("0 21 * * *", () => this.safeRun("Kaizen Memory Sync", async () => {
    const synced = await syncLearningsToMemory();
    if (synced > 0) {
        console.log(`🧠 [Kaizen] End-of-day memory sync: ${synced} learnings pushed to Pinecone.`);
    }
}), { timezone: "America/Denver" });
```

**Step 4: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts
git commit -m "feat(feedback): add Kaizen crons — weekly self-review, engagement tracking, memory sync"
```

---

### Task 10: Add `/kaizen` Telegram Bot Command

**Files:**
- Modify: `src/cli/start-bot.ts`

**Step 1: Add import and command**

Add import at the top:
```typescript
import { generateSelfReview, getVendorReliability, analyzeAccuracy } from "../lib/intelligence/feedback-loop";
```

Add the `/kaizen` command:
```typescript
// /kaizen — Generate on-demand Kaizen self-review report
bot.command('kaizen', async (ctx) => {
    ctx.sendChatAction('typing');
    try {
        const args = ctx.message.text.replace(/^\/kaizen\s*/, '').trim();
        const days = parseInt(args) || 7;
        const report = await generateSelfReview(days);
        await ctx.reply(report, { parse_mode: 'HTML' });
    } catch (err: any) {
        ctx.reply(`❌ Kaizen report failed: ${err.message}`);
    }
});
```

Add the `/vendor` reliability command:
```typescript
// /vendor <name> — Check vendor reliability score
bot.command('vendor', async (ctx) => {
    ctx.sendChatAction('typing');
    const vendorName = ctx.message.text.replace(/^\/vendor\s*/, '').trim();
    if (!vendorName) {
        return ctx.reply('Usage: `/vendor AAACooper`', { parse_mode: 'Markdown' });
    }
    try {
        const reliability = await getVendorReliability(vendorName);
        if (!reliability || reliability.eventCount === 0) {
            return ctx.reply(`No feedback data yet for "${vendorName}". Reliability tracking is learning.`);
        }
        const trendEmoji = reliability.trend === 'improving' ? '⬆️' : reliability.trend === 'declining' ? '⬇️' : '➡️';
        let msg = `📊 <b>Vendor: ${reliability.vendorName}</b>\n\n`;
        msg += `Overall Score: <b>${reliability.overallScore >= 0 ? reliability.overallScore + '/100' : 'N/A'}</b> ${trendEmoji}\n`;
        msg += `On-Time: ${reliability.onTimePercent >= 0 ? reliability.onTimePercent + '%' : 'N/A'}\n`;
        msg += `Invoice Accuracy: ${reliability.invoiceAccuracy >= 0 ? reliability.invoiceAccuracy + '%' : 'N/A'}\n`;
        msg += `Avg Response: ${reliability.avgResponseDays >= 0 ? reliability.avgResponseDays + ' days' : 'N/A'}\n`;
        msg += `Doc Quality: ${reliability.documentQuality >= 0 ? reliability.documentQuality + '%' : 'N/A'}\n`;
        msg += `Events: ${reliability.eventCount}\n`;
        if (reliability.recentIssues.length > 0) {
            msg += `\n⚠️ Recent Issues:\n${reliability.recentIssues.map(i => `  • ${i}`).join('\n')}`;
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err: any) {
        ctx.reply(`❌ Vendor lookup failed: ${err.message}`);
    }
});
```

**Step 2: Commit**

```bash
git add src/cli/start-bot.ts
git commit -m "feat(feedback): add /kaizen and /vendor Telegram bot commands"
```

---

### Task 11: Wire AP Agent — Document Classification Feedback

**Files:**
- Modify: `src/lib/intelligence/ap-agent.ts`

**Step 1: Add import**

At the top:
```typescript
import { recordFeedback } from "./feedback-loop";
```

**Step 2: Add feedback after document classification**

After the AP agent classifies a document (INVOICE/STATEMENT/ADVERTISEMENT/HUMAN_INTERACTION), record the classification confidence:

```typescript
// Kaizen: record document classification for accuracy tracking
await recordFeedback({
    category: "prediction",
    eventType: "document_classification",
    agentSource: "ap_agent",
    subjectType: "invoice",
    subjectId: messageId,
    prediction: { classification: classificationResult.intent, confidence: classificationResult.confidence },
    actualOutcome: {},  // Will be updated if classification is later corrected
    accuracyScore: classificationResult.confidence,
    contextData: { vendorName: classificationResult.vendor || "unknown", filename: attachment.filename },
});
```

**Step 3: Add feedback after invoice forwarding**

After successfully forwarding an invoice to bill.com:

```typescript
// Kaizen: record successful vendor interaction
await recordFeedback({
    category: "vendor_reliability",
    eventType: "invoice_received",
    agentSource: "ap_agent",
    subjectType: "vendor",
    subjectId: vendorName,
    prediction: {},
    actualOutcome: { forwarded: true, documentType: "INVOICE" },
    contextData: { invoiceNumber, orderId: matchedPO?.orderId },
});
```

**Step 4: Commit**

```bash
git add src/lib/intelligence/ap-agent.ts
git commit -m "feat(feedback): wire AP agent classification and forwarding to Kaizen loop"
```

---

## Phase 3: Housekeeping — 掃除 (Souji)

### Task 12: Add `runHousekeeping()` to feedback-loop.ts

**Files:**
- Modify: `src/lib/intelligence/feedback-loop.ts`

**Step 1: Add the housekeeping function**

Append after `proposeThresholdAdjustments()`:

```typescript
// ──────────────────────────────────────────────────
// HOUSEKEEPING — Aria cleans up after herself
// ──────────────────────────────────────────────────

export interface HousekeepingReport {
    feedbackEventsPruned: number;
    chatLogsPruned: number;
    exceptionsPruned: number;
    alertsPruned: number;
    pineconeMemoriesPruned: number;
    totalReclaimed: number;
}

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
```

**Step 2: Commit**

```bash
git add src/lib/intelligence/feedback-loop.ts
git commit -m "feat(feedback): add runHousekeeping() with retention policies for all data stores"
```

---

### Task 13: Add `/housekeeping` Bot Command and Nightly Cron

**Files:**
- Modify: `src/cli/start-bot.ts`
- Modify: `src/lib/intelligence/ops-manager.ts`

**Step 1: Add `/housekeeping` command to start-bot.ts**

Add import at top:
```typescript
import { runHousekeeping, formatHousekeepingReport } from "../lib/intelligence/feedback-loop";
```

Add the command:
```typescript
// /housekeeping — Run Aria's data cleanup on demand
bot.command('housekeeping', async (ctx) => {
    ctx.sendChatAction('typing');
    try {
        await ctx.reply('🧹 Running housekeeping...');
        const report = await runHousekeeping();
        await ctx.reply(formatHousekeepingReport(report), { parse_mode: 'HTML' });
    } catch (err: any) {
        ctx.reply(`❌ Housekeeping failed: ${err.message}`);
    }
});
```

**Step 2: Add nightly housekeeping cron to OpsManager**

In the `start()` method, add (import `runHousekeeping` at top of ops-manager.ts):
```typescript
// Housekeeping — nightly at 11:00 PM Denver (prune stale data everywhere)
cron.schedule("0 23 * * *", () => this.safeRun("Nightly Housekeeping", async () => {
    const report = await runHousekeeping();

    // Only alert Will via Telegram if cleanup was surprisingly large
    if (report.totalReclaimed > 500) {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
            await this.bot.telegram.sendMessage(
                chatId,
                `🧹 <b>Large cleanup alert:</b> ${report.totalReclaimed} rows/vectors pruned tonight. Check logs for details.`,
                { parse_mode: "HTML" }
            );
        }
    }
}), { timezone: "America/Denver" });
```

**Step 3: Update `recall()` in memory.ts to track last_recalled_at**

In `src/lib/intelligence/memory.ts`, inside the `recall()` function, after getting results from Pinecone, add an update to track when each memory was last recalled:

```typescript
// Kaizen housekeeping: update last_recalled_at on recalled memories
// so the housekeeping cron can prune stale ones.
if (results.matches && results.matches.length > 0) {
    const now = new Date().toISOString();
    const updates = results.matches
        .filter(m => (m.score ?? 0) >= minScore)
        .map(m => ({
            id: m.id,
            values: m.values || [],
            metadata: { ...((m.metadata as Record<string, any>) || {}), last_recalled_at: now },
        }));

    if (updates.length > 0) {
        try {
            await index.namespace(NAMESPACE).upsert(updates);
        } catch (updateErr: any) {
            // Non-fatal — don't block recall if metadata update fails
            console.warn(`⚠️ [Memory] Failed to update last_recalled_at: ${updateErr.message}`);
        }
    }
}
```

**Step 4: Commit**

```bash
git add src/cli/start-bot.ts src/lib/intelligence/ops-manager.ts src/lib/intelligence/memory.ts
git commit -m "feat(feedback): add /housekeeping command, nightly cron, and recall() tracking"
```

---

### Task 14: Final Integration — TypeScript Check and PM2 Restart

**Step 1: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"`
Expected: No output (clean compile).

**Step 2: Fix any TypeScript errors found**

Address any import issues or type mismatches.

**Step 3: Restart bot**

Run: `pm2 restart aria-bot`
Expected: Bot restarts successfully.

**Step 4: Test /kaizen command**

Send `/kaizen` in Telegram.
Expected: Receives a Kaizen report (will show "no data yet" initially, which is correct).

**Step 5: Test /housekeeping command**

Send `/housekeeping` in Telegram.
Expected: Receives a housekeeping report showing 0 pruned rows (no stale data yet, which is correct).

**Step 6: Final commit and push**

```bash
git add -A
git commit -m "feat(feedback): complete Aria Kaizen feedback loop system

- feedback_events Supabase table for all feedback signals
- feedback-loop.ts central module with recordFeedback, analyzeAccuracy,
  getVendorReliability, generateSelfReview, syncLearningsToMemory,
  detectDrift, proposeThresholdAdjustments, runHousekeeping
- Reconciler wired for correction capture (approve/reject)
- Supervisor wired for error pattern tracking
- OpsManager wired for engagement tracking + weekly Kaizen cron
- AP Agent wired for classification and vendor reliability
- /kaizen, /vendor, and /housekeeping Telegram commands
- Nightly housekeeping cron prunes all stale data
- Pinecone memory tracking via last_recalled_at metadata
- Daily memory sync + weekly self-review on Fridays 8:15 AM"
git push
```

---

## Post-Implementation Verification

After the system runs for a few days, verify:

1. **feedback_events table** has rows from multiple agents
2. **`/kaizen` command** returns a meaningful report with accuracy metrics
3. **Weekly Friday report** fires and includes trend arrows
4. **Pinecone memories** include "LEARNED:" and "CONFIRMED:" entries from the Kaizen loop
5. **Reconciler approve/reject** shows up in the feedback events
6. **Supervisor errors** are tracked with pattern data
7. **`/housekeeping` command** returns a cleanup report
8. **Nightly cron** runs and logs cleanup stats (check `pm2 logs` for "Housekeeping" entries)
9. **No unbounded table growth** — verify row counts are stable week-over-week

---

## Future Work (Phase 4 — after data accumulates)

- **Confidence Dashboard Panel** — Next.js dashboard showing accuracy by domain
- **Build risk post-mortem** — After build date, check if risk materialized
- **PO outcome tracking** — Did recommended POs actually get created?
- **Auto-threshold proposals** — Make proposeThresholdAdjustments() more sophisticated with statistical analysis
- **Cold storage archival** — Move ap_activity_log rows > 1 year to cold storage when volume justifies
