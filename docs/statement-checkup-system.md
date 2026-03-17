# Month-End Statement Checkups (Inbox Insurance)
## Implementation Guide

**System:** Aria (`aria-bot`)  
**Phase:** 4 of AP Agent System Evolution  
**Status:** Ready for Staging  

---

## Overview

Vendors constantly send recurring "Account Statements" to reconcile their books with yours.
Aria will intelligently classify these statements, perform extraction on the invoice items, and cross-reference them with the master `vendor_invoices` database to look for "missing" or "mismatched" invoices that you might not actually possess.

### The Gap

**Current state:**
- Statements arrive in the email.
- Manual cross-referencing is required against inbox, Bill.com, and POs.
- Takes 20-30m per vendor. Misses happen.
- **Result:** You pay duplicate/ghost invoices or miss legitimate pending balances.

**With Statement Checkups:**
- Email arrives, classified as `STATEMENT`.
- Extracted table mapped against our `ap@` `vendor_invoices`.
- Missed invoices immediately sent to Will via Telegram to investigate/request.
- **Result:** Automated month-end reconciliation, 100% missing-invoice detection in seconds.

---

## Architecture

```
Step 1: Classification & Parsing
        ↓
        Extract Vendor Statement Table (LLM JSON Extraction)

Step 2: Database Look-Up
        ├─ Compare against vendor_invoices WHERE vendor = %match%
        ├─ Match? 
        ├─ Mismatch? (Amount variance)
        └─ Missing? (No record found)
        
Step 3: Checkup Generation
        ↓
        Compile StatementCheckupResult

Step 4: Review Alert (Telegram)
        ↓
        Send ❌ Missing, 🟡 Mismatches, ✅ Verified to Will
```

---

## Interfaces

**File:** `src/lib/intelligence/statement-checkup.ts`

```typescript
export interface ParsedStatement {
  vendorName: string;
  statementDate: Date;
  invoices: Array<{
    invoiceNumber: string;
    amount: number;
    dueDate?: Date;
    status?: string; 
  }>;
}

export interface StatementCheckupResult {
  vendorName: string;
  statementDate: Date;
  verified: Array<{
    invoiceNumber: string;
    vendorAmount: number;
    ourAmount: number;
    status: string;
  }>;
  missing: Array<{
    invoiceNumber: string;
    vendorAmount: number;
    reason: string; 
  }>;
  mismatches: Array<{
    invoiceNumber: string;
    vendorAmount: number;
    ourAmount: number;
    delta: number;
  }>;
  reconciliationScore: number;
}
```

## Rollout Checklist
- [ ] Ensure Statement Classification routes to parsing step
- [ ] Implement `parseAccountStatement` via Claude 3.5 Sonnet table extraction
- [ ] Implement DB mapping `performStatementCheckup` against `vendor_invoices`
- [ ] Add `sendStatementCheckupAlert` to Telegram Client
- [ ] Build `/force-checkup [Vendor]` command to run history.
