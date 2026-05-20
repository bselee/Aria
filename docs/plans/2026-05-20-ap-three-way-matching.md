# AP Three-Way Reconciliation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement automated 3-way quantity matching (AP Invoice × Finale PO × Warehouse Shipment Receipts) including a "timing-aware bypass" that permits early invoices matching the PO ordered quantity to auto-approve before physical boxes arrive at the warehouse.

**Architecture:** Fetch shipment URL details in parallel in `reconcileInvoiceToPO`, sum physical received quantities by SKU, and enforce strict 3-way matching when physical receiving is active, or bypass quantity blocks when no receiving has occurred yet (`totalReceived === 0`). Flag discrepancies as `short_shipment_hold`.

**Tech Stack:** TypeScript, Supabase, Vitest, Finale API

---

### Task 1: Export shipment helper `getShipmentReceiptItems` from `client.ts`

**Files:**
- Modify: [client.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/client.ts#L478)

**Step 1: Check client.ts**
Inspect the `getShipmentReceiptItems` function definition.

**Step 2: Export `getShipmentReceiptItems`**
Add the `export` keyword before the function definition.
```typescript
export function getShipmentReceiptItems(shipment: any): Array<{ productId: string; quantity: number }> {
```

**Step 3: Commit**
```bash
git add src/lib/finale/client.ts
git commit -m "chore(finale): export getShipmentReceiptItems shipment receipt helper"
```

---

### Task 2: Update `PriceChange` and `ReconciliationVerdict` types in `reconciler.ts`

**Files:**
- Modify: [reconciler.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/reconciler.ts#L906-L924)

**Step 1: Add new verdict and physical shipment metrics to types**
- Add `"short_shipment_hold"` to `ReconciliationVerdict`.
- Add optional `receivedQty` and `receivingGap` to `PriceChange`.

```typescript
export type ReconciliationVerdict =
    | "auto_approve"      // ≤3% change, safe to apply automatically
    | "needs_approval"    // >3% change, send to Telegram for approval
    | "rejected"          // Magnitude error detected, do NOT apply
    | "duplicate"         // Invoice already reconciled — do not re-apply
    | "no_change"         // Prices match, nothing to do
    | "no_match"          // Could not find matching line item
    | "short_shipment_hold"; // (NEW) Short shipment detected — hold for review/credit memo

export interface PriceChange {
    productId: string;
    description: string;
    poPrice: number;
    invoicePrice: number;
    quantity: number;
    percentChange: number;
    dollarImpact: number;       // (invoicePrice - poPrice) × quantity
    verdict: ReconciliationVerdict;
    reason: string;
    receivedQty?: number;       // (NEW) Actual physical quantity received
    receivingGap?: number;      // (NEW) Gap between invoice quantity and received quantity
}
```

**Step 2: Commit**
```bash
git add src/lib/finale/reconciler.ts
git commit -m "feat(ap-reconciler): add short_shipment_hold and received metrics to types"
```

---

### Task 3: Implement physical shipment fetching and aggregation in `reconcileInvoiceToPO`

**Files:**
- Modify: [reconciler.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/reconciler.ts#L1236)

**Step 1: Parallel-fetch shipment details and aggregate quantities**
Directly after fetching `poSummary` at line 1234, retrieve full details for each URL in `poSummary.shipmentUrls` in parallel using `client.getShipmentDetails(url)`.

```typescript
    // Fetch and aggregate shipment receipts to sum physical received quantities by SKU
    const shipmentDetails = await Promise.all(
        (poSummary.shipmentUrls || []).map((url) => client.getShipmentDetails(url).catch(() => null))
    );

    const receivedQtyMap = new Map<string, number>();
    let totalReceived = 0;
    for (const shipment of shipmentDetails) {
        if (!shipment) continue;
        const receiptItems = getShipmentReceiptItems(shipment);
        for (const item of receiptItems) {
            const current = receivedQtyMap.get(item.productId) || 0;
            receivedQtyMap.set(item.productId, current + item.quantity);
            totalReceived += item.quantity;
        }
    }
```

**Step 2: Pass `receivedQtyMap` and `totalReceived` down**
Update the call to `reconcileLineItems(invoice, poSummary)` to pass these two new arguments:
```typescript
    const priceChanges = reconcileLineItems(invoice, poSummary, receivedQtyMap, totalReceived);
```

**Step 3: Commit**
```bash
git add src/lib/finale/reconciler.ts
git commit -m "feat(ap-reconciler): parallel-fetch shipments and aggregate received quantities"
```

---

### Task 4: Update `reconcileLineItems` to implement timing-aware 3-way quantity matching

**Files:**
- Modify: [reconciler.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/reconciler.ts#L1683-L1796)

**Step 1: Update function signature and implement matching logic**
```typescript
function reconcileLineItems(
    invoice: InvoiceData,
    po: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>,
    receivedQtyMap: Map<string, number>,
    totalReceived: number
): PriceChange[] {
```

**Step 2: Incorporate 3-way quantity logic**
In place of the legacy overbill guard, implement the new timing-aware physical quantity check:

```typescript
        const receivedQty = receivedQtyMap.get(poLine.productId) || 0;
        const invoiceQty = invLine.qty;
        const poQty = poLine.quantity;

        // Populate physical receiving metrics on PriceChange
        const changeItem: PriceChange = {
            productId: poLine.productId,
            description: invLine.description,
            poPrice: poLine.unitPrice,
            invoicePrice: invLine.unitPrice,
            quantity: invLine.qty,
            percentChange,
            dollarImpact,
            verdict: pVerdict,
            reason: pReason,
            receivedQty,
            receivingGap: Math.max(0, invoiceQty - receivedQty),
        };

        // 3-Way Quantity Verification
        if (totalReceived === 0) {
            // State A: PO is Unreceived — "invoice RCV on purchase prior to receiving" bypass.
            // Check if invoice line quantity perfectly matches PO ordered quantity.
            if (invoiceQty === poQty) {
                // Perfect ordered quantity match — let price/fee guards stand
                console.log(`     [reconciler] Bypass: clean unreceived match for ${poLine.productId} (qty=${invoiceQty})`);
            } else {
                // Quantity mismatch and no receiving records to back it up
                changeItem.verdict = "needs_approval";
                changeItem.reason += ` | ⚠️ QTY MISMATCH (Unreceived): Invoice qty ${invoiceQty} != PO qty ${poQty} and PO has no receipt records.`;
            }
        } else {
            // State B: PO is Partially/Fully Received — Enforce physical receipt verification.
            if (invoiceQty > receivedQty) {
                // Short shipment or overbill relative to physical receipt — hold for review or credit memo
                changeItem.verdict = "short_shipment_hold";
                changeItem.reason += ` | ⚠️ SHORT SHIPMENT: Invoice qty ${invoiceQty} > Received qty ${receivedQty} (Gap: ${invoiceQty - receivedQty} units).`;
            } else if (invoiceQty > poQty) {
                // Overbill relative to ordered quantity (even if physically received)
                changeItem.verdict = "needs_approval";
                changeItem.reason += ` | ⚠️ OVERBILL: Invoice qty ${invoiceQty} > PO qty ${poQty}.`;
            }
        }

        changes.push(changeItem);
```

**Step 3: Commit**
```bash
git add src/lib/finale/reconciler.ts
git commit -m "feat(ap-reconciler): implement unreceived bypass and physical short-shipment guards"
```

---

### Task 5: Update overall verdict aggregation in `reconcileInvoiceToPO`

**Files:**
- Modify: [reconciler.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/reconciler.ts#L1383-L1404)

**Step 1: Support `"short_shipment_hold"` overall verdict**
```typescript
    // 6. Determine overall verdict — fee verdicts now count alongside price verdicts
    const priceVerdicts = priceChanges.map(pc => pc.verdict);
    const feeVerdicts = feeChanges.map(fc => fc.verdict);
    let overallVerdict: ReconciliationVerdict = "no_change";

    if (priceVerdicts.includes("rejected")) {
        overallVerdict = "rejected";
    } else if (priceVerdicts.includes("short_shipment_hold")) {
        overallVerdict = "short_shipment_hold";
    } else if (priceVerdicts.includes("needs_approval") || feeVerdicts.includes("needs_approval")) {
        overallVerdict = "needs_approval";
    } else if (priceVerdicts.includes("auto_approve") || feeChanges.length > 0 || trackingUpdate) {
        overallVerdict = "auto_approve";
    }
```

**Step 2: Commit**
```bash
git add src/lib/finale/reconciler.ts
git commit -m "feat(ap-reconciler): support short_shipment_hold in overall verdict aggregation"
```

---

### Task 6: Update `enqueueForDashboardReview` to write short-shipment columns to `ap_activity_log`

**Files:**
- Modify: [reconciler.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/reconciler.ts#L2564-L2598)

**Step 1: Write short shipment columns during insert**
Extract short shipment fields directly from `result` inside `enqueueForDashboardReview`:
```typescript
        if (supabase) {
            const shortShipmentDetected = result.overallVerdict === "short_shipment_hold";
            const shortShipmentLines = result.priceChanges
                .filter(pc => pc.verdict === "short_shipment_hold")
                .map(pc => pc.productId);
            const receivingGapTotal = result.priceChanges
                .filter(pc => pc.verdict === "short_shipment_hold")
                .reduce((sum, pc) => sum + (pc.receivingGap || 0), 0);

            const { data } = await supabase.from("ap_activity_log").insert({
                email_from: result.vendorName,
                email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId} — needs review`,
                intent: "RECONCILIATION",
                action_taken: result.summary,
                short_shipment_detected: shortShipmentDetected,
                short_shipment_lines: shortShipmentLines.length > 0 ? shortShipmentLines : null,
                receiving_gap_total: receivingGapTotal,
                metadata: {
                    invoiceNumber: result.invoiceNumber,
                    orderId: result.orderId,
                    vendorName: result.vendorName,
                    overallVerdict: result.overallVerdict,
                    totalDollarImpact: result.totalDollarImpact,
                    priceChanges: result.priceChanges,
                    feeChanges: result.feeChanges,
                    status: "pending",
                    balanceCheck,
                    matchStrategy: result.matchStrategy,
                    notes: result.notes,
                },
                reconciliation_report: result.report,
            }).select("id").maybeSingle();
            activityLogId = data?.id ?? null;
        }
```

**Step 2: Commit**
```bash
git add src/lib/finale/reconciler.ts
git commit -m "feat(ap-reconciler): capture short shipment metrics in ap_activity_log"
```

---

### Task 7: Handle the `"short_shipment_hold"` verdict inside `ap-agent.ts`

**Files:**
- Modify: [ap-agent.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/intelligence/ap-agent.ts#L1928)

**Step 1: Add `"short_shipment_hold"` branch in `reconcileAndUpdate`**
Before the `"needs_approval"` branch (around line 1928), handle the new `"short_shipment_hold"` verdict. It enqueues for dashboard review, records the handoff, blocks the issue in the ledger, and sends a highly informative Telegram alert to Will.

```typescript
            } else if (result.overallVerdict === "short_shipment_hold") {
                // Short shipment detected — hold for manual review / credit memo
                const balanceCheck = validateInvoiceBalance(invoice);
                const dashboardReviewActivityLogId = await enqueueForDashboardReview(result, balanceCheck);
                writeReconciliationMemory("short_shipment_hold");

                // Construct Telegram message detailing the exact quantity mismatch
                const skuDiscrepancies = result.priceChanges
                    .filter(pc => pc.verdict === "short_shipment_hold")
                    .map(pc => {
                        const gap = pc.receivingGap || 0;
                        const costImpact = gap * pc.invoicePrice;
                        return `  • ${pc.productId}: Invoiced ${pc.quantity}, received ${pc.receivedQty || 0}. Gap: ${gap} units ($${costImpact.toFixed(2)} impact).`;
                    })
                    .join("\n");

                await this.bot.telegram.sendMessage(
                    process.env.TELEGRAM_CHAT_ID!,
                    `⚠️ *Short Shipment Detected — Held for Review*\n\n` +
                    `PO: \`${result.orderId}\`\n` +
                    `Vendor: ${result.vendorName}\n` +
                    `Invoice: #${result.invoiceNumber}\n\n` +
                    `Discrepancies:\n${skuDiscrepancies}\n\n` +
                    `Check the AP / Invoices dashboard panel to resolve with credit memo or warehouse.`
                );

                if (issueId) {
                    await apIssue.recordApHandoff(
                        issueId,
                        apIssue.HANDLER.AP_RECONCILER,
                        apIssue.HANDLER.WILL,
                        apIssue.HANDOFF_REASON.NEEDS_APPROVAL_DASHBOARD,
                    );
                    await apIssue.blockApIssue(
                        issueId,
                        "short_shipment_hold",
                        `Short shipment detected ($${result.totalDollarImpact.toFixed(2)} impact)`,
                    );
                }

                writeReconciliationOutcome({
                    runId: crypto.randomUUID(),
                    outcome: "short_shipment_hold" as any,
                    invoiceId: result.invoiceNumber ?? undefined,
                    poId: result.orderId ?? undefined,
                    vendorName: result.vendorName ?? undefined,
                    outcomeMeta: {
                        total_dollar_impact: result.totalDollarImpact,
                        price_change_count: result.priceChanges.length,
                        short_shipment_count: result.priceChanges.filter(pc => pc.verdict === "short_shipment_hold").length,
                        force_approval_was_set: forceApproval,
                        match_strategy: matchStrategy,
                        ...(dashboardReviewActivityLogId ? { source_activity_log_id: dashboardReviewActivityLogId } : {}),
                    },
                }).catch(() => { /* never throws */ });

                return { success: true, verdict: result.overallVerdict };
```

**Step 2: Commit**
```bash
git add src/lib/intelligence/ap-agent.ts
git commit -m "feat(ap-agent): handle short_shipment_hold verdict with custom Telegram and ledger holds"
```

---

### Task 8: Add unit tests to `reconciler.test.ts` covering 3-way matching and unreceived bypass

**Files:**
- Modify: [reconciler.test.ts](file:///c:/Users/BuildASoil/Documents/Projects/aria/src/lib/finale/reconciler.test.ts#L400)

**Step 1: Write three tests representing the scenarios**
Add the new tests within the `reconcileInvoiceToPO guardrails` describe block in `src/lib/finale/reconciler.test.ts`.

```typescript
    it("auto-approves clean unreceived POs when invoice quantity matches ordered quantity (unreceived bypass)", async () => {
        const invoice = makeInvoice({
            vendorName: "Acme Soil",
            poNumber: "PO-002",
            lineItems: [
                { sku: "SKU-1", description: "Organic Compost", qty: 200, unitPrice: 25, total: 5000 },
            ],
            subtotal: 5000,
            total: 5000,
        });

        const client = {
            getOrderSummary: vi.fn().mockResolvedValue({
                orderId: "PO-002",
                supplier: "Acme Soil",
                status: "Open",
                orderDate: "2026-03-10",
                total: 5000,
                adjustments: [],
                items: [
                    { productId: "SKU-1", quantity: 200, unitPrice: 25, description: "Organic Compost" },
                ],
                shipmentUrls: [], // No shipment URLs -> totalReceived = 0
            }),
        } as any;

        const result = await reconcileInvoiceToPO(invoice, "PO-002", client);
        expect(result.overallVerdict).toBe("no_change");
    });

    it("triggers needs_approval for unreceived POs if invoice quantity does not match ordered quantity", async () => {
        const invoice = makeInvoice({
            vendorName: "Acme Soil",
            poNumber: "PO-003",
            lineItems: [
                { sku: "SKU-1", description: "Organic Compost", qty: 220, unitPrice: 25, total: 5500 },
            ],
            subtotal: 5500,
            total: 5500,
        });

        const client = {
            getOrderSummary: vi.fn().mockResolvedValue({
                orderId: "PO-003",
                supplier: "Acme Soil",
                status: "Open",
                orderDate: "2026-03-10",
                total: 5000,
                adjustments: [],
                items: [
                    { productId: "SKU-1", quantity: 200, unitPrice: 25, description: "Organic Compost" },
                ],
                shipmentUrls: [], // No shipment URLs -> totalReceived = 0
            }),
        } as any;

        const result = await reconcileInvoiceToPO(invoice, "PO-003", client);
        expect(result.overallVerdict).toBe("needs_approval");
        expect(result.priceChanges[0].reason).toContain("QTY MISMATCH");
    });

    it("holds invoice as short_shipment_hold when physical receiving is active and invoice quantity > received quantity", async () => {
        const invoice = makeInvoice({
            vendorName: "Acme Soil",
            poNumber: "PO-004",
            lineItems: [
                { sku: "SKU-1", description: "Organic Compost", qty: 200, unitPrice: 25, total: 5000 },
            ],
            subtotal: 5000,
            total: 5000,
        });

        const client = {
            getOrderSummary: vi.fn().mockResolvedValue({
                orderId: "PO-004",
                supplier: "Acme Soil",
                status: "Open",
                orderDate: "2026-03-10",
                total: 5000,
                adjustments: [],
                items: [
                    { productId: "SKU-1", quantity: 200, unitPrice: 25, description: "Organic Compost" },
                ],
                shipmentUrls: ["/buildasoilorganics/api/shipment/123"],
            }),
            getShipmentDetails: vi.fn().mockResolvedValue({
                itemList: [
                    { productId: "SKU-1", quantityReceived: 150 }, // Billed 200, received 150 -> short shipment!
                ],
            }),
        } as any;

        const result = await reconcileInvoiceToPO(invoice, "PO-004", client);
        expect(result.overallVerdict).toBe("short_shipment_hold");
        expect(result.priceChanges[0].verdict).toBe("short_shipment_hold");
        expect(result.priceChanges[0].receivedQty).toBe(150);
        expect(result.priceChanges[0].receivingGap).toBe(50);
    });
```

**Step 2: Commit**
```bash
git add src/lib/finale/reconciler.test.ts
git commit -m "test(ap-reconciler): add tests for unreceived bypass and physical short shipment holds"
```

---

### Task 9: Verify everything compiles and all tests pass

**Files:**
- Test: All tests run successfully.

**Step 1: Run typechecking**
Run: `npm run typecheck:all` or build the app to ensure there are no compilation errors.

**Step 2: Run the reconciler tests**
Run: `npx vitest run src/lib/finale/reconciler.test.ts`
Expected: 44 tests pass cleanly.

**Step 3: Run the ap-agent tests**
Run: `npx vitest run src/lib/intelligence/ap-agent.test.ts`
Expected: 8 tests pass cleanly.
