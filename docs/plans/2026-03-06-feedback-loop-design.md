# Aria Feedback Loop System — Kaizen Engine

**Author:** Will / Antigravity  
**Created:** 2026-03-06  
**Status:** Approved  
**Philosophy:** Kaizen (改善) — continuous improvement, always getting better

---

## Overview

A unified feedback loop system that captures every signal of "was Aria right?" and
uses those signals to continuously improve predictions, recommendations, and
communication. One central module, one central table, 7 pillars of learning.

The system answers three questions constantly:
1. **Was I right?** (accuracy tracking)
2. **Did it matter?** (engagement/outcome tracking)
3. **How do I get better?** (self-review + threshold tuning)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    feedback_events (Supabase)                │
│  category │ event_type │ prediction │ actual_outcome │ score │
└────────┬────────────────────────────────────────────────┬────┘
         │                                                │
    recordFeedback()                              syncLearningsToMemory()
         │                                                │
         ▼                                                ▼
┌──────────────────┐                            ┌──────────────────┐
│  Signal Sources  │                            │  Pinecone Memory │
│                  │                            │  (aria-memory)   │
│  • Reconciler    │                            │                  │
│  • Build Risk    │                            │  Aria's system   │
│  • Purchasing    │                            │  prompt uses     │
│  • Supervisor    │                            │  recall() to get │
│  • Telegram Bot  │                            │  these learnings │
│  • Alert Engine  │                            │                  │
└──────────────────┘                            └──────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│         Weekly Self-Review Cron          │
│  • Accuracy metrics by domain            │
│  • Threshold adjustment proposals        │
│  • Vendor reliability rankings           │
│  • Drift detection alerts                │
│  • "How am I doing?" Telegram message    │
└──────────────────────────────────────────┘
```

---

## Central Table: `feedback_events`

```sql
CREATE TABLE feedback_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ DEFAULT now() NOT NULL,

    -- What kind of feedback
    category        TEXT NOT NULL,
    -- category values: 'correction' | 'outcome' | 'error_pattern' | 'engagement' | 'prediction' | 'vendor_reliability'

    event_type      TEXT NOT NULL,
    -- e.g. 'reconciliation_rejected', 'po_created_after_suggestion', 'alert_ignored',
    --      'build_risk_accurate', 'vendor_late_delivery', 'summary_engaged'

    -- Who generated this signal
    agent_source    TEXT NOT NULL,
    -- e.g. 'reconciler', 'build_risk', 'purchasing', 'supervisor', 'telegram_bot', 'alert_engine'

    -- What entity this is about
    subject_type    TEXT,
    -- 'vendor' | 'sku' | 'po' | 'invoice' | 'alert' | 'message' | 'build'
    subject_id      TEXT,

    -- The prediction/recommendation Aria made
    prediction      JSONB DEFAULT '{}'::jsonb,

    -- What actually happened
    actual_outcome  JSONB DEFAULT '{}'::jsonb,

    -- Accuracy score (0.0 to 1.0) — null if not yet scoreable
    accuracy_score  NUMERIC(3,2),

    -- What the user did
    user_action     TEXT,
    -- 'approved' | 'rejected' | 'ignored' | 'corrected' | 'engaged' | 'snoozed' | null

    -- Extra context
    context_data    JSONB DEFAULT '{}'::jsonb,

    -- Has this learning been pushed to Pinecone memory?
    synced_to_memory BOOLEAN DEFAULT false
);
```

Indexes on `(category, created_at)`, `(agent_source, created_at)`, `(subject_type, subject_id)`, and `synced_to_memory = false`.

---

## Central Module: `src/lib/intelligence/feedback-loop.ts`

### Core Functions

| Function | Purpose |
|----------|---------|
| `recordFeedback(event)` | Log any feedback signal to Supabase |
| `analyzeAccuracy(category?, agentSource?, days?)` | Compute accuracy metrics over a period |
| `getVendorReliability(vendorName)` | Computed vendor score from all feedback signals |
| `generateSelfReview(days?)` | Weekly "how am I doing?" report |
| `syncLearningsToMemory()` | Push validated learnings to Pinecone |
| `proposeThresholdAdjustments()` | Suggest changes to auto-approve thresholds |
| `detectDrift(category, windowDays?)` | Alert if accuracy is declining |

### Type Interface

```typescript
interface FeedbackEvent {
    category: 'correction' | 'outcome' | 'error_pattern' | 'engagement' | 'prediction' | 'vendor_reliability';
    eventType: string;
    agentSource: string;
    subjectType?: 'vendor' | 'sku' | 'po' | 'invoice' | 'alert' | 'message' | 'build';
    subjectId?: string;
    prediction?: Record<string, any>;
    actualOutcome?: Record<string, any>;
    accuracyScore?: number;
    userAction?: 'approved' | 'rejected' | 'ignored' | 'corrected' | 'engaged' | 'snoozed';
    contextData?: Record<string, any>;
}
```

---

## The 7 Pillars

### Pillar 1: Correction Capture

**When:** Will approves or rejects a reconciliation, reclassifies a document, or corrects Aria via Telegram.

**Integration Points:**
- `reconciler.ts` → `approvePendingReconciliation()` and `rejectPendingReconciliation()` call `recordFeedback()` with the original prediction vs. the actual decision
- Bot tool call responses where Will corrects Aria → capture the correction context
- AP agent document classification corrections (if a doc was misclassified)

**Example Event:**
```json
{
    "category": "correction",
    "eventType": "reconciliation_rejected",
    "agentSource": "reconciler",
    "subjectType": "invoice",
    "subjectId": "INV-2026-0342",
    "prediction": { "verdict": "auto_approve", "priceChange": 2.1 },
    "actualOutcome": { "userDecision": "rejected", "reason": "wrong_po_match" },
    "accuracyScore": 0.0,
    "userAction": "rejected"
}
```

### Pillar 2: Outcome Tracking

**When:** Aria recommends an action and we later check if it actually happened.

**Integration Points:**
- After purchasing intelligence flags a reorder → check Finale 24-48h later for new PO creation
- After Aria forwards an invoice to bill.com → check if it was processed
- After a vendor follow-up email → check if vendor responded

**Cron:** New "outcome check" task runs daily at 10:00 AM:
- Queries recent `proactive_alerts` and checks Finale for corresponding PO creation
- Queries recent invoice forwarding in `ap_activity_log` and checks bill.com processing status

### Pillar 3: Prediction Accuracy

**When:** A prediction/forecast has a verifiable outcome.

**Integration Points:**
- Build risk predictions → after the build date passes, check `build_completions` for actual shortages
- Reorder alerts → did the item actually stock out before the PO arrived?
- Invoice classification → was the LLM classification correct?

**Scoring:**
- Build risk: predicted CRITICAL and component actually shorted = 1.0 accuracy; predicted OK and it shorted = 0.0
- Reorder: predicted CRITICAL and item stocked out before PO arrived = 1.0; false alarm = 0.0
- Classification: forwarded as INVOICE and bill.com accepted it = 1.0; bill.com rejected = 0.0

### Pillar 4: Engagement Analytics

**When:** Aria sends a message/alert and we track whether Will engaged with it.

**Integration Points:**
- After daily summary → check if Will sent any Telegram messages within 30 minutes (engaged) or not (ignored)
- After build risk alert → check if Will used `/buildrisk` or asked follow-up questions
- After reorder alert → check if Will snoozed, acted, or ignored
- Proactive alert dedup → if same alert fires 3x and Will never acts, lower its priority

**Tracking Method:**
- OpsManager already logs every cron output. New logic: 30 min after sending a summary/alert, check `sys_chat_logs` for user messages. If any contain keywords related to the alert topic, mark as "engaged."

### Pillar 5: Self-Improving Error Handling

**When:** The supervisor agent processes an error.

**Integration Points:**
- Enhanced supervisor records every error+remedy+outcome to `feedback_events`
- Pattern detection: "This error type has been RETRY'd 5 times this week — maybe it's not transient"
- Time-of-day correlation: "Finale API errors cluster around 2-3 AM — scheduled maintenance?"
- Resolution time tracking: how long from error to resolution?

### Pillar 6: Vendor Reliability Scoring

**When:** Any vendor interaction completes.

**Computed from:**
- On-time delivery % (PO expected delivery vs. actual tracking delivery date)
- Invoice accuracy % (how often do invoices match POs without reconciliation changes?)
- Response time (from PO send date to vendor acknowledgement email)
- Document quality (how often are their PDFs parseable vs. OCR failures?)

**Function:** `getVendorReliability(vendorName)` returns:
```typescript
{
    vendorName: string;
    overallScore: number;       // 0-100
    onTimePercent: number;
    invoiceAccuracy: number;
    avgResponseDays: number;
    documentQuality: number;
    trend: 'improving' | 'stable' | 'declining';
    recentIssues: string[];
}
```

### Pillar 7: Weekly Self-Review (Kaizen Report)

**When:** Friday 8:15 AM cron, after the weekly summary.

**Produces:**
```
📊 ARIA KAIZEN REPORT — Week of Mar 3-7, 2026

🎯 Accuracy
  Invoice classification: 94% (16/17)
  Build risk predictions: 78% (7/9) ⬆️ from 65% last week
  Reorder timing: 85% (11/13)
  Reconciliation auto-approvals: 100% (8/8)

📬 Engagement
  Daily summaries: 4/5 engaged (80%)
  Build risk alerts: 3/3 acted on (100%)
  Reorder alerts: 6/9 acted on (67%)
  1 alert type consistently ignored: [suggest removal]

🏭 Vendor Reliability
  Top: Kashi (96), Down To Earth (93)
  Watch: AAACooper (72) — 2 late deliveries this week
  Declining: Evergreen (58 → 51) — invoice accuracy dropping

🔧 Improvement Proposals
  • Reconciler auto-approve threshold: suggest raising from 3% → 4%
    (18 approvals at 3-4% range, zero rejections in 30 days)
  • Build risk false positive rate is 22% — consider adjusting safety stock buffer
  • Vendor "Evergreen" invoices failing OCR 40% of the time — flag for manual review

💡 What I Learned This Week
  • AAACooper now sends individual invoices (not multi-page statements) — updated vendor pattern
  • Build "CRAFT8" consistently uses more Hub-444 than BOM specifies — BOM may need update
```

**Self-review also:**
- Syncs high-confidence learnings to Pinecone memory
- Proposes threshold adjustments (requires Will's /approve to apply)
- Detects accuracy drift and raises alerts if any domain drops below 60%

---

## Integration Strategy

### Files Modified:
- `src/lib/finale/reconciler.ts` — Add `recordFeedback()` calls to approve/reject flows
- `src/lib/intelligence/ops-manager.ts` — Add outcome-check cron, engagement tracking, weekly kaizen report cron
- `src/lib/intelligence/supervisor-agent.ts` — Enhanced error pattern recording
- `src/cli/start-bot.ts` — Correction capture on user overrides

### New Files:
- `src/lib/intelligence/feedback-loop.ts` — The central module
- `supabase/migrations/YYYYMMDD_create_feedback_events.sql` — Database table

### Cron Schedule Additions (OpsManager):
- `10:00 AM daily` — Outcome verification check
- `8:15 AM Fridays` — Kaizen self-review report

---

## YAGNI Guard

Explicitly **not** building (yet):
- Auto-applying threshold changes. Proposals only — Will approves.
- Dashboard confidence panel. Will get to this in Phase 3.
- Real-time drift alerting. Weekly review is sufficient for now.
- Memory pruning. Wait until we see memory accumulation issues.

---

## Success Criteria

1. Every reconciliation approve/reject is captured as a feedback event
2. Weekly Kaizen report includes accuracy metrics across all domains
3. Vendor reliability scores are queryable via Telegram `/vendor` command
4. Aria's Pinecone memories include validated learnings from feedback
5. Accuracy trends are visible week-over-week in the Kaizen report
