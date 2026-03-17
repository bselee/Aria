# Automated Vendor Pushback (Dispute Generation)
## Implementation Guide

**System:** Aria (`aria-bot`)  
**Phase:** 2 of AP Agent System Evolution  
**Status:** Ready for Staging  

---

## Overview

When Aria encounters a discrepancy that exceeds acceptable limits (e.g., magnitude error where billed is 10x PO price), the current flow triggers an alert and requires Will to manually intervene. 
Vendor Pushback automates the resolution of these exceptions by identifying the exact nature of the discrepancy, drafting a polite clarification/dispute email, and queueing it for Will to approve and send.

### The Gap

**Current state:**
- Invoice matches PO but Unit Price is incorrect. 
- Invoice is flagged as "rejected" or "needs_approval".
- Will researches, opens Gmail, drafts an email, waits days for response.
- **Result:** Administrative drag, delayed processing, slower cash visibility.

**With Automated Pushback:**
- Aria intercepts magnitude error, quantity overbill, or fee anomaly.
- Aria drafts a precise email using the extracted invoice details.
- Will clicks "Approve & Send" in Telegram.
- **Result:** Resolution happens in seconds, and relationships stay highly professional.

---

## Architecture

```
Step 1: Reconciliation (Existing & Phase 1)
        ↓
        Verdict: 'rejected' | 'needs_approval' (due to price/qty)
        
Step 2: Discrepancy Categorization
        ├─ Magnitude Error (10x or 0.1x price gap)
        ├─ Quantity Overbill (Invoice Qty > PO Qty)
        └─ Fee Anomaly (Variance > expected threshold)
        
Step 3: Dispute Email Generation
        ↓
        Extract Vendor AP email
        Render matching Handlebars/template string
        
Step 4: Queue & Notification
        ↓
        Save to ap_vendor_disputes table
        Send Telegram approval callback to Will
        
Step 5: Send & Wait
        ↓
        Will approves → Sends via Gmail client
        Moves to 'sent' status, awaits response
```

---

## Database Schema

```sql
CREATE TABLE ap_vendor_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  vendor_email TEXT,
  issue_type TEXT NOT NULL, -- magnitude_error, fee_anomaly, quantity_overbill
  draft_subject TEXT NOT NULL,
  draft_body TEXT NOT NULL,
  status TEXT DEFAULT 'pending_review', -- pending_review, sent, responded, resolved, abandoned
  sent_at TIMESTAMPTZ,
  vendor_response_received_at TIMESTAMPTZ,
  vendor_response_text TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ap_vendor_disputes_vendor_date
  ON ap_vendor_disputes(vendor_name, created_at DESC);

CREATE INDEX idx_ap_vendor_disputes_status
  ON ap_vendor_disputes(status, created_at DESC);
```

## Notification Handlers
Aria will alert via Telegram for Will to read the draft natively inside the chat interface.

```typescript
// Render Telegram action
[[ "👁️ Review Draft" ], 
 [ "✅ Send to Vendor", "❌ Discard" ]]
```

## Rollout Checklist
- [ ] Migrate DB to add `ap_vendor_disputes`
- [ ] Implement `src/lib/intelligence/vendor-disputes.ts` templates
- [ ] Modify `ap-agent` rejection flows to queue templates
- [ ] Implement Telegram handlers `send_dispute_ID`, `discard_dispute_ID`
