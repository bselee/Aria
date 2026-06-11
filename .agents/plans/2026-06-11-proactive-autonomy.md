# Aria — Proactive Autonomy Roadmap

> Status: **Proposed** (2026-06-11). Scoping only — no code in this doc.
> Author: review pass following the emit-to-task gap map and the autonomy/IO capability audits.
> Companion docs: `control-plane.md`, `2026-04-27-task-learning-loop.md`.

## 0. The thesis

Aria's problem is not missing infrastructure. The autonomy substrate is ~70% built and
mostly idle:

| Substrate | State | Evidence |
|---|---|---|
| Flows runner (event → steps → escalate) | **production**, only 2 flows | `src/flows/runner.ts`, `src/flows/index.ts` |
| Playbook Layer-C runner (picks up queued tasks, executes) | **production**, only 2 trivial playbooks | `src/lib/intelligence/playbooks/runner.ts`, `registry.ts` |
| Approval hub (unified NEEDS_APPROVAL → execute) | **production** | `src/lib/intelligence/agent-task.ts` |
| Vendor autonomy levels (0/1/2) | **partial** — level 2 auto-send disabled | `src/lib/purchasing/autonomy-engine.ts` |
| Drafter (creates Finale drafts, never sends) | **production** | `src/lib/purchasing/drafter-agent.ts` |
| Gmail send (PDF + text, multi-account) | **present & used** | `src/lib/gmail/send-email.ts` |
| Slack post / thread-reply (bot + user token) | **present & used**, eyes-only by policy | `src/lib/slack/request-detector.ts` |
| Telegram inline-button approval UI | **production, rich** | `src/cli/handlers/*` |
| Task ledger (for pattern mining) | **production**, unmined | `task_history` via `agentTask.appendEvent` |

What is missing is the **semantic layer** that turns "notify Will" into "act within a trust
boundary, escalate only the exceptions." Every pathway today terminates in one of two states:

1. **Notify-only** — a Telegram/Slack message with no durable obligation (the noise).
2. **Approve-to-act** — Aria proposes, Will taps a button, Aria executes (gated-manual).

Neither is autonomous. The roadmap is the move from **approve-everything** to
**exception-gating**: Aria acts on the routine majority and reserves Will's attention for the
genuinely ambiguous or high-stakes minority.

## 1. The core model: tiered autonomy + reversal window

Introduce **one** governed policy surface (`autonomy_policy` table + `src/lib/autonomy/policy.ts`)
that replaces today's scattered env flags (`PAYMENT_INQUIRY_AUTOREPLY_ENABLED`,
`vendor_profiles.autonomy_level`, `HUB_TASKS_ENABLED`, etc.). Every autonomous-capable action
type maps to a tier:

| Tier | Name | Behavior | Example |
|---|---|---|---|
| T0 | **OBSERVE** | Detect, record to hub, no message unless asked | low-risk FYI |
| T1 | **DRAFT** | Prepare the artifact (PO draft, email draft), surface for one-tap send | today's drafter |
| T2 | **PROPOSE** | Stage the executed action behind a NEEDS_APPROVAL hub row | today's PO-send |
| T3 | **ACT-WITH-UNDO** | **Execute now**, hold a reversal window (N min/hours), auto-finalize if no veto | the new default for routine work |
| T4 | **ACT** | Execute immediately, log only | trivially reversible / zero-risk |

**T3 is the centerpiece.** It inverts the interaction: instead of "nothing happens until Will
taps approve," the action happens and Will gets a single "✅ done — tap to undo (expires 2h)"
message. The reversal window is enforced by the existing closure-cron pattern
(`closeFinishedTasks` → finalize) and the existing Telegram callback handlers (add an `undo_*`
callback alongside `approve_*`). Most current alerts collapse into one T3 confirmation or, better,
into the **daily autonomy digest** (§5) — no per-event ping at all.

**Tier assignment is per (action_type, risk_band)**, not global. e.g. a vendor payment-status
reply is T3 (reversible, low stakes); a PO send >$X stays T2; a Finale price write within the
existing magnitude ceiling is T3; outside it, T2.

## 2. Phased delivery

Each phase is independently shippable and gated so it can roll back to the current behavior by
dropping every action to T2 (approve-to-act) via one policy switch.

### Phase A — Policy spine + reversal window (foundation)
- `autonomy_policy` table + `src/lib/autonomy/policy.ts` (`tierFor(actionType, context) → T0..T4`).
- Reversal-window mechanism: a hub row in a new `EXECUTED_PENDING_FINALIZE` state, an `undo_<id>`
  Telegram callback, and a closure predicate `reversal_window` that finalizes after the TTL.
- The daily autonomy digest job (the one proactive message).
- **No behavior change yet** — every action ships at T2, identical to today. This phase only lays
  rails and is safe to merge dark.
- Reuses: `agent-task.ts`, `agent-task-closure.ts`, `telegram-notify.ts`, Telegram callback handlers.

### Phase B — Convert the noisiest emit points to flows (kill the alerts)
From the emit-to-task gap map, the 18 orphan emit points become flows with autonomous steps and
exception-only escalation. Priority order (revenue + noise):
1. `jit_order_trigger` (already routed to hub — graduate to a flow that, at T3, auto-creates the
   Finale draft and reserves a send window).
2. AP stuck-invoice (`email-forwarding-alert`) → flow: auto-retry forward, escalate only on repeat.
3. Vendor escalation / delivery exception → flows with templated vendor outreach at T2/T3.
4. `ap-polling` failure → playbook (self-heal: re-auth, re-poll) before it ever pings Will.
- Reuses: `src/flows/*` (the runner already escalates cleanly), playbook runner for self-heal.

### Phase C — Graduated Slack autonomy (gated)
Slack is deliberately eyes-only today. Extend, behind policy:
- **Slack thread actions**: the request-detector already thread-replies with PO data; add a
  reaction-driven action ("react ✅ to draft a PO for this SKU") — Slack-native gating, no new UI.
- **Outbound status replies** at T3 with reversal window (Will sees it in the digest; can retract).
- Keep DMs and free chat **out of scope** — Slack stays a structured action surface, not a chatbot.
- Reuses: `request-detector.ts` writer client (bot token), `addEyesReaction`/`postMessage` paths.

### Phase D — Graduated email autonomy (gated)
Today only one template sends (payment-status ack, default OFF). Add, behind policy + reversal:
- Vendor PO confirmation replies, delivery-proof requests, invoice-discrepancy first-contact.
- All drafted by LLM, **executed by deterministic code** (never the chat loop), T2→T3 as trust grows.
- Reuses: `sendGmailPdfEmail` / `sendTextOnlyGmailEmail`, the `ap`/`default` token slots, the
  `vendor_payment_inquiry` flow as the template.

### Phase E — Learning loop: data-driven tier promotion
This is what makes it "learning," not just "automated."
- Mine `task_history` (the ledger already exists): per action_type, compute approve-rate,
  override-rate, undo-rate, time-to-decision.
- Surface a weekly "promotion proposal": action types with a clean track record (e.g. >50 samples,
  <2% override) propose T2→T3 (or T3→T4); noisy ones propose demotion.
- **Will approves promotions** (the one human-in-the-loop that matters) — the system never
  self-escalates its own authority without sign-off.
- Reuses: `task_history`, the pattern-miner slot already reserved in the learning-loop plan.

## 3. Hard safety rails (non-negotiable, land in Phase A)
- **Global kill-switch**: `AUTONOMY_MASTER=off` drops everything to T2 instantly (one env, no deploy).
- **Per-tier rate limits**: max autonomous actions/hour per action_type; breach → auto-demote + alert.
- **Reversibility requirement**: an action may only be assigned T3/T4 if it has a defined undo path.
  Irreversible actions (money leaving, external sends that can't be retracted) cap at T2.
- **Everything is a hub row + ledger event**: no autonomous action exists off-book. The dashboard
  `/tasks` view and `task_history` are the complete audit trail.
- **Money guardrails unchanged**: the reconciler magnitude ceiling and balance gates stay; autonomy
  tiers never override an existing financial hard-stop.

## 4. Explicitly out of scope
- LLM directly invoking write-tools in the chat loop (keep proposer/executor split — LLM proposes,
  policy + deterministic handlers execute).
- Slack as a conversational chatbot / DMs.
- Free-text Telegram capture (button + reaction gating only).
- Any change to the reconciliation thresholds (separate decision, needs Will).

## 5. The one proactive message
Replace per-event alerts with a single **daily autonomy digest** (Telegram, morning):
"Yesterday I did X autonomously (N POs drafted, M emails sent, K invoices reconciled), R items
need you, and here's what's still open." Everything else is silent unless it crosses into T2 or
trips a rail. This is the concrete answer to "noise and alerts" — the firehose becomes one
accountable summary plus an exception queue.

## 6. Sequencing & risk
- A (foundation, dark merge) → B (noise kill, highest ROI) → C/D (Slack/email, parallelizable)
  → E (learning, only after A–D feed the ledger real outcomes).
- Each phase merges behind policy at T2, so the blast radius of every step is opt-in per action_type.
- Biggest risk is **tier mis-assignment** (acting autonomously on something that should have gated).
  Mitigation: every action starts at T2 and is promoted only by Phase E's evidence + Will's sign-off.
  Nothing reaches T3 by default in phases A–D except the explicitly enumerated low-risk set.
