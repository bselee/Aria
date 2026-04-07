# AP Reconciliation Surgical Updates Design

## Summary

Aria should keep purchase-order creation and commit tightly gated to the dashboard, but AP invoice reconciliation needs one additional narrowly scoped write lane: surgical updates to already committed POs when the correlation is exact and the deltas are small, explainable, and safe.

This change should not feel like "more automation." It should feel like a calm assistant that either:

- applies a tiny, high-confidence invoice correction in place, or
- places a clean action card in the AP / Invoices dashboard when any guardrail is not met.

The AP / Invoices interface should become action-first. Operators should see only the work that needs a decision, the exact proposed change, and the smallest possible set of buttons to move it forward.

## Goals

- Allow exact invoice-driven corrections to committed POs without reopening broad mutation access.
- Auto-apply only when the PO correlation is exact and the deltas are tightly bounded.
- Route all ambiguous or risky reconciliations into the dashboard review lane with clear notes.
- Keep a durable audit trail of what changed, why it auto-applied, or why it required review.
- Simplify the AP / Invoices interface so it shows action items, not operational noise.

## Non-Goals

- Expanding general committed-PO edit rights beyond AP reconciliation.
- Allowing "best guess" PO rematches to auto-apply.
- Performing broad PO rewrites, open/close churn, or repeated mutation loops.
- Building a second dashboard for AP review separate from the existing invoice queue and reconciliation action flow.

## Current State

The codebase already contains most of the right building blocks:

- Reconciliation plans are produced in `src/lib/finale/reconciler.ts`.
- Exact fee and price updates already have low-level Finale client support in `src/lib/finale/client.ts`.
- Dashboard approval actions already flow through `src/app/api/dashboard/reconciliation-action/route.ts`.
- The AP / Invoices panel already has an action lane in `src/components/dashboard/InvoiceQueuePanel.tsx`, but it is still too status-heavy and log-shaped.

The current gap is behavioral: committed-PO updates are either too manual or too broad conceptually. The system needs a single narrowly defined exception for AP reconciliation, plus a cleaner operator surface.

## Recommended Approach

### 1. Add a dedicated AP reconciliation write lane

Keep the new Finale write gate intact, but add one additional approved mutation source:

- `ap_reconciliation:update_committed_po`

This source is not a general PO editing privilege. It only authorizes the exact committed-PO mutation primitives already used by reconciliation:

- line-item unit price correction
- bounded quantity correction
- fee/freight adjustment

Any other mutation type remains blocked.

### 2. Auto-apply only when every guardrail passes

An already committed PO may be updated automatically only when all of these are true:

- exact PO number correlation is present
- invoice timing is inside the accepted PO window
- SKU correlation is exact enough to map invoice lines to existing PO lines
- quantity delta is `<= 5%`
- unit price delta is `<= 5%`
- freight/fee change passes the existing freight logic, including the larger-load rule and the `< $4,000` ceiling
- no duplicate-reconciliation guard is triggered
- no extraction-quality or balance gate is triggered

If any guardrail fails, Aria must not write. It should create or preserve a review item in the dashboard with a plain-language note describing why approval is required.

### 3. Make quantity changes symmetrical but bounded

Quantity changes should be treated like price changes:

- exact mapped line only
- bounded to `<= 5%`
- same audit and approval behavior

This means a small invoice-to-PO quantity drift can auto-apply, but any larger swing becomes review-required.

### 4. Keep updates surgical

Committed-PO updates must be minimal and in-place:

- do not reopen general editing flows
- do not repeatedly open/close or relock a PO unless Finale itself requires the specific targeted update path
- do not rewrite unaffected PO lines
- do not mutate unrelated fees or adjustments

Every apply path should operate only on the exact fields covered by the approved reconciliation diff.

## Guardrail Model

### Match requirements

Auto-apply requires:

- exact PO number
- acceptable invoice timing relative to the PO
- exact line mapping confidence

If any of those are weak, the result becomes `needs_approval`.

### Delta thresholds

Auto-apply thresholds:

- quantity delta: `<= 5%`
- unit price delta: `<= 5%`
- freight: under the existing rule set, including larger-load handling and `< $4,000`

Anything outside those limits falls back to the dashboard review lane.

### Review fallback

Fallback messaging should be concise and operational:

- `Invoice > PO correlation needs approval`
- `Qty delta exceeded 5% on SKU ABC123`
- `Price delta exceeded 5% on SKU XYZ999`
- `Freight adjustment requires review`
- `Timing window check failed for PO 124547`

Notes should be visible in the operator queue without needing to expand a large log card.

## UI Direction

### Action-first AP / Invoices panel

The AP / Invoices panel should emphasize three buckets:

- `Needs Approval`
- `Recent Auto-Applied`
- `Exceptions`

The default surface should show only actionable work and recent outcomes, not every reconciliation artifact.

### Per-item card content

Each actionable item should show:

- vendor
- invoice number
- exact PO number
- short status
- exact proposed diff
- the single blocking note, if any

The diff should be human-readable:

- `SKU ABC123 qty 100 -> 104`
- `SKU XYZ999 $12.40 -> $12.88`
- `Freight $0.00 -> $386.50`

### Actions

Primary actions:

- `Approve`
- `Reject`
- `Rematch`
- `Open PO`
- `Open Invoice`

Secondary details can stay expandable, but they should not dominate the row.

### Remove noise

The panel should stop leading with:

- aggregate status clutter
- stale informational rows
- operational statistics that do not change the next action

Stats can remain present, but the panel should read like a work queue, not an audit ledger.

## Architecture

### Reconciler changes

Extend the reconciliation result model to explicitly represent:

- quantity changes as first-class change records
- whether a committed-PO update is eligible for surgical auto-apply
- a concise operator note for fallback-to-review cases

### Mutation authorization

Extend the Finale write-access policy with an AP reconciliation source/action pair that authorizes only the exact committed-PO update path. It should not authorize PO creation or general PO commits.

### Dashboard data shaping

Update the invoice queue API to return a more action-oriented payload:

- actionable status bucket
- concise note
- compact diff summary
- review-required reason
- recent auto-applied changes

This should let the panel render simple cards without reconstructing business logic in React.

## Error Handling

- If a targeted Finale update fails, the invoice should stay or become `needs_approval`.
- The dashboard note should explain which mutation failed.
- Audit logging failures must never silently discard a successfully applied PO update; they should log loudly and preserve operator visibility.
- Auto-apply must remain idempotent with duplicate-reconciliation guards intact.

## Testing Strategy

Add coverage for:

- exact PO + timing + small quantity/price deltas auto-applying
- delta `> 5%` forcing `needs_approval`
- freight auto-applying only when the existing freight rules allow it
- weak correlation falling back to dashboard review
- write access allowing `ap_reconciliation:update_committed_po` but not general PO creation/commit
- invoice queue API returning action-first payload fields
- AP / Invoices panel showing actionable cards and concise diffs cleanly

## Success Criteria

- Small, exact invoice corrections on committed POs can auto-apply surgically.
- Larger or ambiguous reconciliations always fall back to the dashboard review lane.
- The only newly opened write lane is the AP reconciliation surgical-update path.
- Operators can scan AP / Invoices quickly and see only what needs action.
- Every applied or blocked change leaves a clear audit trail and a short human-readable note.
