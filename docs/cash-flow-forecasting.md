# Cash Flow Forecasting
## Implementation Guide

**System:** Aria (`aria-bot`)  
**Phase:** 3 of AP Agent System Evolution  
**Status:** Ready for Staging  

---

## Overview

Aria currently processes every invoice with payment terms and due dates, but this data isn't surfaced as an actionable timeline for working capital management. The Cash Flow Forecasting module aggregates these dates into a predictive timeline to eliminate surprises and optimize payment timing.

### The Gap

**Current state:**
- Invoices are "Net 30" or "Due on Receipt".
- Due dates aren't easily aggregated alongside receiving/arrival data.
- **Result:** Will has to manually cross-reference Bill.com, inbox, and open POs.

**With Predictive Forecasting:**
- Aria pulls `paymentTerms`, `invoiceDate`, `dueDate` from every invoice log.
- A rolling 30, 60, and 90-day forecast is generated based on when cash actually leaves the building.
- **Result:** Full 90-day working capital predictability.

---

## Architecture

```
Step 1: Metric Extraction
        ↓
        From vendor_invoices + ap_activity_log

Step 2: Horizon Bucketing
        ├─ 0 - 7 Days (Critical)
        ├─ 8 - 14 Days
        ├─ 15 - 21 Days 
        └─ 22+ Days
        
Step 3: High-Risk Identification
        ↓
        Flag any day where >$20k is due simultaneously
        
Step 4: Presentation & UI
        ↓
        CashFlowForecastWidget inside the Aria Dashboard
```

---

## TypeScript Interfaces

**File:** `src/lib/intelligence/cash-flow-forecast.ts`

```typescript
export interface InvoiceDueEvent {
  invoiceNumber: string;
  vendorName: string;
  amount: number;
  invoiceDate: Date;
  dueDate: Date;
  paymentTerms: string;
  daysToPayment: number;
  status: 'pending' | 'paid' | 'disputed';
}

export interface CashFlowForecast {
  generatedAt: Date;
  today: Date;
  buckets: {
    '0_7days': InvoiceDueEvent[];
    '8_14days': InvoiceDueEvent[];
    '15_21days': InvoiceDueEvent[];
    '22_30days': InvoiceDueEvent[];
    '31_60days': InvoiceDueEvent[];
    '61_90days': InvoiceDueEvent[];
  };
  totals: {
    '0_30days': number;
    '0_60days': number;
    '0_90days': number;
  };
  highRiskDays: Array<{
    date: Date;
    dailyTotal: number;
    invoices: InvoiceDueEvent[];
  }>;
}
```

## Rollout Checklist
- [ ] Implement `buildCashFlowForecast` in `cash-flow-forecast.ts`
- [ ] Connect `vendor_invoices` date lookups inside Supabase
- [ ] Build `CashFlowForecastWidget` in `src/components/aria-dashboard`
- [ ] Update Bill.com webhook/polling to mark invoices 'paid' to remove them from future buckets.
