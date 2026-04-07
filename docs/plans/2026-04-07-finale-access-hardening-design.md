# Finale Access Hardening Design

## Summary

Aria should keep Finale reads available, but Finale writes should only happen through the dashboard purchasing flow where a human is actively present. The system should stop allowing background agents, Slack handlers, CLIs, or other incidental code paths to create or commit purchase orders directly.

This design does not try to make Finale access anonymous. Finale access is already account-authenticated through API credentials, so the correct goal is to make Aria's traffic disciplined, minimal, well-audited, and easy to explain.

## Goals

- Make dashboard-driven PO creation and commit the only approved Finale write path.
- Deny all non-dashboard Finale write attempts with clear, reviewable errors.
- Add a small internal audit trail for allowed and denied Finale write attempts.
- Create a foundation for centralizing Finale access without forcing a full client rewrite in this pass.
- Reduce the chance that Finale sees Aria as noisy, bursty, or error-prone.

## Non-Goals

- Replacing all Finale reads with snapshots in this pass.
- Rewriting every `new FinaleClient()` caller immediately.
- Hiding account identity from Finale.
- Removing the existing human review/send workflow from the dashboard.

## Current State

Finale mutations are available from several parts of the codebase today:

- dashboard PO draft creation in `src/app/api/dashboard/purchasing/route.ts`
- dashboard PO review/send flow in `src/app/api/dashboard/purchasing/commit/route.ts`
- PO commit logic in `src/lib/purchasing/po-sender.ts`
- Slack watchdog draft creation in `src/lib/slack/watchdog.ts`
- several CLI and automation paths that call `createDraftPurchaseOrder(...)` directly

Even with the recent safety changes that disabled some automatic paths by default, write capability is still too distributed. The code does not currently enforce a single project-wide rule for who may write to Finale.

## Recommended Approach

### Dashboard-only write gate

Introduce a small write-authorization layer inside the Finale client that requires every mutation to declare:

- `source`: where the request came from, such as `dashboard`, `slack_watchdog`, `cli`, or `automation`
- `action`: the specific write operation, such as `create_draft_po` or `commit_draft_po`

The guard should allow only the dashboard purchasing paths:

- dashboard draft PO creation
- dashboard review/send commit flow

Everything else should fail fast before the HTTP request is made.

### Audit log for attempted writes

Every Finale write attempt should produce a lightweight internal log record, whether allowed or denied. That record should capture:

- timestamp
- source
- action
- whether the attempt was allowed
- a small target summary such as vendor ID or order ID
- a short denial reason when blocked

This log gives us a factual record of what Aria is trying to do and makes suspicious or accidental callers much easier to identify.

### Honest Finale posture

Aria should keep authenticating with the approved account credentials. We should not try to evade identification or disguise the caller. Instead, we should improve the quality of the traffic:

- fewer mutation paths
- fewer background writes
- lower poll pressure
- clearer cache behavior
- consistent request shape
- internal observability

That is the safest and most defensible way to reduce scrutiny.

## Alternatives Considered

### 1. Global write kill switch

Block every Finale write unless a master flag is enabled.

Pros:

- strongest safety barrier
- simplest mental model

Cons:

- too restrictive for your approved dashboard workflow
- adds friction to legitimate human purchasing work

### 2. Dashboard-only write gate

Allow writes only from the dashboard purchasing flow and block everything else.

Pros:

- matches the team's current trust model
- preserves human-in-the-loop PO creation
- sharply reduces accidental and background writes

Cons:

- still requires careful source tagging
- does not yet centralize all read traffic

### 3. Broad allowlist of approved writers

Allow dashboard plus a few additional automations.

Pros:

- more flexibility

Cons:

- easier to drift back into distributed write behavior
- harder to explain and audit

## Decision

Choose option 2: dashboard-only write gating with audit logging.

## Architecture

### Finale write authorization module

Add a small module under `src/lib/finale/` that exposes:

- a `FinaleWriteSource` type
- a `FinaleWriteAction` type
- an `assertFinaleWriteAllowed(...)` function
- a `recordFinaleWriteAttempt(...)` helper

The first implementation can use simple allowlist rules:

- allow `dashboard:create_draft_po`
- allow `dashboard:commit_draft_po`
- deny everything else

### Finale client mutation updates

Update `createDraftPurchaseOrder(...)` and `commitDraftPO(...)` to require a write context object. They should:

1. validate the source/action pair
2. record the attempted write
3. proceed only if allowed

This keeps the policy close to the actual mutation boundary.

### Dashboard route updates

Update the dashboard routes to pass the required write context when creating or committing POs.

This keeps the human-reviewed flow working while making the approved path explicit.

### Non-dashboard callers

Existing non-dashboard callers should either:

- pass their real source and fail with a clear error, or
- be updated to stop attempting the write if they are no longer allowed

For this pass, the important thing is to prevent the write, not to redesign every caller.

## Error Handling

- Denied write attempts should fail with explicit, non-ambiguous errors such as:
  - `Finale write denied: source "slack_watchdog" cannot create draft POs`
  - `Finale write denied: source "cli" cannot commit draft POs`
- Dashboard callers should continue surfacing useful API errors if Finale itself rejects the write.
- Audit logging should be best-effort and must not mask the primary denial or Finale failure reason.

## Testing Strategy

Cover the safety rules before implementation changes:

- unit tests for the write gate allowlist
- route tests proving dashboard draft creation remains allowed
- route or action-layer tests proving non-dashboard sources are denied for commit/draft writes
- PO send tests proving dashboard-triggered commit still succeeds through the allowed path

## Success Criteria

- Aria can still create and commit POs through the dashboard purchasing flow.
- Slack, CLI, and automation paths can no longer write to Finale.
- Every Finale write attempt is recorded internally as allowed or denied.
- Error messages make the blocked caller obvious.
- Finale write behavior becomes simple enough to explain in one sentence:
  dashboard only, human in the loop.
