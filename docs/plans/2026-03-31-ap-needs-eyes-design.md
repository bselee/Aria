# AP Needs Eyes Design

**Problem**

The AP intake flow now preserves manual-review emails correctly, but the dashboard does not surface those review needs cleanly. The existing AP / Invoices panel should stay compact and should not gain another queue or another panel.

**Goal**

Add a minimal `Needs Eyes` signal to the existing AP / Invoices panel so Bill can quickly see whether AP intake produced manual-review work, without exposing raw internal codes or cluttering the dashboard.

## Recommended Approach

Reuse the existing AP / Invoices header and add one compact summary badge only when actionable intake review items exist.

The badge should:
- live in the existing header beside the current `PENDING` / `STALE` indicators
- appear only when there is something to review
- summarize just two counts:
  - `PDF` for invoice-like emails missing an attachment
  - `HUMAN` for AP inbox messages that need a human response
- use human-readable text, not internal `reasonCode` names

## Data Source

Use `ap_activity_log` as the source of truth.

The dashboard API should query recent AP activity rows carrying these metadata reason codes:
- `missing_pdf_manual_review`
- `human_interaction_manual_review`

These signals already come from the AP identifier and represent the exact “leave visible and review” cases we care about.

## API Shape

Extend the existing invoice queue response with a tiny summary object:

```ts
needsEyes: {
  missingPdf: number;
  humanInteraction: number;
}
```

No row-level data needs to be added for this first pass.

## UI Behavior

Inside the existing AP / Invoices header:
- render nothing when both counts are zero
- otherwise render a subtle badge like:
  - `Needs Eyes 2 PDF 1 HUMAN`

The badge should stay visually quieter than `PENDING` so it reads as a heads-up, not a new active workflow section.

## Guardrails

- No new dashboard panel
- No new list block in the AP panel
- No raw internal strings like `missing_pdf_manual_review`
- No Gmail-level actions from this panel
- No attempt to solve AP responses here; this is visibility only

## Testing

Cover the API aggregation and the panel rendering:
- API returns zeroed `needsEyes` counts when no matching activity rows exist
- API counts both AP manual-review reason codes correctly
- panel hides the chip when total is zero
- panel renders the compact header badge when counts are present

## Why This Is The Cleanest Fit

This approach keeps the dashboard readable, surfaces only the work that actually needs Bill’s attention, and reuses the AP / Invoices surface that already carries the accounting workflow context.
