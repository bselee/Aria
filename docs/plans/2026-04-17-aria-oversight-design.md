# Aria Oversight & Skill Crystallization Design

**Date:** 2026-04-17
**Status:** Approved

## Overview

Borrow two concepts from GenericAgent:
1. **Skill crystallization** — successful execution paths get saved as reusable Skills
2. **Full L0-L4 layered memory** — explicit layers from meta-rules to session archives

Combined with internal autonomous control — Aria handles errors and recovery without interrupting Will, escalating only for unprecedented issues.

---

## Architecture

Three new components, existing code untouched:

```
┌─────────────────────────────────────────────────────────────────┐
│                         ARIA SYSTEM                              │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Telegram  │  │  Dashboard  │  │  Frontends (Slack, etc) │  │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘  │
│         └────────────────┼──────────────────────┘               │
│                          ▼                                       │
│              ┌─────────────────────────┐                        │
│              │     OversightAgent      │  ← NEW: Central overseer│
│              │  • Heartbeat monitoring │                        │
│              │  • Self-healing engine  │                        │
│              │  • Escalation router   │                        │
│              └───────────┬─────────────┘                        │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    AGENT LAYER                              │ │
│  │  AP Agent │ Nightshift │ Build Risk │ Tracking │ ...        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   MEMORY LAYER (L0-L4)                      │ │
│  │  L0: Meta Rules  │  L1: Insight Index  │  L2: Global Facts │ │
│  │  L3: Skills/SOPs │  L4: Session Archives                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                          │                                       │
│                          ▼                                       │
│              ┌─────────────────────────┐                        │
│              │   SkillCrystallizer      │  ← NEW: Auto-skill gen │
│              │  • Captures success paths │                        │
│              │  • Writes to L3          │                        │
│              │  • Skill invocation      │                        │
│              └─────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. OversightAgent

### Purpose
Central supervisor that monitors all agents, catches failures, self-heals autonomously, escalates only when unprecedented.

### Heartbeat System

Every agent reports a heartbeat to `agent_heartbeats` table (new) every N minutes:

| Field | Type | Description |
|-------|------|-------------|
| `agent_name` | text | Identifier (ap_agent, nightshift_agent, etc.) |
| `last_heartbeat_at` | timestamptz | Last ping time |
| `status` | enum | HEALTHY, DEGRADED, DOWN, UNKNOWN |
| `current_task` | text | What the agent is currently doing |
| `metrics` | jsonb | Agent-specific metrics (errors/min, queue depth, etc.) |

Watch interval: OversightAgent checks heartbeats every 5 minutes. If an agent's `last_heartbeat_at` is older than `heartbeat_interval × 3`, mark it DOWN.

### Self-Healing Engine

When an agent is marked DOWN, OversightAgent attempts recovery in order:

1. **Retry** — If crashed cleanly, restart via `safeRun()` wrapper
2. **Restart child process** — For ULINE/FedEx/Axiom reconcilers
3. **Reset state** — Clear in-memory stores, re-hydrate from Supabase
4. **Escalate** — If recovery fails 3 times, Telegram message to Will

**Self-healable:** AP agent re-poll, Nightshift restart, Tracking flush+re-poll, Vendor reconciler restart from last known good state.

**Non-self-healable (escalate immediately):** Finale API credentials expired, Supabase connection permanently failing, disk/memory exhaustion.

### Escalation Model

**Will is NOT notified on every action.** Notifications only when:
- Aria encounters a genuinely new situation (new vendor, new error type, new failure mode)
- Recovery fails 3 times
- External validation fails on a financial action

### Verification

- **Skill confidence scores** — Every skill tracks success rate. Low confidence → flag for review.
- **Outcome logging** — Every autonomous action writes to `task_history`: what happened, result, deviations.
- **Periodic digests** — Daily summary: autonomous actions completed, successes, retries, new skills crystallized.

---

## 2. SkillCrystallizer

### Purpose
Watch successful task completions, extract execution path, save as reusable L3 Skill.

### Skill Lifecycle

```
[Agent completes task successfully]
    → OversightAgent marks task as SUCCESS in `task_history`
    → SkillCrystallizer picks up the record
    → Analyzes: input, steps taken, output
    → Crystallizes into Skill template
    → NEW SKILL enters SHADOW MODE immediately
    → Stores in `skills` table (review_status: pending)
    → Telegram: "New skill pending: [name]. [n] shadow runs completed."
    → Will reviews via Telegram + Dashboard
    → Will approves/rejects/edits
    → APPROVED → skill moves to active, runs autonomously with external validation
    → REJECTED → archived, rejection reason recorded as L4 context for Kaizen
```

### Skill Structure

```typescript
interface Skill {
  id: string;
  name: string;                    // "reconcile_uline_invoice"
  description: string;             // "Parses ULINE PDF invoice, matches to Finale PO..."
  trigger: string;                 // "invoice from ULINE with PDF attachment"
  agent_name: string;
  steps: SkillStep[];
  confidence: number;              // 0-1, based on repeated successful use
  times_invoked: number;
  times_succeeded: number;
  created_at: timestamptz;
  updated_at: timestamptz;
  created_by: "auto" | "manual";
  review_status: "pending" | "approved" | "rejected";
  rejection_feedback?: string;     // recorded when rejected
}

interface SkillStep {
  order: number;
  action: "tool_call" | "llm_call" | "db_query" | "api_call" | "wait" | "decision";
  name: string;
  params: Record<string, unknown>;  // sanitized (no secrets)
  result_pattern?: string;
  error_pattern?: string;
}
```

### Shadow Mode

Newly crystallized skills follow the crystallized path internally but do NOT execute actions externally. Reports to Will via:
- **Telegram:** Summary notification with skill name and shadow run count
- **Dashboard:** Full action trace (every step with timestamps), external validation results, diff for record changes

### Skill Invocation

When a task arrives:
1. Match trigger — semantic search against skill descriptions (Pinecone)
2. Load skill — fetch steps from `skills` table
3. Execute steps — agent follows crystallized path
4. Record outcome — success → confidence++, fail → confidence--, back to exploration
5. If confidence < 0.3 → flag for review, notify Will

### Rejection Feedback

When Will rejects a skill:
- Skill archived (not deleted)
- Rejection reason recorded as L4 Session Archive context
- Kaizen loop incorporates the correction
- Future crystallizations of similar tasks reference this rejection

---

## 3. MemoryLayerManager (L0-L4)

### Layer Definitions

| Layer | Purpose | Storage | Access |
|-------|---------|---------|--------|
| **L0: Meta Rules** | Core behavioral rules, safety constraints, system bounds | SQLite (local-db.ts) + hardcoded | Loaded at startup |
| **L1: Insight Index** | Fast routing index — what memory exists, where to find it | Pinecone (aria-memory, lightweight vectors) | Vector search, refreshed on read |
| **L2: Global Facts** | Stable long-term knowledge — vendor info, preferences, contacts | Pinecone + Supabase | Semantic recall with TTL |
| **L3: Skills/SOPs** | Reusable task execution paths | Supabase `skills` table | Skill invocation |
| **L4: Session Archives** | Distilled records from completed sessions | Pinecone + `task_history` | Fetched on startup for continuity |

### Existing → Layer Mapping

| Existing | Layer |
|----------|-------|
| persona.ts (system prompts) | L0 Meta Rules |
| Pinecone vendor-memory namespace | L2 Global Facts |
| Pinecone aria-memory namespace | L1 Insight Index + L4 Session Archive |
| Supabase vendor_invoices, documents | L2 Global Facts |
| In-memory Maps (reconciler, dropship-store) | L1 Runtime Context (ephemeral) |
| Supabase cron_runs | L4 Session Archive |
| Supabase feedback_events | L4 Session Archive |
| SQLite local-db.ts | L0 Meta Rules + L4 Session Archive (hybrid) |

### L0: Meta Rules Contents
- Safety guardrails (invoice thresholds, auto-approve limits)
- Agent behavioral constraints (never delete, never spend without approval)
- System bounds (allowed vendors, allowed actions per agent)
- API rate limits (Finale, Gmail, Supabase)

### L1: Insight Index Contents
- What knowledge exists in L2 (vendor patterns, contacts)
- Where to find it (Pinecone namespace, Supabase table)
- Recent agent decisions (last 24h, lightweight)
- Active task state (current execution context)

### L4: Session Archive Contents
- Task history: what was attempted, succeeded/failed, why
- Agent decision rationale: why did AP agent skip this email?
- Kaizen feedback distilled: lessons learned per vendor per month
- Rejection feedback: why skills were rejected, corrections applied

---

## 4. Safety: External Validation

For any action that modifies financial data (invoices, POs, prices, approvals), Aria must:

1. Read back external state after action (e.g., query Finale API for the PO she just updated)
2. Confirm change was applied correctly
3. If mismatch → rollback attempt + escalate to Will

This means even approved skills cannot silently corrupt financial records.

---

## 5. Implementation Order

1. **OversightAgent** — heartbeat monitoring, self-healing, escalation router
2. **MemoryLayerManager** — L0-L4 taxonomy, unify existing memory access
3. **SkillCrystallizer** — task history tracking, skill structure, shadow mode
4. **Dashboard integration** — oversight panel, skill review queue
