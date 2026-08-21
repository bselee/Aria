# 15 — Outbound Review Gate

**Domain:** External Communications & Bill Voice  \
**Owner:** aria-reviewer  \
**Last Updated:** 2026-08-20  \
**Supersedes:** honor-system review via reviewer memory only (2026-08-19)

## Purpose
Nothing reaches Bill or the outside world without passing the review gate. This SOP makes the gate mechanical where possible and process-backed everywhere else.

## Bill Voice Rules (non-negotiable)
- NO emojis. Not even one.
- ≤25 words max. Shorter is better.
- No bullet points. Ever.
- No AI-isms: "certainly", "I would recommend", "please note", "I hope this helps", "let me know if you need anything"
- @recipient in messages — natural, not formal
- PO replies: `*Ordered <link|PO-####> ETA mm/dd*` — bold, linked, one per PO
- Slack: `<@UID>` in payload. NEVER chat.update.
- Telegram: plain text only. CHAT_ID=8531889063.
- Email: short, direct, professional but casual — like Bill typed it on his phone

## Mechanical Gate (enforced in CI/test)
- `src/lib/voice-gate/voice-gate.test.ts` — fails the suite on emoji or AI-isms in outbound template strings.
- Scope: outbound-facing strings (Telegram sends, PO emails, briefings, task replies). Console.* dev logs are excluded by design.
- **Adding a file that builds outbound text?** Add it to `OUTBOUND_FILES` in the gate.
- **Gate fires on a legit string?** That's a voice violation — rewrite the string, never silence the gate.

## Draft → Review → Send Flow (process gate)
1. **Draft** — sender (aria-comms / aria-slack / aria-purchasing / aria-coder) writes the message per voice rules above.
2. **Review** — post the draft to aria-reviewer in the Code group BEFORE any send. Reviewer runs PASS 1: flags tone, length, AI-isms, formatting with specific changes.
3. **Revise** — sender returns a revision addressing every flag.
4. **Approve** — reviewer approves ONLY when it sounds exactly like Bill. No first-pass approvals, ever.
5. **Send** — sender sends the approved text verbatim. No edits after approval.
6. **Notify** — report completion to Hermia with before/after examples.

## Exceptions
- **Critical alerts** (system down, payment deadlines): send immediately, then post for review after. Silence is worse than noise.
- **Mechanical confirmations** (PO sent, invoice matched): template-driven, gate-covered — no per-message review needed.

## Kaizen Notes
- 2026-08-20: Gate created after assessment found 8 files shipping outbound emoji that the reviewer process had missed (bot.ts, monday-briefing.ts, sandbox-watcher.ts, supervisor-agent.ts, lead-time-tracker.ts, autonomy-engine.ts, task-actions.ts, reconciliation/notifier.ts). The mechanical gate exists precisely because process memory leaks.
- Review cadence: quarterly or on any voice-rule change.

**Related Skills:** none — this SOP is the authoritative voice reference.

---
**Status:** Gate live. All outbound templates emoji-free as of 2026-08-20.
