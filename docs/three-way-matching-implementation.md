# Three-Way Matching: AP Invoice × PO × Receiving
## Complete Implementation Guide

**System:** Aria (`aria-bot`)  
**Enhancement to:** AP Invoice Pipeline SOP  
**Owner:** Will @ BuildASoil  
**Status:** Ready for Staging  
**Scope:** Phases 1–4 (4–6 days, ~300 LOC net)  
**Dependencies:** Finale receiving API access, Supabase schema additions

---

## Overview

The current AP pipeline matches **Invoice ↔ PO** with surgical precision. This enhancement adds a critical third dimension: **Receiving Data from Finale**.

### The Gap

**Current state:**
- Invoice: "10 bags @ $50 = $500" ✓
- PO: "10 bags @ $50 = $500" ✓
- **Approved.** Payment processed.
- **Reality:** Warehouse only received 8 bags.
- **Result:** $100 cash leakage + duplicate-payment risk.

**With three-way matching:**
- Receiving data: 8 bags logged in Finale
- Short shipment detected before approval
- Will gets: "Invoice qty 10, Received qty 8 — hold for credit memo"
- Decision is informed. Cash is protected.

---

## Architecture: The Three Signals

```
Step 1: Invoice Parsing (existing)
        ↓
        Invoice Data {invoiceNumber, vendorName, lineItems[qty, price], total}
        
Step 2: PO Matching (existing)
        ↓
        PO Data {orderId, lineItems[qty, price], status}
        
Step 3: Receiving Lookup (NEW)
        ↓
        Receiving Status {receivedLines[sku, poQty, receivedQty, lastReceivedDate]}
        
Step 4: Three-Signal Reconciliation (MODIFIED)
        ├─ Price Check (existing guardrails)
        ├─ Quantity Check (existing: invoice qty vs PO qty)
        └─ Receiving Check (NEW: invoice qty vs actual received qty)
        ↓
        Verdict: auto_approve | needs_approval | short_shipment_hold | rejected
```

---

## Phase 1: Data Structures & Types

### New TypeScript Interfaces

**File:** `src/lib/finale/types.ts` (add to existing file)

```typescript
/**
 * Represents a single received line item from Finale's receiving log.
 * This is per PO line, aggregated across all receipt events.
 */
export interface ReceivedLineItem {
  /** Finale's internal line item ID (e.g., "order_item_12345") */
  poLineId: string;

  /** SKU / part number from the PO line */
  sku: string;

  /** Original quantity ordered on this PO line */
  poQty: number;

  /** Total quantity marked as received in Finale */
  receivedQty: number;

  /** Remaining qty not yet received (poQty - receivedQty) */
  remainingQty: number;

  /** Last date this line item was received (from receipt event log) */
  lastReceivedDate: Date | null;

  /** Unit of measure from the PO (EA, LB, BAG, PALLET, etc.) */
  unit: string;

  /** Description of the line item */
  description: string;
}

/**
 * Aggregate receiving status for an entire PO.
 * Tells us: "How much of this order has physically arrived?"
 */
export interface ReceivingStatus {
  /** PO number reference */
  finalePONumber: string;

  /** Total qty ordered across all lines */
  totalOrdered: number;

  /** Total qty received across all lines */
  totalReceived: number;

  /** Date of most recent receipt event on this PO */
  lastReceiptDate: Date | null;

  /** Is any line over-received? (received > ordered) */
  overReceived: boolean;

  /** Is every line fully received? (all lines: received === ordered) */
  fullyReceived: boolean;

  /** Are some (but not all) lines received? */
  partiallyReceived: boolean;

  /** Zero items received on this PO yet */
  nothingReceived: boolean;

  /** Line-by-line receiving breakdown */
  receivedLines: ReceivedLineItem[];

  /** Variance summary for logging */
  varianceSummary: {
    overReceivedLines: string[]; // ["SKU1", "SKU2"]
    underReceivedLines: string[];
    fullyReceivedLines: string[];
  };
}

/**
 * Result of matching a single invoice line to its corresponding PO line,
 * with receiving data factored in.
 */
export interface LineMatchResult {
  /** Finale's PO line ID (null if unmapped) */
  poLineId: string | null;

  /** Index of this line within the invoice's lineItems array */
  invoiceLineIdx: number;

  /** Receiving verdict for this specific line */
  receivingVerdict:
    | 'invoice_qty_ok'      // Invoice qty <= Received qty
    | 'short_shipment'      // Invoice qty > Received qty
    | 'no_receipt_record'   // Finale has no receiving log for this line
    | 'unmapped';           // No PO line matched

  /** Pricing verdict (from existing logic) */
  pricingVerdict:
    | 'no_change'
    | 'auto_approve'
    | 'needs_approval'
    | 'rejected';

  /** If short_shipment: qty gap (invoice qty - received qty) */
  receivingGap?: number;

  /** Collected warnings for this line (vendor mismatches, parsing issues, etc.) */
  warnings: string[];
}

/**
 * Fully formed reconciliation plan, now with receiving awareness.
 * This is what gets stored in `ap_activity_log` metadata.
 */
export interface ReconciliationResult {
  /** Parsed invoice number */
  invoiceNumber: string;

  /** Matched PO number */
  poNumber: string;

  /** Source of the PO match (e.g., "PO# on invoice", "Finale vendor+date match") */
  matchSource: string;

  /** The final verdict for this entire reconciliation */
  verdict:
    | 'auto_approve'          // All signals green, <$500 impact
    | 'needs_approval'        // Price change >3%, impact >$500, etc.
    | 'short_shipment_hold'   // (NEW) One or more lines short-shipped
    | 'no_change'             // Invoice matches PO exactly
    | 'rejected'              // Magnitude error (≥10×)
    | 'duplicate'             // Already reconciled
    | 'no_match';             // No PO found (informational)

  /** Per-line reconciliation results */
  lineResults: LineMatchResult[];

  /** Fee reconciliation verdict (freight, tax, tariff, labor) */
  feeVerdict:
    | 'no_change'
    | 'auto_approve'
    | 'needs_approval'
    | 'rejected';

  /** Complete receiving status for this PO */
  receivingStatus: ReceivingStatus;

  /** All collected warnings across all lines */
  allWarnings: string[];

  /** Human-readable reason for hold (if verdict is not auto_approve) */
  holdReason: string;

  /** Changes that were auto-approved and applied */
  appliedChanges: Array<{
    type: 'price_update' | 'fee_update' | 'tracking_update' | 'qty_adjustment';
    description: string;
    amount?: number;
  }>;

  /** Changes that were rejected or awaiting approval */
  rejectedChanges: Array<{
    type: 'price_change' | 'fee_change' | 'short_shipment' | 'magnitude_error';
    description: string;
    reason: string;
    amount?: number;
  }>;

  /** When this reconciliation result was generated */
  generatedAt: Date;

  /** Receiving status at time of reconciliation (snapshot) */
  receivingStatusSnapshot: ReceivingStatus;
}
```

---

### Updated Activity Log Schema

**File:** `supabase/migrations/001_add_receiving_to_ap_log.sql`

```sql
-- Add receiving status tracking to ap_activity_log
ALTER TABLE ap_activity_log
ADD COLUMN receiving_status JSONB,
ADD COLUMN short_shipment_detected BOOLEAN DEFAULT FALSE,
ADD COLUMN short_shipment_lines TEXT[], -- SKU list of short-shipped lines
ADD COLUMN receiving_gap_total NUMERIC DEFAULT 0; -- Total units short across all lines

-- Index for quick lookup of short shipments
CREATE INDEX idx_ap_activity_log_short_shipment
  ON ap_activity_log(SHORT_shipment_detected, created_at DESC)
  WHERE short_shipment_detected = TRUE;

-- Index for vendor + short shipment analysis
CREATE INDEX idx_ap_activity_log_vendor_short_shipment
  ON ap_activity_log(metadata->>'vendorName', short_shipment_detected, created_at DESC);
```

---

## Phase 2: Finale Integration — Receiving Data

### FinaleClient: Add Receiving Fetch

**File:** `src/lib/finale/client.ts` (add new method to FinaleClient class)

```typescript
/**
 * Fetch receiving status for a PO from Finale.
 * Queries the receiving log, aggregates by line item.
 *
 * @param finalePONumber - The Finale order ID (e.g., "PO-12345" or "12345")
 * @returns ReceivingStatus with line-by-line breakdown
 * @throws Error if PO not found or API fails
 */
async getReceivingStatusForPO(
  finalePONumber: string
): Promise<ReceivingStatus> {
  try {
    const logger = this.logger.child({ method: 'getReceivingStatusForPO' });
    logger.info(`Fetching receiving status for PO: ${finalePONumber}`);

    // Step 1: Fetch the full PO from Finale (to get line items)
    const po = await this.getPurchaseOrder(finalePONumber);

    if (!po) {
      throw new Error(`PO not found: ${finalePONumber}`);
    }

    // Step 2: Fetch the receiving log for this PO
    // Finale's receiving endpoint typically: GET /api/receiving?orderId=<id>
    // Returns an array of receipt events: {lineId, qty, date, comment, etc.}
    const receivingLogUrl = `${this.baseUrl}/api/receiving?orderId=${po.id}`;
    const receivingResponse = await fetch(receivingLogUrl, {
      headers: this.getAuthHeaders(),
    });

    if (!receivingResponse.ok) {
      logger.warn(
        `Receiving API returned ${receivingResponse.status} for PO ${finalePONumber}; treating as no receipts`
      );
      // Graceful degradation: PO exists but no receipts yet
      const emptyReceiving = this.buildReceivingStatus(po, []);
      return emptyReceiving;
    }

    const receivingEvents = await receivingResponse.json();

    // Step 3: Aggregate receiving qty by PO line item
    // receivingEvents is typically: [{lineId, qty, date, ...}, ...]
    // We need to sum qty per lineId
    const receivedByLine: Record<string, number> = {};
    const lastReceiptByLine: Record<string, Date> = {};

    for (const event of receivingEvents) {
      const lineId = event.lineId || event.poLineId;
      if (!lineId) continue;

      receivedByLine[lineId] = (receivedByLine[lineId] || 0) + (event.qty || 0);

      const eventDate = new Date(event.date || event.receivedDate);
      if (
        !lastReceiptByLine[lineId] ||
        eventDate > lastReceiptByLine[lineId]
      ) {
        lastReceiptByLine[lineId] = eventDate;
      }
    }

    logger.info(
      `Aggregated receiving: ${Object.keys(receivedByLine).length} lines received`
    );

    // Step 4: Build ReceivingStatus object
    const receivingStatus = this.buildReceivingStatus(
      po,
      receivingEvents,
      receivedByLine,
      lastReceiptByLine
    );

    return receivingStatus;
  } catch (error) {
    const logger = this.logger.child({ method: 'getReceivingStatusForPO' });
    logger.error(
      `Failed to fetch receiving status for PO ${finalePONumber}`,
      error
    );
    throw error;
  }
}

/**
 * Helper: Construct ReceivingStatus from PO + receiving logs.
 * Calculates totals, variance summary, flags over/under-received.
 *
 * @private
 */
private buildReceivingStatus(
  po: PurchaseOrderDetail,
  receivingEvents: Array<any>,
  receivedByLine: Record<string, number>,
  lastReceiptByLine: Record<string, Date>
): ReceivingStatus {
  const receivedLines: ReceivedLineItem[] = [];
  let totalOrdered = 0;
  let totalReceived = 0;
  let lastReceiptDate: Date | null = null;

  const overReceivedLines: string[] = [];
  const underReceivedLines: string[] = [];
  const fullyReceivedLines: string[] = [];

  // For each line on the PO
  for (const poLine of po.lineItems) {
    const poQty = poLine.quantity || 0;
    const receivedQty = receivedByLine[poLine.id] || 0;
    const remainingQty = poQty - receivedQty;
    const lineLastReceiptDate = lastReceiptByLine[poLine.id] || null;

    totalOrdered += poQty;
    totalReceived += receivedQty;

    // Update overall last receipt date
    if (lineLastReceiptDate && (!lastReceiptDate || lineLastReceiptDate > lastReceiptDate)) {
      lastReceiptDate = lineLastReceiptDate;
    }

    // Build line item record
    const receivedLine: ReceivedLineItem = {
      poLineId: poLine.id,
      sku: poLine.sku || 'UNKNOWN',
      poQty,
      receivedQty,
      remainingQty,
      lastReceivedDate: lineLastReceiptDate,
      unit: poLine.unit || 'EA',
      description: poLine.description || '',
    };

    receivedLines.push(receivedLine);

    // Categorize for variance summary
    if (receivedQty > poQty) {
      overReceivedLines.push(poLine.sku || `line_${poLine.id}`);
    } else if (receivedQty < poQty && receivedQty > 0) {
      underReceivedLines.push(poLine.sku || `line_${poLine.id}`);
    } else if (receivedQty === poQty && poQty > 0) {
      fullyReceivedLines.push(poLine.sku || `line_${poLine.id}`);
    }
  }

  const overReceived = overReceivedLines.length > 0;
  const fullyReceived = totalOrdered > 0 && totalReceived === totalOrdered;
  const partiallyReceived = totalReceived > 0 && totalReceived < totalOrdered;
  const nothingReceived = totalReceived === 0 && totalOrdered > 0;

  return {
    finalePONumber: po.orderId,
    totalOrdered,
    totalReceived,
    lastReceiptDate,
    overReceived,
    fullyReceived,
    partiallyReceived,
    nothingReceived,
    receivedLines,
    varianceSummary: {
      overReceivedLines,
      underReceivedLines,
      fullyReceivedLines,
    },
  };
}

/**
 * Helper: Determine if any line on a PO is eligible for receiving-based hold.
 * Returns lines where invoice qty > received qty.
 *
 * @private
 */
private identifyShortShipmentLines(
  receivingStatus: ReceivingStatus
): ReceivedLineItem[] {
  // Lines where remainingQty > 0 (not fully received yet)
  return receivingStatus.receivedLines.filter((line) => line.remainingQty > 0);
}
```

---

## Phase 3: Reconciliation with Receiving Awareness

### Core Reconciliation Logic

**File:** `src/lib/finale/reconciler.ts` (modify existing file)

#### Part A: Line-by-Line Reconciliation

```typescript
/**
 * Reconcile a single invoice line against its matched PO line,
 * factoring in receiving data.
 *
 * Returns verdict on whether quantities align with what was actually received.
 *
 * @param invoiceLine - The line from the parsed invoice
 * @param poLine - The matched line from the PO
 * @param receivedLine - Receiving data for this PO line (null if no receipt yet)
 * @returns LineMatchResult with receiving verdict + warnings
 */
function reconcileLineWithReceiving(
  invoiceLine: InvoiceLineItem,
  poLine: PurchaseOrderLineItem,
  receivedLine: ReceivedLineItem | null
): LineMatchResult {
  const warnings: string[] = [];
  let receivingVerdict: LineMatchResult['receivingVerdict'] = 'invoice_qty_ok';
  let receivingGap: number | undefined;

  const invoiceQty = invoiceLine.qty || 0;
  const poQty = poLine.quantity || 0;
  const receivedQty = receivedLine?.receivedQty || 0;

  // Guard: No receipt record for this line yet
  if (!receivedLine) {
    receivingVerdict = 'no_receipt_record';
    warnings.push(
      `No receiving record in Finale for PO line ${poLine.sku} (qty ordered: ${poQty})`
    );
    // Continue to price check; don't fail out
  }

  // Guard: Invoice qty > Received qty (short shipment)
  if (invoiceQty > receivedQty) {
    receivingVerdict = 'short_shipment';
    receivingGap = invoiceQty - receivedQty;

    warnings.push(
      `SHORT SHIPMENT: Invoice qty ${invoiceQty} > Received qty ${receivedQty}. Gap: ${receivingGap} ${
        poLine.unit || 'units'
      }.`
    );

    // Also check if we're billing for more than was *ordered*
    if (invoiceQty > poQty) {
      warnings.push(
        `Also exceeds PO qty: Invoice ${invoiceQty} > PO ${poQty} (overbill by ${
          invoiceQty - poQty
        })`
      );
    }
  }

  // Guard: Over-received scenario (received > ordered, invoice < received)
  // This is rare but can happen if vendor pre-shipped extra units
  if (receivedQty > poQty && invoiceQty < receivedQty) {
    warnings.push(
      `Over-received on PO: Received ${receivedQty} > PO qty ${poQty}. Invoice qty ${invoiceQty} is less than received.`
    );
  }

  // Evaluate price change (existing logic)
  const pricingVerdict = evaluatePriceChange(
    invoiceLine.unitPrice,
    poLine.unitPrice,
    poLine.id
  );

  return {
    poLineId: poLine.id,
    invoiceLineIdx: 0, // Will be set by caller
    receivingVerdict,
    pricingVerdict,
    receivingGap,
    warnings,
  };
}

/**
 * Reconcile all invoice lines against their matched PO lines,
 * incorporating receiving status.
 *
 * @param invoiceData - Parsed invoice
 * @param poData - Matched PO from Finale
 * @param receivingStatus - Receiving status for this PO
 * @returns Array of per-line reconciliation results
 */
function reconcileLineItemsWithReceiving(
  invoiceData: InvoiceData,
  poData: PurchaseOrderDetail,
  receivingStatus: ReceivingStatus
): LineMatchResult[] {
  const results: LineMatchResult[] = [];

  for (let invIdx = 0; invIdx < invoiceData.lineItems.length; invIdx++) {
    const invLine = invoiceData.lineItems[invIdx];

    // Step 1: Match invoice line to PO line (SKU, description)
    const poLine = matchLineItemBySKUorDescription(invLine, poData.lineItems);

    if (!poLine) {
      // No PO line matched
      results.push({
        poLineId: null,
        invoiceLineIdx: invIdx,
        receivingVerdict: 'unmapped',
        pricingVerdict: 'no_change',
        warnings: [
          `No PO line matched for invoice line: "${invLine.description}"`,
        ],
      });
      continue;
    }

    // Step 2: Get receiving data for this PO line
    const receivedLine = receivingStatus.receivedLines.find(
      (r) => r.poLineId === poLine.id
    );

    // Step 3: Reconcile with receiving awareness
    const lineResult = reconcileLineWithReceiving(invLine, poLine, receivedLine);
    lineResult.invoiceLineIdx = invIdx;

    results.push(lineResult);
  }

  return results;
}
```

#### Part B: Overall Verdict Logic

```typescript
/**
 * Build the complete reconciliation plan, incorporating receiving data.
 * This is the primary orchestration function.
 *
 * @param invoiceData - Parsed invoice from Step 4 of AP pipeline
 * @param poData - Matched PO from Finale
 * @param finaleClient - FinaleClient instance for API calls
 * @returns ReconciliationResult with complete verdict, plan, and change list
 */
async function buildReconciliationPlanWithReceiving(
  invoiceData: InvoiceData,
  poData: PurchaseOrderDetail,
  finaleClient: FinaleClient
): Promise<ReconciliationResult> {
  const logger = getLogger('reconciler', {
    invoiceNumber: invoiceData.invoiceNumber,
    poNumber: poData.orderId,
  });

  logger.info('Building reconciliation plan with receiving awareness');

  // Step 1: Fetch receiving status from Finale
  let receivingStatus: ReceivingStatus;
  try {
    receivingStatus = await finaleClient.getReceivingStatusForPO(
      poData.orderId
    );
    logger.info(`Receiving status fetched: ${receivingStatus.totalReceived}/${receivingStatus.totalOrdered} units`);
  } catch (error) {
    logger.error('Failed to fetch receiving status; proceeding without it', error);
    // Graceful degradation: build empty receiving status
    receivingStatus = {
      finalePONumber: poData.orderId,
      totalOrdered: 0,
      totalReceived: 0,
      lastReceiptDate: null,
      overReceived: false,
      fullyReceived: false,
      partiallyReceived: false,
      nothingReceived: true,
      receivedLines: [],
      varianceSummary: {
        overReceivedLines: [],
        underReceivedLines: [],
        fullyReceivedLines: [],
      },
    };
  }

  // Step 2: Reconcile line items with receiving
  const lineResults = reconcileLineItemsWithReceiving(
    invoiceData,
    poData,
    receivingStatus
  );

  logger.info(`Line reconciliation complete: ${lineResults.length} lines evaluated`);

  // Step 3: Evaluate fees
  const feeVerdict = evaluateFeesWithContext(invoiceData, poData);
  logger.info(`Fee evaluation: ${feeVerdict}`);

  // Step 4: Aggregate warnings
  const allWarnings = lineResults.flatMap((r) => r.warnings);

  // Step 5: Determine overall verdict
  let overallVerdict: ReconciliationResult['verdict'] = 'auto_approve';
  let holdReason = '';
  const appliedChanges: ReconciliationResult['appliedChanges'] = [];
  const rejectedChanges: ReconciliationResult['rejectedChanges'] = [];

  // Guard 0: Short shipment detected?
  const shortShipmentLines = lineResults.filter(
    (r) => r.receivingVerdict === 'short_shipment'
  );
  if (shortShipmentLines.length > 0) {
    overallVerdict = 'short_shipment_hold';
    const totalGap = shortShipmentLines.reduce(
      (sum, r) => sum + (r.receivingGap || 0),
      0
    );
    holdReason = `${shortShipmentLines.length} line(s) with short shipment. Total gap: ${totalGap} units.`;

    logger.warn(`Short shipment detected: ${holdReason}`);

    for (const line of shortShipmentLines) {
      rejectedChanges.push({
        type: 'short_shipment',
        description: `Line ${line.invoiceLineIdx + 1}: Invoiced ${
          invoiceData.lineItems[line.invoiceLineIdx].qty
        } units, received ${
          receivingStatus.receivedLines.find((r) => r.poLineId === line.poLineId)
            ?.receivedQty || 0
        }`,
        reason: `Short shipment: gap of ${line.receivingGap} units`,
        amount: (line.receivingGap || 0) * invoiceData.lineItems[line.invoiceLineIdx].unitPrice,
      });
    }
  }

  // Guard 1: Magnitude error on any line?
  const rejectedPricingLines = lineResults.filter(
    (r) => r.pricingVerdict === 'rejected'
  );
  if (rejectedPricingLines.length > 0 && overallVerdict === 'auto_approve') {
    overallVerdict = 'rejected';
    holdReason = `Magnitude error on ${rejectedPricingLines.length} line(s)`;

    logger.error(`Magnitude error detected: ${holdReason}`);

    for (const line of rejectedPricingLines) {
      rejectedChanges.push({
        type: 'magnitude_error',
        description: `Line ${line.invoiceLineIdx + 1}: Price mismatch`,
        reason: 'Unit price is 10× or 0.1× the PO price',
      });
    }
  }

  // Guard 2: Price approval needed?
  const priceApprovalLines = lineResults.filter(
    (r) =>
      r.pricingVerdict === 'needs_approval' &&
      r.receivingVerdict !== 'short_shipment'
  );
  if (priceApprovalLines.length > 0 && overallVerdict === 'auto_approve') {
    overallVerdict = 'needs_approval';
    holdReason = `${priceApprovalLines.length} line(s) require price approval (>3% variance)`;

    logger.info(`Price approval needed: ${holdReason}`);
  }

  // Guard 3: Fee approval needed?
  if (feeVerdict === 'needs_approval' && overallVerdict === 'auto_approve') {
    overallVerdict = 'needs_approval';
    holdReason = 'Fee changes exceed auto-approve threshold';

    logger.info(`Fee approval needed: ${holdReason}`);
  }

  // Guard 4: Total impact cap
  const totalImpactDollars = calculateTotalPOImpact(
    invoiceData,
    poData,
    lineResults
  );
  if (
    totalImpactDollars > RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS &&
    overallVerdict === 'auto_approve'
  ) {
    overallVerdict = 'needs_approval';
    holdReason = `Total PO impact ($${totalImpactDollars.toFixed(2)}) exceeds cap`;

    logger.info(`Total impact cap exceeded: ${holdReason}`);
  }

  // If auto_approve, build applied changes list
  if (overallVerdict === 'auto_approve') {
    for (const line of lineResults.filter((r) => r.pricingVerdict === 'auto_approve')) {
      appliedChanges.push({
        type: 'price_update',
        description: `Line ${line.invoiceLineIdx + 1}: Price update approved`,
        amount: invoiceData.lineItems[line.invoiceLineIdx].total,
      });
    }

    if (feeVerdict === 'auto_approve') {
      appliedChanges.push({
        type: 'fee_update',
        description: 'Fee adjustments auto-approved',
      });
    }
  }

  // Build final result
  const result: ReconciliationResult = {
    invoiceNumber: invoiceData.invoiceNumber,
    poNumber: poData.orderId,
    matchSource: invoiceData.poNumber ? 'PO# on invoice' : 'Finale vendor+date match',
    verdict: overallVerdict,
    lineResults,
    feeVerdict,
    receivingStatus,
    allWarnings,
    holdReason,
    appliedChanges,
    rejectedChanges,
    generatedAt: new Date(),
    receivingStatusSnapshot: receivingStatus,
  };

  logger.info(`Reconciliation verdict: ${overallVerdict}`);
  return result;
}
```

---

## Phase 4: AP Agent Integration & Notifications

### Reconciliation Entry Point

**File:** `src/lib/intelligence/ap-agent.ts` (modify `reconcileAndUpdate()`)

```typescript
/**
 * Main reconciliation and update flow.
 * Called after invoice is parsed and PO is matched.
 *
 * Routes to auto-apply, approval queue, or rejection based on verdict.
 */
async function reconcileAndUpdate(
  invoiceData: InvoiceData,
  finalePONumber: string,
  finaleClient: FinaleClient,
  telegramClient: TelegramClient
): Promise<void> {
  const logger = getLogger('ap-agent', { invoiceNumber: invoiceData.invoiceNumber });

  // Fetch the full PO from Finale
  const poData = await finaleClient.getPurchaseOrder(finalePONumber);
  if (!poData) {
    logger.error(`PO not found: ${finalePONumber}`);
    await telegramClient.sendAlert({
      message: `❌ PO ${finalePONumber} not found for invoice ${invoiceData.invoiceNumber}`,
    });
    return;
  }

  // Build reconciliation plan WITH receiving awareness
  const result = await buildReconciliationPlanWithReceiving(
    invoiceData,
    poData,
    finaleClient
  );

  // Log to activity log with receiving data
  await logReconciliationActivity(result, invoiceData);

  // Route based on verdict
  switch (result.verdict) {
    case 'auto_approve':
      await handleAutoApprove(result, poData, finaleClient, telegramClient, logger);
      break;

    case 'needs_approval':
      await handleNeedsApproval(result, poData, telegramClient, logger);
      break;

    case 'short_shipment_hold':
      await handleShortShipmentHold(result, poData, invoiceData, telegramClient, logger);
      break;

    case 'rejected':
      await handleRejected(result, poData, telegramClient, logger);
      break;

    case 'duplicate':
      await handleDuplicate(result, telegramClient, logger);
      break;

    case 'no_change':
      await handleNoChange(result, logger);
      break;

    default:
      logger.warn(`Unknown verdict: ${result.verdict}`);
  }
}
```

### Short Shipment Handler (New)

```typescript
/**
 * Handle short shipment scenario.
 * Send detailed alert to Will with decision buttons.
 */
async function handleShortShipmentHold(
  result: ReconciliationResult,
  poData: PurchaseOrderDetail,
  invoiceData: InvoiceData,
  telegramClient: TelegramClient,
  logger: Logger
): Promise<void> {
  logger.warn(`Short shipment hold: ${result.holdReason}`);

  // Build detailed line-by-line summary
  const shortLines = result.lineResults.filter(
    (r) => r.receivingVerdict === 'short_shipment'
  );

  const lineSummary = shortLines
    .map((r) => {
      const invLine = invoiceData.lineItems[r.invoiceLineIdx];
      const recvLine = result.receivingStatus.receivedLines.find(
        (rl) => rl.poLineId === r.poLineId
      );
      return (
        `• **${invLine.description}** (${invLine.sku || 'N/A'})\n` +
        `  Invoiced: ${invLine.qty} ${invLine.unit || 'units'}\n` +
        `  Received: ${recvLine?.receivedQty || 0} ${invLine.unit || 'units'}\n` +
        `  Gap: **${r.receivingGap} units** @ $${invLine.unitPrice.toFixed(2)} = **$${(
          (r.receivingGap || 0) * invLine.unitPrice
        ).toFixed(2)}**`
      );
    })
    .join('\n');

  const totalGap = result.rejectedChanges
    .filter((c) => c.type === 'short_shipment')
    .reduce((sum, c) => sum + (c.amount || 0), 0);

  const message =
    `⚠️ **SHORT SHIPMENT ALERT**\n\n` +
    `**Invoice:** ${invoiceData.invoiceNumber}\n` +
    `**Vendor:** ${invoiceData.vendorName}\n` +
    `**PO:** ${poData.orderId}\n` +
    `**Invoice Total:** $${invoiceData.total.toFixed(2)}\n\n` +
    `**Short-Shipped Lines:**\n${lineSummary}\n\n` +
    `**Total Short Amount:** $${totalGap.toFixed(2)}\n\n` +
    `**Receiving Status:**\n` +
    `Total Ordered: ${result.receivingStatus.totalOrdered} units\n` +
    `Total Received: ${result.receivingStatus.totalReceived} units\n` +
    `Gap: ${result.receivingStatus.totalOrdered - result.receivingStatus.totalReceived} units\n\n` +
    `**What should we do?**`;

  // Store pending approval (will cover in next section)
  const pendingId = await storePendingApproval(result, 'short_shipment_hold');

  // Send Telegram alert with action buttons
  await telegramClient.sendMessage({
    chatId: WILL_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '✅ Approve as-is (received qty)',
            callback_data: `approve_short_${pendingId}`,
          },
        ],
        [
          {
            text: '📞 Hold for credit memo',
            callback_data: `hold_credit_memo_${pendingId}`,
          },
        ],
        [
          {
            text: '❌ Reject invoice',
            callback_data: `reject_invoice_${pendingId}`,
          },
        ],
      ],
    },
  });

  logger.info(`Short shipment alert sent; awaiting Will's decision`);
}
```

### Updated Auto-Approve Handler

```typescript
/**
 * Handle auto-approve verdict.
 * Apply all changes to Finale immediately.
 */
async function handleAutoApprove(
  result: ReconciliationResult,
  poData: PurchaseOrderDetail,
  finaleClient: FinaleClient,
  telegramClient: TelegramClient,
  logger: Logger
): Promise<void> {
  logger.info('Auto-approving reconciliation');

  try {
    // Apply all changes to Finale
    await applyReconciliation(result, poData, finaleClient, logger);

    // Send confirmation to Telegram
    const summary =
      `✅ **Invoice Reconciled Auto-Approved**\n\n` +
      `**Invoice:** ${result.invoiceNumber}\n` +
      `**PO:** ${result.poNumber}\n` +
      `**Total:** $${result.appliedChanges.reduce((sum, c) => sum + (c.amount || 0), 0).toFixed(2)}\n\n` +
      `**Changes Applied:**\n${result.appliedChanges.map((c) => `• ${c.description}`).join('\n')}\n\n` +
      `**Receiving Status:**\n` +
      `Received: ${result.receivingStatus.totalReceived}/${result.receivingStatus.totalOrdered} units`;

    await telegramClient.sendMessage({
      chatId: WILL_CHAT_ID,
      text: summary,
      parse_mode: 'Markdown',
    });

    logger.info('Auto-approval complete and notified');
  } catch (error) {
    logger.error('Failed to apply auto-approved changes', error);
    await telegramClient.sendAlert({
      message: `❌ Failed to apply changes for invoice ${result.invoiceNumber}`,
    });
  }
}
```

### Approval Queue Handler

**File:** `src/lib/intelligence/ap-agent.ts` (modify/add)

```typescript
/**
 * Store pending approval in database (persistent, survives restarts).
 * Returns the pending approval ID for button callbacks.
 */
async function storePendingApproval(
  result: ReconciliationResult,
  verdictType: string
): Promise<string> {
  const pendingId = uuidv4();

  await supabase.from('ap_pending_approvals').insert({
    id: pendingId,
    invoice_number: result.invoiceNumber,
    vendor_name: result.poNumber, // Use PO number as reference
    order_id: result.poNumber,
    reconciliation_result: result,
    status: 'pending',
    verdict_type: verdictType,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  });

  return pendingId;
}

/**
 * Handle approval button callback from Telegram.
 */
async function handleApprovalCallback(
  pendingId: string,
  action: 'approve_short' | 'hold_credit_memo' | 'reject_invoice' | 'approve_price',
  finaleClient: FinaleClient,
  telegramClient: TelegramClient
): Promise<void> {
  const logger = getLogger('ap-agent', { pendingId, action });

  // Fetch pending approval from database
  const { data: pending, error } = await supabase
    .from('ap_pending_approvals')
    .select('*')
    .eq('id', pendingId)
    .single();

  if (error || !pending) {
    logger.error(`Pending approval not found: ${pendingId}`);
    await telegramClient.sendMessage({
      chatId: WILL_CHAT_ID,
      text: '❌ Approval request expired or not found. Please reprocess the invoice.',
    });
    return;
  }

  const result: ReconciliationResult = pending.reconciliation_result;
  const logger_detail = logger.child({ invoiceNumber: result.invoiceNumber });

  try {
    if (action === 'approve_short' || action === 'approve_price') {
      // Approve: Apply changes to Finale
      const poData = await finaleClient.getPurchaseOrder(result.poNumber);
      await applyReconciliation(result, poData, finaleClient, logger_detail);

      // Update database
      await supabase
        .from('ap_pending_approvals')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('id', pendingId);

      await telegramClient.sendMessage({
        chatId: WILL_CHAT_ID,
        text: `✅ Invoice ${result.invoiceNumber} approved and applied to Finale.`,
      });

      logger_detail.info(`Approval processed`);
    } else if (action === 'hold_credit_memo') {
      // Hold: Mark as pending credit memo
      await supabase
        .from('ap_pending_approvals')
        .update({
          status: 'holding_credit_memo',
          updated_at: new Date().toISOString(),
          hold_reason: 'Awaiting credit memo from vendor',
        })
        .eq('id', pendingId);

      await telegramClient.sendMessage({
        chatId: WILL_CHAT_ID,
        text: `📞 Invoice ${result.invoiceNumber} held pending credit memo. You'll be reminded in 7 days if not resolved.`,
      });

      logger_detail.info(`Marked for credit memo follow-up`);
    } else if (action === 'reject_invoice') {
      // Reject: No Finale changes
      await supabase
        .from('ap_pending_approvals')
        .update({
          status: 'rejected',
          updated_at: new Date().toISOString(),
          reject_reason: 'Rejected by Will',
        })
        .eq('id', pendingId);

      await telegramClient.sendMessage({
        chatId: WILL_CHAT_ID,
        text: `❌ Invoice ${result.invoiceNumber} rejected. No changes applied.`,
      });

      logger_detail.info(`Rejected`);
    }
  } catch (error) {
    logger_detail.error(`Failed to process approval action`, error);
    await telegramClient.sendAlert({
      message: `❌ Failed to process approval for invoice ${result.invoiceNumber}`,
    });
  }
}
```

---

## Phase 5: Activity Log & Audit Trail

### Activity Log Entry

**File:** `src/lib/intelligence/ap-agent.ts`

```typescript
/**
 * Log reconciliation result to ap_activity_log with receiving data.
 */
async function logReconciliationActivity(
  result: ReconciliationResult,
  invoiceData: InvoiceData
): Promise<void> {
  const shortShipmentLines = result.lineResults.filter(
    (r) => r.receivingVerdict === 'short_shipment'
  );
  const shortShipmentDetected = shortShipmentLines.length > 0;
  const shortShipmentLineSkus = shortShipmentLines
    .map((r) => invoiceData.lineItems[r.invoiceLineIdx].sku || `line_${r.invoiceLineIdx + 1}`)
    .filter(Boolean);

  const totalGap = result.rejectedChanges
    .filter((c) => c.type === 'short_shipment')
    .reduce((sum, c) => sum + (c.amount || 0), 0);

  const metadata = {
    invoiceNumber: result.invoiceNumber,
    vendorName: invoiceData.vendorName,
    poNumber: result.poNumber,
    matchSource: result.matchSource,
    verdict: result.verdict,
    lineCount: result.lineResults.length,
    shortShipmentCount: shortShipmentLines.length,
    receivingStatus: {
      totalOrdered: result.receivingStatus.totalOrdered,
      totalReceived: result.receivingStatus.totalReceived,
      fullyReceived: result.receivingStatus.fullyReceived,
      partiallyReceived: result.receivingStatus.partiallyReceived,
      nothingReceived: result.receivingStatus.nothingReceived,
    },
    appliedChanges: result.appliedChanges,
    rejectedChanges: result.rejectedChanges,
    warnings: result.allWarnings.slice(0, 5), // First 5 warnings
  };

  await supabase.from('ap_activity_log').insert({
    email_from: '', // Will be filled by caller
    email_subject: '', // Will be filled by caller
    intent: 'RECONCILIATION',
    action_taken: `Reconciliation completed: ${result.verdict}. ${
      shortShipmentDetected
        ? `Short shipment detected on ${shortShipmentLineSkus.length} line(s).`
        : 'No receiving issues.'
    }`,
    notified_slack: false,
    notified_telegram: true,
    metadata,
    receiving_status: result.receivingStatusSnapshot,
    short_shipment_detected: shortShipmentDetected,
    short_shipment_lines: shortShipmentLineSkus,
    receiving_gap_total: totalGap,
  });
}
```

---

## Phase 5: Dashboard Views

### Supabase Analytics Views

**File:** `supabase/migrations/002_add_reconciliation_views.sql`

```sql
-- View: Daily reconciliation summary with receiving awareness
CREATE OR REPLACE VIEW ap_reconciliation_daily_summary AS
SELECT
  DATE(created_at) AS date,
  COUNT(*) AS total_invoices,
  COUNT(CASE WHEN metadata->>'verdict' = 'auto_approve' THEN 1 END) AS auto_approved,
  COUNT(CASE WHEN metadata->>'verdict' = 'needs_approval' THEN 1 END) AS needs_approval,
  COUNT(CASE WHEN metadata->>'verdict' = 'short_shipment_hold' THEN 1 END) AS short_shipment_holds,
  COUNT(CASE WHEN metadata->>'verdict' = 'rejected' THEN 1 END) AS rejected,
  ROUND(SUM(CAST(metadata->>'invoiceTotal' AS NUMERIC)), 2) AS total_amount,
  COUNT(CASE WHEN short_shipment_detected = TRUE THEN 1 END) AS short_shipments_detected,
  ROUND(SUM(receiving_gap_total), 2) AS total_receiving_gaps
FROM ap_activity_log
WHERE intent = 'RECONCILIATION'
GROUP BY DATE(created_at)
ORDER BY DATE DESC;

-- View: Short shipments by vendor
CREATE OR REPLACE VIEW ap_short_shipments_by_vendor AS
SELECT
  metadata->>'vendorName' AS vendor,
  COUNT(*) AS shipment_count,
  COUNT(DISTINCT metadata->>'invoiceNumber') AS affected_invoices,
  ROUND(SUM(receiving_gap_total), 2) AS total_gap_amount,
  MIN(created_at) AS first_occurrence,
  MAX(created_at) AS latest_occurrence
FROM ap_activity_log
WHERE intent = 'RECONCILIATION' AND short_shipment_detected = TRUE
GROUP BY vendor
ORDER BY shipment_count DESC;

-- View: Pending approvals (active)
CREATE OR REPLACE VIEW ap_pending_approvals_active AS
SELECT
  id,
  invoice_number,
  vendor_name,
  order_id,
  verdict_type,
  status,
  AGE(expires_at, created_at) AS ttl_remaining,
  created_at
FROM ap_pending_approvals
WHERE status = 'pending' AND expires_at > NOW()
ORDER BY created_at DESC;

-- View: Receiving variance analysis
CREATE OR REPLACE VIEW ap_receiving_variance_analysis AS
SELECT
  metadata->>'vendorName' AS vendor,
  COUNT(*) AS invoices_processed,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC)),
    0
  ) AS total_units_ordered,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)),
    0
  ) AS total_units_received,
  ROUND(
    SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC))
    - SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)),
    0
  ) AS units_short,
  ROUND(
    (SUM(CAST(metadata->'receivingStatus'->>'totalReceived' AS NUMERIC)) /
      NULLIF(SUM(CAST(metadata->'receivingStatus'->>'totalOrdered' AS NUMERIC)), 0)
    ) * 100,
    2
  ) AS receipt_percentage
FROM ap_activity_log
WHERE intent = 'RECONCILIATION'
GROUP BY vendor
ORDER BY units_short DESC;
```

---

## Configuration Reference (Updated)

**File:** `src/lib/finale/reconciler.ts` → `RECONCILIATION_CONFIG`

```typescript
export const RECONCILIATION_CONFIG = {
  // Existing thresholds
  AUTO_APPROVE_PERCENT: 3, // Max price change % for silent auto-apply
  MAGNITUDE_CEILING: 10, // Reject if 10× or 0.1× PO price
  TOTAL_IMPACT_CAP_DOLLARS: 500, // Escalate if aggregate impact >$500
  HIGH_VALUE_THRESHOLD: 5000, // Always approve high-value items (>$5k unit price)
  FEE_AUTO_APPROVE_CAP_DOLLARS: 250, // Auto-approve fee changes <$250
  VENDOR_FUZZY_THRESHOLD: 0.5, // Jaccard overlap for vendor name

  // NEW: Receiving-aware thresholds
  SHORT_SHIPMENT_AUTO_REJECT: false, // Always hold short shipments for approval
  SHORT_SHIPMENT_THRESHOLD_PERCENT: 5, // Flag if invoice qty > received by >5%
  SHORT_SHIPMENT_THRESHOLD_UNITS: 1, // Flag if gap > 1 unit (AND >5%)
  RECEIVING_DATA_TIMEOUT_SECONDS: 10, // Max wait for Finale API
  RECEIVING_FAILURE_MODE: 'graceful_degrade', // graceful_degrade | block
};
```

---

## Deployment Checklist

- [ ] **Database Migrations**
  - [ ] Run `001_add_receiving_to_ap_log.sql` (add columns + indexes)
  - [ ] Run `002_add_reconciliation_views.sql` (create analytics views)
  - [ ] Verify indexes created: `idx_ap_activity_log_short_shipment`, `idx_ap_activity_log_vendor_short_shipment`

- [ ] **Code Changes**
  - [ ] Add types to `src/lib/finale/types.ts`
  - [ ] Add `getReceivingStatusForPO()` + helper to `FinaleClient`
  - [ ] Add receiving-aware reconciliation to `reconciler.ts`
  - [ ] Update `ap-agent.ts` with new handlers: `handleShortShipmentHold()`, approval callbacks
  - [ ] Add `storePendingApproval()` function
  - [ ] Update `logReconciliationActivity()` to capture receiving data

- [ ] **Testing (Staging)**
  - [ ] Test `getReceivingStatusForPO()` with known POs (10 POs, 3 receiving scenarios: full, partial, none)
  - [ ] Test short shipment detection (invoice qty > received qty)
  - [ ] Test auto-approve path (all signals green)
  - [ ] Test approval queue path (short shipment hold)
  - [ ] Test Telegram callbacks (approve, hold, reject)
  - [ ] Test activity log entries + dashboard views
  - [ ] Verify: `pm2 restart aria-bot` does not orphan pending approvals (DB persistence)

- [ ] **Production Rollout**
  - [ ] Deploy schema migrations
  - [ ] Deploy code
  - [ ] Run smoke test: process 5 invoices, verify receiving data is fetched
  - [ ] Monitor short shipment detection rate (should be low initially)
  - [ ] Verify Telegram alerts reach Will with full detail

- [ ] **Monitoring & Alerting**
  - [ ] Alert if `getReceivingStatusForPO()` API timeout rate > 5%
  - [ ] Alert if short shipment hold rate > 10% (possible data issue)
  - [ ] Dashboard widget: "Pending Approvals" (active, by vendor, by date)
  - [ ] Daily summary: short shipments detected, total gap amount

---

## Summary

**Three-way matching adds a critical third signal: Does the invoice align with what was actually received?**

This catches:
- **Billing for undelivered goods** (short shipments)
- **Over-received items** (rare but discoverable)
- **Receiving log delays** (flagged as "no record yet — proceed with caution")

**Core guardrails:**
1. Short shipment → always `needs_approval`
2. Receiving data fetch failure → graceful degrade, continue without it
3. Pending approvals persist across restarts (DB-backed)
4. Full audit trail in `ap_activity_log` + dashboard views

**Expected operational outcome:**
- Fewer duplicate-payment misses
- Better vendor accountability (you catch missing goods)
- Clearer invoice-to-cash visibility
- Data-driven vendor SLA conversations

---

**Total implementation effort:** ~300 LOC spread across 4–6 days of development.  
**Risk level:** Low (graceful degradation, non-blocking, full audit trail).  
**ROI:** High (catches $100–500+ per month in leakage + duplicate-payment risk).
