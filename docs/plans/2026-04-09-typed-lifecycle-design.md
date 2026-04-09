## Design: Task 2 Typed Lifecycle (Deferred)

### Decision
Defer implementation of the central `derivePOLifecycleState()` helper that surfaces typed states (sent/vendor_acknowledged/tracking_unavailable/moving_with_tracking/ap_follow_up) to avoid collision risk with existing `PurchasingCalendarStatus` vocabulary reconciliation from this morning's issues.

### Rationale
C1 chosen to keep progress simple and prevent overlapping stage definitions that would require immediate reconciliation between new PO lifecycle states and calendar statuses. This maintains stability while other purchases features stabilize.

### Next Steps
Implement in Phase X (post-stabilization). The helper should centralize PO lifecycle determinationlogic used across active-purchases.ts, calendar-lifecycle.ts, and ops-manager.ts.

### Acceptance Criteria
- No new code added now
- Current typed states remain untyped/as-is
- Collision risk eliminated by separate phase

Approved: 2026-04-09