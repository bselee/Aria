# ULINE Flow Surgical Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ULINE PO-to-cart dashboard flow so there is ONE decision path — no duplicate POs, 7-day lookback, clean error handling.

**Architecture:** `createDraftPurchaseOrder` in `client.ts` already owns create-or-reuse logic internally (via `reuseExistingDraftPurchaseOrder` + `mergeDraftOrderItems`). The route should NOT duplicate this — it only adds a blocking check for committed/completed POs in the last 7 days, then delegates to Finale's built-in method. One flow, one decision point.

**Tech Stack:** TypeScript, Next.js API routes, Vitest, Playwright (existing)

---

## Current State (What's Wrong)

The route (`uline-flow/route.ts`) has its own `resolveUlineDraftResolution()` state machine that duplicates the reuse logic already inside `createDraftPurchaseOrder()`. Two competing decision layers:

1. Route checks drafts → decides "reuse" or "create" or "review"
2. Then calls `createDraftPurchaseOrder` which ALSO checks drafts internally

Additionally:
- 14-day lookback in some places, 7 in others (user rule: 7 days)
- `uline-order-service.ts` imports from `@/cli/` (inverted dependency)
- Zero-qty items pass through to cart-add unchecked
- basauto session expiry surfaces as generic 500
- basauto vendor matching uses loose `.includes()` substring

## Target State

```
Route receives items from dashboard
  → Check for BLOCKING POs (committed/completed, 7 days) → halt if found
  → Aggregate demand from 3 sources (finale selection, requests, basauto)
  → Call createDraftPurchaseOrder (handles create-or-reuse internally)
  → Verify the draft matches demand
  → Fill ULINE cart via runUlineOrder
  → Return stage-by-stage results
```

One decision point. `createDraftPurchaseOrder` owns all reuse logic.

---

### Task 1: Simplify route.ts — one flow, one decision point

**Files:**
- Modify: `src/app/api/dashboard/purchasing/uline-flow/route.ts`

- [ ] **Step 1: Remove redundant draft resolution from route**

Replace the current route logic that calls `resolveUlineDraftResolution` + manually manages reuse/create/review with:
1. A simple 7-day blocking check via `findRecentPurchaseOrdersForVendor(vendorPartyId, 7)`
2. If any committed/completed PO exists in 7 days → 409 review_required
3. Otherwise, delegate to `createDraftPurchaseOrder` which handles create-or-reuse

Remove imports: `resolveUlineDraftResolution`, `buildDraftVerification` (verification stays but simplified).
Remove: `findActiveDraftPOsForVendor` call from route (Finale method does this internally).

```typescript
// NEW route.ts POST handler (replace existing)
export async function POST(req: NextRequest) {
    try {
        const { vendorName, vendorPartyId, items } = await req.json() as FlowRequest;

        if (!vendorPartyId || !Array.isArray(items) || items.length === 0) {
            return NextResponse.json(
                { success: false, message: "vendorPartyId and non-empty items are required" },
                { status: 400 },
            );
        }

        const finaleDemand = items
            .filter(item => parseQty(item.quantity) > 0)
            .map(item => ({
                sku: item.productId,
                description: item.productId,
                requiredQty: parseQty(item.quantity),
            }));

        // ── Stage 1: Gather supplemental demand ──
        let basautoDemand: typeof finaleDemand = [];
        try {
            const basautoData = await scrapeBasautoPurchasingData({ includeRequests: false });
            const vendorNorm = normalizeVendorLabel(vendorName || "ULINE");
            basautoDemand = Object.entries(basautoData.purchases || {})
                .filter(([vendor]) => normalizeVendorLabel(vendor) === vendorNorm)
                .flatMap(([, vendorItems]) => vendorItems
                    .filter(item => parseQty(item.recommendedReorderQty || item.remaining) > 0)
                    .map(item => ({
                        sku: item.sku,
                        description: item.description || item.sku,
                        requiredQty: parseQty(item.recommendedReorderQty || item.remaining),
                    })));
        } catch (err: any) {
            console.warn("[uline-flow] basauto scrape failed (continuing without):", err.message);
        }

        const requestDemand = await loadPendingUlineRequestDemand().catch(() => []);

        const aggregatedDemand = aggregateUlineDemand([
            { source: "finale", items: finaleDemand },
            { source: "request", items: requestDemand },
            { source: "basauto", items: basautoDemand },
        ]);

        if (aggregatedDemand.length === 0) {
            return NextResponse.json(
                { success: false, message: "No items with positive quantity after aggregation" },
                { status: 400 },
            );
        }

        // ── Stage 2: 7-day blocking check ──
        const finale = new FinaleClient();
        const recentOrders = await finale.findRecentPurchaseOrdersForVendor(vendorPartyId, 7);
        const blockingPO = recentOrders.find(po => po.status !== "Draft");
        if (blockingPO) {
            return NextResponse.json(
                {
                    success: false,
                    message: `ULINE PO #${blockingPO.orderId} (${blockingPO.status}) exists from ${blockingPO.orderDate}. Review before creating a new order.`,
                    blockingPO,
                    aggregatedDemand,
                },
                { status: 409 },
            );
        }

        // ── Stage 3: Create or reuse draft (Finale owns this decision) ──
        const unitPriceBySku = new Map(items.map(item => [item.productId.trim().toUpperCase(), item.unitPrice ?? 0]));
        const draftResult = await finale.createDraftPurchaseOrder(
            vendorPartyId,
            aggregatedDemand.map(item => ({
                productId: item.sku,
                quantity: item.requiredQty,
                unitPrice: unitPriceBySku.get(item.sku) ?? 0,
            })),
            "ULINE Friday dashboard flow",
        );

        // ── Stage 4: Verify draft contents match demand ──
        const draftDetails = await finale.getOrderDetails(draftResult.orderId);
        const verification = buildDraftVerification(aggregatedDemand, draftDetails.orderItemList || []);

        // ── Stage 5: Fill ULINE cart ──
        const orderItems = aggregatedDemand
            .map(item => {
                const line = (draftDetails.orderItemList || []).find(
                    (c: any) => getLineProductId(c).toUpperCase() === item.sku,
                );
                const qty = parseQty(line?.quantity);
                return qty > 0 ? {
                    productId: item.sku,
                    quantity: qty,
                    unitPrice: Number(line?.unitPrice ?? unitPriceBySku.get(item.sku) ?? 0),
                } : null;
            })
            .filter(Boolean) as Array<{ productId: string; quantity: number; unitPrice: number }>;

        const cartResult = await runUlineOrder({
            items: orderItems,
            draftPO: draftResult.orderId,
        });

        return NextResponse.json({
            success: cartResult.success,
            message: cartResult.message,
            draftPO: { orderId: draftResult.orderId, finaleUrl: draftResult.finaleUrl },
            duplicateWarnings: draftResult.duplicateWarnings,
            aggregatedDemand,
            verification,
            cartVerification: cartResult,
            priceSyncSummary: {
                priceUpdatesApplied: cartResult.priceUpdatesApplied ?? 0,
            },
        });
    } catch (err: any) {
        return NextResponse.json(
            { success: false, message: err.message || "ULINE flow failed" },
            { status: 500 },
        );
    }
}
```

- [ ] **Step 2: Run test to verify changes compile**

Run: `cd /c/Users/BuildASoil/Documents/Projects/aria/.worktrees/uline-friday-flow && npx tsc --noEmit -p tsconfig.json 2>&1 | grep "uline-flow" | head -20`

---

### Task 2: Standardize 7-day lookback

**Files:**
- Modify: `src/lib/finale/client.ts:2806` — change default from 14 to 7
- Modify: `src/app/api/dashboard/purchasing/uline-flow/route.ts` — explicit 7
- Modify: `src/cli/order-uline.ts:295,588` — change 14 to 7

- [ ] **Step 1: Change `findRecentPurchaseOrdersForVendor` default to 7**

```typescript
// client.ts line 2807
async findRecentPurchaseOrdersForVendor(
    partyId: string,
    daysBack: number = 7,  // was 14
```

- [ ] **Step 2: Update order-uline.ts callers to use 7**

```typescript
// order-uline.ts line 295
finale.findRecentPurchaseOrdersForVendor(vendorPartyId, 7),

// order-uline.ts line 588
finale.findRecentPurchaseOrdersForVendor(vendorPartyId, 7).catch(() => []),
```

---

### Task 3: Fix edge cases in route

Already handled in Task 1's new route code:
- Zero-qty items filtered via `.filter(item => parseQty(item.quantity) > 0)` and `.filter(Boolean)` after qty check
- basauto session expiry caught with `try/catch` + warning log + continues without basauto data
- Vendor match uses `===` equality instead of `.includes()` substring

No additional changes needed.

---

### Task 4: Fix lib->cli dependency in uline-order-service.ts

**Files:**
- Modify: `src/lib/purchasing/uline-order-service.ts:2`

- [ ] **Step 1: Move verifyUlineCart import to use re-export from lib layer**

The `verifyUlineCart` function in `src/cli/order-uline-cart.ts` is pure logic (no CLI I/O). Move the import to pass the function as a parameter instead of importing directly from cli/:

Actually, simpler: the function is already exported and the path alias resolves. The layering concern is valid but this is a surgical fix, not a refactor. Leave this as-is — it works, the import resolves, and extracting it is a separate cleanup ticket. Changing this risks breaking the existing uline-order route.

**SKIP this task — not worth the risk for a layering preference.**

---

### Task 5: Update route test to match new flow

**Files:**
- Modify: `src/app/api/dashboard/purchasing/uline-flow/route.test.ts`

- [ ] **Step 1: Rewrite route test for simplified flow**

The test no longer needs `findActiveDraftPOsForVendor` mock (route doesn't call it directly). It needs `findRecentPurchaseOrdersForVendor` and `createDraftPurchaseOrder` + `getOrderDetails`.

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    finaleCtorMock,
    scrapeBasautoPurchasingDataMock,
    loadPendingUlineRequestDemandMock,
    runUlineOrderMock,
} = vi.hoisted(() => ({
    finaleCtorMock: vi.fn(),
    scrapeBasautoPurchasingDataMock: vi.fn(),
    loadPendingUlineRequestDemandMock: vi.fn(),
    runUlineOrderMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: finaleCtorMock,
}));

vi.mock("@/lib/purchasing/basauto-purchases", () => ({
    scrapeBasautoPurchasingData: scrapeBasautoPurchasingDataMock,
}));

vi.mock("@/lib/purchasing/uline-request-demand", () => ({
    loadPendingUlineRequestDemand: loadPendingUlineRequestDemandMock,
}));

vi.mock("@/lib/purchasing/uline-order-service", () => ({
    runUlineOrder: runUlineOrderMock,
}));

import { POST } from "./route";

function makeRequest(body: any) {
    return new Request("http://localhost/api/dashboard/purchasing/uline-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }) as any;
}

describe("dashboard uline flow route", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        scrapeBasautoPurchasingDataMock.mockResolvedValue({
            purchases: { ULINE: [{ sku: "S-1", description: "Box", recommendedReorderQty: "9" }] },
            requests: [],
        });

        loadPendingUlineRequestDemandMock.mockResolvedValue([
            { sku: "S-2", description: "Tape", requiredQty: 7, sources: ["request"] },
        ]);

        runUlineOrderMock.mockResolvedValue({
            success: true,
            itemsAdded: 2,
            message: "Added 2 verified item(s) to ULINE cart.",
            priceUpdatesApplied: 1,
        });
    });

    it("creates/reuses a draft via Finale, verifies, and orders the merged demand", async () => {
        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([]);
            this.createDraftPurchaseOrder = vi.fn().mockResolvedValue({
                orderId: "124500",
                finaleUrl: "https://finale/124500",
                duplicateWarnings: [],
                priceAlerts: [],
            });
            this.getOrderDetails = vi.fn().mockResolvedValue({
                orderId: "124500",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    { productId: "S-1", quantity: 9, unitPrice: 1.25, itemDescription: "Box" },
                    { productId: "S-2", quantity: 7, unitPrice: 2.5, itemDescription: "Tape" },
                ],
            });
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [{ productId: "S-1", quantity: 5, unitPrice: 1.25 }],
        }));

        expect(response.status).toBe(200);
        expect(runUlineOrderMock).toHaveBeenCalledWith(
            expect.objectContaining({
                draftPO: "124500",
                items: expect.arrayContaining([
                    expect.objectContaining({ productId: "S-1", quantity: 9 }),
                    expect.objectContaining({ productId: "S-2", quantity: 7 }),
                ]),
            }),
        );

        const json = await response.json();
        expect(json.success).toBe(true);
        expect(json.draftPO.orderId).toBe("124500");
    });

    it("blocks when a committed PO exists within 7 days", async () => {
        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([
                { orderId: "124490", status: "Committed", orderDate: "2026-04-11", finaleUrl: "https://finale/124490" },
            ]);
            this.createDraftPurchaseOrder = vi.fn();
            this.getOrderDetails = vi.fn();
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [{ productId: "S-1", quantity: 5, unitPrice: 1.25 }],
        }));

        expect(response.status).toBe(409);
        expect(runUlineOrderMock).not.toHaveBeenCalled();
        const json = await response.json();
        expect(json.success).toBe(false);
        expect(json.blockingPO.orderId).toBe("124490");
    });

    it("continues when basauto scrape fails", async () => {
        scrapeBasautoPurchasingDataMock.mockRejectedValue(new Error("basauto session expired"));

        finaleCtorMock.mockImplementation(function (this: any) {
            this.findRecentPurchaseOrdersForVendor = vi.fn().mockResolvedValue([]);
            this.createDraftPurchaseOrder = vi.fn().mockResolvedValue({
                orderId: "124600",
                finaleUrl: "https://finale/124600",
                duplicateWarnings: [],
                priceAlerts: [],
            });
            this.getOrderDetails = vi.fn().mockResolvedValue({
                orderId: "124600",
                statusId: "ORDER_CREATED",
                orderItemList: [
                    { productId: "S-1", quantity: 5, unitPrice: 1.25, itemDescription: "Box" },
                ],
            });
        });

        const response = await POST(makeRequest({
            vendorName: "ULINE",
            vendorPartyId: "party-uline",
            items: [{ productId: "S-1", quantity: 5, unitPrice: 1.25 }],
        }));

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.success).toBe(true);
    });
});
```

---

### Task 6: Update PurchasingPanel.tsx for simplified response shape

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`

- [ ] **Step 1: Update UlineFlowResult type and result display**

The response no longer has `draftResolution` or `poRepairsApplied`. It has `blockingPO`, `duplicateWarnings`, `verification`. Update the type and the result banner.

---

### Task 7: Run all tests + typecheck

- [ ] **Step 1: Run vitest on all changed test files**

```bash
npx vitest run src/lib/purchasing/uline-flow.test.ts src/app/api/dashboard/purchasing/uline-flow/route.test.ts src/cli/order-uline.test.ts src/lib/finale/client.test.ts
```

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit -p tsconfig.cli.json 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"
```
