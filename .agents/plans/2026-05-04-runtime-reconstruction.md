# Aria Runtime Reconstruction — Phased Plan

**Author:** Aria + Will, 2026-05-04
**Status:** Proposal, awaiting approval
**Estimated total duration:** 6–10 weeks across 5 phases, gated by burn-in
**Rollback:** Each phase is additive and reversible via env flag

---

## 0. Why this plan looks the way it looks

Aria has been rebuilt multiple times. Each rebuild consumed months and was abandoned partway through when a production fire diverted attention. The half-built rewrites then rotted, leaving Aria more complex, not less.

**The previous rebuilds were not wrong. They were too big to finish.**

This plan is structured so the failure mode that has burned us before cannot happen:

1. **Phase 1 ships in ≤2 weeks** and is independently valuable. If phases 2–5 never happen, Aria is still strictly better than today.
2. **Each phase has a burn-in gate**: 7 consecutive days of unattended operation before the next phase begins. Will should not be chasing the system during burn-in.
3. **Phases 2–5 are deliberately under-specified.** They are sketches, not specs. They get fleshed out after Phase 1 burn-in, because Phase 1 will teach us things we cannot predict from this desk.
4. **Hard rule: if any phase exceeds 2 weeks of clock time, we stop and re-scope, not push through.** Slippage signals over-scoping, not lack of effort.
5. **Nothing existing gets thrown out.** AP agent, reconciler, ops-manager, watchdog, all bot tools — they keep running. New modules wrap them; they do not replace them.

If you read nothing else, read those five points again. They are why this plan has a chance.

---

## 1. The diagnosis driving this plan

From recent conversation, three architectural gaps are real and recurring:

- **Vigilance gap.** Aria has event handlers, not owners. Pending approvals expire silently. Tasks rot in `agent_task` with nobody walking them. Nothing checks whether work that should have happened actually did.
- **Lifecycle gap.** A PO is a Finale row, an outgoing email, maybe an invoice, maybe tracking, maybe receiving — all in different places. Nothing threads them. Tracking is never found. Vendor email replies are not connected to the original PO. Invoice→PO correlation is fire-once and frequently fails.
- **Kaizen gap.** Aria executes routines but does not improve them. Vendor patterns Will has explained twice still need explaining. Thresholds that were wrong stay wrong. The `setImmediate` Pinecone Q→A auto-learn is *memorization*, not learning. There is no loop turning outcomes into rule changes.

These gaps share a structural cause: **Aria has executors and no reviewers.** The modules below introduce reviewers as first-class primitives.

---

## 2. The five missing primitives

| Module | Owns | Replaces (eventually) |
|---|---|---|
| `runtime/memory` | typed memory: vendor rules, price observations, thread links, lessons, user prefs | scattered Pinecone Q→A blobs, `vendor_memory` namespace, ad-hoc string memos |
| `runtime/policy` | gate modes (`read_only` / `draft_only` / `approval_required` / `auto_execute`) and per-vendor overrides | hard-coded reconciler thresholds, `ap_pending_approvals` ad-hoc TTL |
| `runtime/steward` | walks open lifecycle state, re-raises rot, escalates staleness | nothing today |
| `runtime/curator` | daily/weekly retro: turns outcomes into proposed rule adjustments | nothing today |
| `runtime/skills` | loadable, versioned playbooks with deprecation | `.agents/workflows/*.md` and ad-hoc handler code |

**These are not Hermes modules.** This is Aria, refactored around the same primitives Hermes names because those primitives are the ones we keep saying are missing. We will not import a runtime, we will not pay per-task, we will not move credentials off-machine. Existing Finale/Gmail/Slack/Playwright/Telegram code stays.

---

## 3. Phase 1 — Observability + Auto-Kaizen Loop

Phase 1 is split into two sub-phases. **1a ships first, alone, and proves the AP pipeline is actually doing what we think it's doing.** 1b layers learning on top — but only after 1a has produced a week of real outcome data.

This split exists because Will currently has no visibility into whether reconciliations are happening at all. Building a learning layer on an opaque box is how previous rebuilds rotted. We open the box first.

### 3.0 Phase 1a — Observability (target: 3–5 days, ships before 1b)

**Goal:** Will trusts what the AP pipeline is doing within a week, because he can see every invoice and every outcome on demand.

**Deliverables:**

- New table `reconciliation_outcomes` (schema in §3.4.3 below) — every reconcile run writes one row
- One-shot backfill script `src/cli/backfill-reconciliation-outcomes.ts` that reads existing `ap_activity_log` (last 90 days) and synthesizes `reconciliation_outcomes` rows so `/recon-status` is useful on day one, not after a week of new data
- Reconciler instrumented to write structured outcomes going forward (additive, parallel to existing `ap_activity_log` writes)
- New Telegram command `/recon-status` — bucketed counts for last 24h / 7d / 30d:
  - Invoices arrived (count + breakdown by vendor)
  - Matched to PO (auto-applied / pending / approved / rejected / expired)
  - Match-failed (with vendor + amount + Gmail link to investigate)
- Daily 7:55 AM AP block prepended to the existing morning digest with the same bucketed counts plus anomaly callouts ("3 vendors had no invoices arrive in the last 14 days, expected ≥1")

**Phase 1a ships zero kaizen logic.** It is pure read. If Phase 1a reveals the pipeline is broken, we fix that before building anything on top.

**Phase 1a success criteria:**

1. `/recon-status` returns real data within 5 days of approval to start
2. Backfill from `ap_activity_log` produces ≥30 days of bucketed history
3. The 7:55 AM digest runs unattended for 7 consecutive days without errors
4. Will reads it and either says "this matches what I thought was happening" OR identifies a specific gap to fix before 1b starts

Phase 1b begins only after this gate passes.

### 3.1 Why this slice first (applies to 1b)

We need to prove the kaizen loop works end-to-end on **one** narrow domain before generalizing. AP invoice→PO reconciliation is the right pick because:

- It runs frequently (every 15 min via ops-manager) — the loop will get exercised within hours, not weeks
- It already produces structured outcomes (auto-applied / pending approval / rejected / match-failed) — minimal new instrumentation needed
- Will already feels the pain there (POs not adjusting, invoices not matching) — fixing it has immediate visible value
- The blast radius is bounded: failures here don't break the bot, the watchdog, or the dashboard

### 3.2 Scope (in)

- `src/lib/runtime/memory/` — typed memory module
- New table: `vendor_rules` — runtime-readable rule overrides per vendor
- New table: `reconciliation_outcomes` — structured outcome row per reconcile run
- New table: `kaizen_proposals` — pending rule adjustments awaiting Will's approval
- Curator loop running daily (8:00 AM after morning summary): walks yesterday's `reconciliation_outcomes`, generates 0–N `kaizen_proposals`, sends one Telegram digest
- `/lessons` Telegram command: paginated view of pending proposals with inline approve/reject buttons
- Reconciler reads `vendor_rules` at runtime (additive — falls back to existing thresholds when no rule exists)
- **Auto-apply with 24h veto window** — proposals fire automatically; veto button rolls them back and records the rejection as a meta-lesson (curator learns Will's taste, not just data patterns)

### 3.3 Scope (out)

- PO lifecycle threading (Phase 2)
- Tracking number correlation (Phase 2)
- Vendor email thread linking (Phase 2)
- Policy gate formalization beyond what reconciler already does (Phase 3)
- Skill registry (Phase 4)
- Pruning legacy `setImmediate` auto-learn (Phase 5)
- Watchdog, build risk, purchasing intelligence kaizen — out of scope until Phase 1 proves the pattern

### 3.4 Concrete deliverables

#### 3.4.1 Typed memory module

```ts
// src/lib/runtime/memory/types.ts
export type MemoryKind =
  | "vendor_rule"          // mutates reconciler/ap-agent behavior
  | "price_observation"    // historical price points per SKU+vendor
  | "thread_link"          // gmail threadId ↔ PO# mapping (used in Phase 2)
  | "lesson"               // human-readable retro insight
  | "user_preference";     // Will's stated preferences

export interface MemoryRecord<K extends MemoryKind = MemoryKind> {
  id: string;
  kind: K;
  subject: string;          // canonical key (vendor name, sku, po#, etc.)
  payload: Record<string, unknown>;  // typed per-kind via discriminated union below
  source: "curator" | "user" | "reconciler" | "ap_agent" | "watchdog" | "manual";
  confidence: number;       // 0..1
  created_at: string;
  expires_at: string | null;
  superseded_by: string | null;  // chained when curator updates a rule
}
```

Storage: Supabase table `runtime_memory` with GIN index on `(kind, subject)`. Pinecone is *not* deprecated in Phase 1 — it stays for fuzzy retrieval. Typed memory is the new write path for anything structured.

API:
```ts
memory.write(record): Promise<MemoryRecord>
memory.read({ kind, subject }): Promise<MemoryRecord[]>
memory.supersede(oldId, newRecord): Promise<MemoryRecord>
memory.expire(id): Promise<void>
```

#### 3.4.2 `vendor_rules` table

```sql
CREATE TABLE vendor_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name TEXT NOT NULL,
  rule_kind TEXT NOT NULL,  -- 'price_threshold' | 'po_match_pattern' | 'uom_conversion' | 'auto_approve_under' | etc.
  rule_payload JSONB NOT NULL,
  source_proposal_id UUID REFERENCES kaizen_proposals(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES vendor_rules(id),
  active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_vendor_rules_active ON vendor_rules (vendor_name, rule_kind) WHERE active = TRUE;
```

Reconciler change (additive, no behavior change without a rule present):
```ts
const rules = await vendorRules.lookup(vendorName);
const priceThreshold = rules.price_threshold?.percent ?? 0.03;  // existing 3% default
const autoApproveUnder = rules.auto_approve_under?.dollars ?? 500;  // existing $500 default
```

#### 3.4.3 `reconciliation_outcomes` table

Every reconcile run writes one row. Existing `ap_activity_log` continues to write — this is structured-outcome metadata layered on top.

```sql
CREATE TABLE reconciliation_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL,
  invoice_id TEXT,
  po_id TEXT,
  vendor_name TEXT,
  outcome TEXT NOT NULL,  -- 'auto_applied' | 'pending_approval' | 'approved_by_user' | 'rejected_by_user' | 'expired' | 'match_failed' | 'rejected_10x' | 'rejected_invariant'
  outcome_meta JSONB,     -- price_delta_pct, total_impact, match_signals, etc.
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_recon_outcomes_outcome_date ON reconciliation_outcomes (outcome, created_at DESC);
CREATE INDEX idx_recon_outcomes_vendor ON reconciliation_outcomes (vendor_name, created_at DESC);
```

#### 3.4.4 Curator loop

```ts
// src/lib/runtime/curator/ap-curator.ts
// Runs daily at 8:00 AM (Denver) via OpsManager, after the existing morning summary
export async function runApCurator(): Promise<KaizenProposal[]> {
  const yesterday = await reconciliationOutcomes.fetchSince(hoursAgo(24));

  const proposals: KaizenProposal[] = [];

  // Pattern 1: vendor with N+ pending approvals all auto-approved by Will → propose threshold tighten
  // Pattern 2: vendor with N+ match_failed → propose match pattern rule
  // Pattern 3: vendor with N+ expired pending approvals → flag steward gap (Phase 2)
  // Pattern 4: same SKU price drift across N invoices → propose price observation update
  // ... (start with these 3-4, add more after burn-in reveals what's actually noisy)

  return proposals;
}
```

Each pattern is a small pure function. Adding/removing patterns is a one-line change. Patterns themselves are eligible for deprecation in later kaizen cycles — meta-kaizen.

#### 3.4.5 Telegram surface

- **8:00 AM digest** appended to existing morning summary: "🧠 3 lessons from yesterday's AP runs — `/lessons` to review"
- **Auto-apply default** — proposals fire automatically after generation. The morning digest shows BOTH:
  - "🧠 Applying tonight (24h veto window)" — proposals about to take effect, with ⛔ Veto inline button
  - "✅ Applied yesterday" — proposals already active, with ↩️ Rollback inline button
- **`/lessons` command** — paginated list (5/page) showing pending + applied + vetoed history, with full structured analysis on demand:
  - 📖 Why → expands supporting outcome rows + curator's reasoning
  - ⛔ Veto / ↩️ Rollback → reverts the rule and writes the rejection as a meta-lesson (curator learns Will's taste)
  - ⏸ Snooze → defer for 7 days
- **Veto becomes training data.** A vetoed proposal records *why* (text or canned reasons) and curator tightens its patterns in the next cycle.
- **Pinecone backfill is NOT in Phase 1.** Existing `vendor-memory` Pinecone namespace stays as-is, read-only fallback. Migration to typed memory is deferred to Phase 5.

### 3.5 Burn-in success criteria

Phase 2 starts only when ALL of these hold for 7 consecutive days:

1. Curator runs daily without crashing (logs prove it)
2. At least one proposal generated and at least one approved by Will (loop closed end-to-end)
3. At least one `vendor_rules` row read by reconciler at runtime and changed an outcome (proves the rule mutates behavior)
4. Zero noisy proposals (Will rejects with "this is garbage" reason 0 times — if >0, curator patterns get tightened, burn-in clock resets)
5. Will did not have to chase any AP reconciliation that the steward should have caught (signal that AP slice is now self-watching)
6. No regression in existing `ap_activity_log` writes (additive only)

### 3.6 Anti-success signals (stop and re-scope)

- Curator generates 5+ proposals/day for >3 consecutive days → patterns are too eager, tighten before continuing
- Will approves a proposal and the rule doesn't take effect → wiring broken, do not proceed
- `vendor_rules` table reaches >50 rules in week 1 → granularity wrong, re-think rule kinds
- Phase 1 hits day 15 not shipped → STOP. Re-scope. Do not push through.

### 3.7 Rollback

Single env flag: `RUNTIME_MEMORY_ENABLED` (default `true`). Set to `false`:
- Curator cron skips
- Reconciler ignores `vendor_rules` (falls back to hard-coded defaults)
- `/lessons` returns "memory layer disabled"
- Existing AP pipeline continues unchanged

This means we can ship Phase 1 wired but flip it off in seconds if it misbehaves overnight.

---

## 4. Phase 2 — PO Lifecycle Steward (sketch only)

**Starts:** after Phase 1 burn-in passes
**Target duration:** 2 weeks
**Why under-specified:** the right shape of the lifecycle entity will be informed by what curator patterns actually fire in Phase 1

**Sketch:**
- New table `po_lifecycle` with one row per PO, columns for each stage timestamp (sent, vendor_acked, ship_committed, tracking_arrived, invoice_arrived, reconciled, received, paid, closed)
- Steward loop every 15 min walks open rows, applies staleness rules, re-raises rot via `agent_task`
- Tracking correlation: extend `ap-agent` to recognize carrier emails and write to lifecycle row
- Email thread linking: store `gmail_thread_id` on PO at send time; vendor replies on that thread auto-update lifecycle stage
- Curator gains new patterns: "vendor never acks within N days", "tracking never arrives within shipping window", "invoice arrives before tracking" (data quality signal)

**Will be specified:** week 1 of Phase 2, after Phase 1 has run for ≥7 days.

---

## 5. Phase 3 — Policy Gate Formalization (sketch only)

**Starts:** after Phase 2 burn-in
**Target duration:** 1 week
**Why short:** mostly renaming + consolidation, not new behavior

**Sketch:**
- `runtime/policy` module exposes `evaluate(action, context) → 'auto' | 'draft' | 'approval' | 'block'`
- Reconciler thresholds, Bill.com forward, Finale mutation, Slack reaction all consult this
- Per-vendor / per-action overrides come from `vendor_rules` (so Phase 1's table doubles as policy override store)
- No new UI — Telegram approval flow already exists, just unified call site

---

## 6. Phase 4 — Skill Registry (sketch only)

**Starts:** after Phase 3 burn-in
**Target duration:** 2 weeks
**Why deferred:** we want to see what workflows actually crystallize from Phases 1–3 before formalizing them

**Sketch:**
- `runtime/skills` module: registry, version, deprecate, load-on-demand
- Existing `.agents/workflows/*.md` migrate as v1 skills
- Curator gains a pattern: "Will hand-walked the same 3-step workflow N times → propose new skill"
- Skills include both procedural (vendor-specific reconcile playbook) and policy (when to ask vs. when to act)

---

## 7. Phase 5 — Legacy Auto-Learn Deprecation (sketch only)

**Starts:** after Phase 4 burn-in
**Target duration:** 1 week
**Goal:** retire the `setImmediate` Pinecone Q→A auto-learn now that typed memory + curator are doing the job structurally

**Sketch:**
- Audit which Pinecone reads are still load-bearing (probably none for AP, possibly some for bot conversational recall)
- Migrate or retire each call site
- Pinecone `aria-memory` namespace retained read-only for historical retrieval; no new writes
- Final cleanup pass: remove dead code, update CLAUDE.md, update memory files

---

## 8. Anti-patterns we will not repeat

- **No bigbang.** No phase ships >2 weeks of work. If a phase grows, it gets split.
- **No skipping burn-in.** 7 days unattended before next phase, every time. The whole point is to catch real-world failures before they compound.
- **No new abstractions in Phase 1 beyond the five named modules.** No event bus, no DI container, no plugin system, no "agent kernel." We are introducing memory + curator. That is it.
- **No replacing what works.** AP agent, reconciler, ops-manager, watchdog, dashboard — all keep running. New modules wrap them.
- **No moving credentials or data off-machine.** Aria stays local-first. Hermes-the-product is not coming.
- **No deferred kaizen.** Phase 1 includes the kaizen surface. We do not "build the foundation now and wire learning later." Foundation without learning is what we already have.
- **No premature generalization.** We build the AP slice fully before generalizing to PO lifecycle. We build PO lifecycle fully before policy gates. Each generalization step is justified by concrete repeated need, not by symmetry.

---

## 9. Open questions for Will

Answer these before we start Phase 1:

1. **Curator digest timing.** 8:00 AM appended to morning summary, or separate 7:45 AM message, or on-demand via `/lessons` only? **Default:** appended to existing 8:00 AM morning summary.
2. **Approval bar.** **Default (confirmed by Will 2026-05-04): auto-apply with 24h veto window + rollback.** Curator generates proposal → Telegram digest shows "applying tonight" with veto button → after 24h with no veto, rule activates → "applied yesterday" digest shows rollback button. Vetoes become meta-lessons.
3. **Phase 1 stop condition.** If Phase 1 burn-in fails twice (curator too noisy, rules don't fire, etc.), do we abort the whole plan or re-scope Phase 1? **Default:** re-scope twice then abort.

---

## 10. What I need from you to start

- A 👍 or pushback on this plan
- Confirmation that the burn-in discipline is acceptable — i.e., you commit to NOT asking for Phase 1b or Phase 2 features during burn-in weeks, even if you think of something cool
- **Phase 1a canary acknowledged:** Will has stated (2026-05-04) he cannot name a specific reconciliation that should have learned and didn't, because he doesn't believe reconciliations are happening at all. **Phase 1a's first deliverable IS the answer to that question.** If `/recon-status` shows reconciliations are running and matching, we proceed to 1b. If it shows the pipeline is broken or silent, we fix that first and the kaizen layer waits.
