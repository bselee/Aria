Summary: Prevent fragmented autonomous purchase orders by adding a vendor-level order cycle guard with an urgent-need escape hatch. Grassroots and TeaLAB history show multiple POs for the same vendor within a month; the system should consolidate into one vendor PO cycle, but it must never suppress a real need created by a sale, surge, or build-critical demand.

Context: The item-level guard now enforces lead time plus 30 days, but vendor cadence is still only optional state. `createDraftPurchaseOrder()` reuses an active vendor draft, but once that PO is committed, later SKUs can trigger a second vendor PO. Grassroots had 14 POs in the last year, including heavy fragmentation in April 2026 and two committed May 2026 POs. TeaLAB had separate April and May POs, including two May 2026 POs 12 days apart. Dropship and canceled POs appear in the same vendor history and must be classified separately from stocking POs.

System Impact: The source of truth for vendor-cycle lock should be Finale PO history plus existing `purchasing_automation_state.cooldown_until` as an optional memory/cache, not local dashboard state. The new invariant is: autonomous purchasing should create or append to at most one routine stocking PO per vendor per 30-day cycle. Canceled POs and dropship POs do not lock the cycle. Existing active drafts should be reused; committed/open POs should normally hold routine replenishment. A proven sale/surge/build-critical exception bypasses the routine cadence lock and either appends to an editable draft or creates an exception PO with evidence attached.

Approach: Add a pure vendor-cycle guard and then wire it into dashboard, Telegram, and direct vendor order paths. Keep item need calculations unchanged; vendor-cycle guard is a final pre-create/pre-order gate for routine replenishment only. Add an explicit exception classification so urgent evidence can override cadence without turning the system back into repeated unexamined POs.

Changes:
- `src/lib/purchasing/vendor-order-cycle.ts` - new pure classifier for recent vendor POs. Returns `clear`, `reuse_draft`, `routine_locked`, or `exception_allowed`, with blocking PO refs, dates, status, ignored dropship/canceled evidence, and exception evidence.
- `src/lib/finale/purchasing.ts` - add a richer vendor PO history method by partyId/vendor name for the last 45-60 days: orderId, status, orderDate, receiveDate, supplier, item SKUs/qtys, and order class.
- `src/lib/purchasing/po-commit-guard.ts` - add routine-vs-exception classification. Exception evidence includes linked sales order demand, sudden demand surge over baseline, build-critical BOM demand, zero/near-zero runway before existing PO ETA, or an explicit human-approved override.
- `src/lib/purchasing/vendor-draft-plans.ts` - replace caller-supplied boolean cooldowns with structured vendor-cycle decisions; `autoDraftEligible` requires `clear`, `reuse_draft`, or `exception_allowed`.
- `src/app/api/dashboard/purchasing/route.ts` - attach vendor cycle state to each group and block routine POST draft creation when the vendor is locked by a committed/open/recent stocking PO. Allow exception POST when the line carries accepted exception evidence.
- `src/cli/aria-tools.ts` - `create_draft_pos` passes vendor-cycle state into draft planning so Telegram cannot queue duplicate vendor POs.
- `src/cli/order-uline.ts` and direct vendor order paths - require vendor-cycle clear before building external carts/orders.
- `src/components/dashboard/PurchasingPanel.tsx` - show vendor-level lock text: “routine cycle locked by PO #... until YYYY-MM-DD”; for exceptions show “surge exception: sale/build demand” with the evidence reason. Keep item-level `Draft only`/`Commit ready` badges.

Verification:
- Unit tests for Grassroots-like history: routine same-month stocking POs should lock after the first committed PO; canceled and dropship POs should not lock.
- Unit tests for TeaLAB-like history: a routine second SKU 12 days after a committed PO is blocked from autonomous PO creation.
- Unit tests for exception evidence: linked sale, demand surge, or build-critical demand bypasses routine vendor-cycle lock.
- Route test: dashboard POST returns 409 for routine locked demand and 200/queued task for exception demand with evidence.
- Telegram/draft-plan test: autoDraftEligible false when vendor cycle locked for routine demand, true when `exception_allowed`.
- Run focused purchasing tests and `npm run build`.
