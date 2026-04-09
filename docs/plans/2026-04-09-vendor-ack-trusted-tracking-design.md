## Design: Tasks 4/5 Vendor Acknowledgment + Trusted Tracking

### Approach
Approach 1: Integrated derivePOLifecycleState() helper that mines emails and scans PDFs to comprehensively populate purchase_orders.lifecycle_state and evidence columns.

### Architecture
Build a centralized helper that mines emails for vendor acknowledgments and scans PDFs for tracking data, deriving comprehensive lifecycle state and evidence JSON. Integrate into purchasing-dev pipeline to update purchase_orders on PO changes.

### Components
- Email miner: Query Gmail for PO threads, regex scan responses for acknowledgment phrases (received, thank you, I have your order).
- PDF scanner: Re-extract tracking numbers from invoice PDFs, validate "trusted" criteria (carrier validation, format consistency).
- State deriver: Finite state logic: sent → vendor_acknowledged (on email match) → moving_with_tracking (on reliable tracking) → ap_follow_up (on invoice scanned but no tracking).

- Lifecycle columns updated: lifecycle_state TEXT, evidence JSONB

### Data Flow
1. PO created → set "sent" with sent timestamp evidence.
2. Email poll every hour → check thread for new vendor responses.
3. Invoice scanned → extract tracking numbers.
4. derivePOLifecycleState(poId) computes state, updates DB.

### Error Handling
- Email unavailable: Mark as "unauthorized" in evidence, assume no ack.
- PDF parsing fails: Log, continue with "tracking_unavailable".
- DB update fails: Retry, alarm on repeated failure.

### Testing
- Mock email threads with ack phrases, assert state changes.
- Mock PDF extraction with tracking numbers, validate evidence.
- Integration tests for full pipeline updates.

### Success Criteria
- Accurate state progression: sent → vendor_acknowledged → moving_with_tracking.
- 90% detection accuracy for acks and trusted tracking.
- Alarm on unacked POs after 24h.
- Populate lifecycle columns from migration 20260409.

### Implementation Notes
- Build on ops-manager cron jobs and PDF extraction pipelines.
- Use existing email mining patterns from po-correlator.
- Evidence JSON stores timestamps, source emails/PDFs.

Approved: 2026-04-09