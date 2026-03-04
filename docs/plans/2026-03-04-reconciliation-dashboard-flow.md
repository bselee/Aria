# Reconciliation Dashboard Flow — Implementation Plan

> **Status: ✅ COMPLETE** — All 8 tasks implemented and tested (2026-03-04)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make reconciliation entries on the dashboard fully functional — real PO links, visible changes, and approve/reject/dismiss flow identical to Telegram.

**Architecture:** Enrich `ap_activity_log.metadata` with full reconciliation data (using existing `buildAuditMetadata`), update ActivityFeed to render changes and action buttons, add API route for dashboard-based approval/reject/dismiss, and add Supabase columns for review state tracking.

**Tech Stack:** Next.js (App Router), Supabase (Postgres + Realtime), Finale API, Pinecone (memory), React (client components)

**Completion Log:**
| Task | Status | Notes |
|------|--------|-------|
| 1. Supabase Schema | ✅ Applied | Migration run via `pg` client |
| 2. Enrich logReconciliation | ✅ Done | `buildAuditMetadata` wired |
| 3. Env var for Finale URLs | ✅ Done | `NEXT_PUBLIC_FINALE_ACCOUNT_PATH` |
| 4. Reconciliation Action API | ✅ Done | Approve/Pause/Dismiss/Rematch |
| 5. Re-match Candidates API | ✅ Done | Supabase vendor search |
| 6. ActivityFeed Rewrite | ✅ Done | Full component rewrite |
| 7. Learning Feedback | ✅ Done | Pinecone memory writes |
| 8. Final Verification | ✅ Passed | TypeScript clean, browser tested |


## Task 1: Supabase Schema — Add review columns

**Files:**
- Create: `supabase/migrations/20260304_add_reconciliation_review_columns.sql`

**Step 1: Write the migration SQL**

```sql
-- Add review tracking columns to ap_activity_log
-- These track dashboard/Telegram approval state and dismiss reasons
ALTER TABLE ap_activity_log
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_action TEXT,
  ADD COLUMN IF NOT EXISTS dismiss_reason TEXT;

-- Index for querying unreviewed reconciliation entries
CREATE INDEX IF NOT EXISTS idx_ap_activity_log_unreviewed
  ON ap_activity_log (intent, reviewed_at)
  WHERE intent = 'RECONCILIATION' AND reviewed_at IS NULL;
```

**Step 2: Apply migration**

Run in Supabase SQL Editor or via CLI:
```bash
npx supabase db push
```
Expected: Migration applies, three new nullable columns on `ap_activity_log`.

**Step 3: Commit**

```bash
git add supabase/migrations/20260304_add_reconciliation_review_columns.sql
git commit -m "chore(db): add reviewed_at, reviewed_action, dismiss_reason to ap_activity_log"
```

---

## Task 2: Enrich logReconciliation metadata

**Files:**
- Modify: `src/lib/intelligence/ap-agent.ts:846-873` (`logReconciliation` method)

**Problem:** Current `logReconciliation` writes a stripped-down metadata object missing `priceChanges`, `feeChanges`, `trackingUpdate`, and `vendorName`. The Telegram path uses `buildAuditMetadata` which captures everything — but the auto-apply path doesn't.

**Step 1: Update logReconciliation to use buildAuditMetadata**

Replace the metadata object in `logReconciliation()` (lines 860-868) with:

```typescript
private async logReconciliation(
    supabase: any,
    result: ReconciliationResult,
    applyResult: { applied: string[]; skipped: string[]; errors: string[] }
): Promise<void> {
    try {
        await supabase.from("ap_activity_log").insert({
            email_from: result.vendorName,
            email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
            intent: "RECONCILIATION",
            action_taken: result.autoApplicable
                ? `Auto-applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`
                : `Flagged for review: ${result.overallVerdict}`,
            notified_slack: !!this.slack,
            metadata: buildAuditMetadata(result, applyResult, "auto"),
        });
    } catch (err: any) {
        console.warn("⚠️ Failed to log reconciliation:", err.message);
    }
}
```

**Step 2: Ensure buildAuditMetadata is imported**

Check that `buildAuditMetadata` is in the import from `../finale/reconciler`. It should already be exported.

**Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: No errors.

**Step 4: Commit**

```bash
git add src/lib/intelligence/ap-agent.ts
git commit -m "fix(ap-agent): use buildAuditMetadata for full reconciliation detail in activity log"
```

---

## Task 3: Environment variable for Finale URLs

**Files:**
- Modify: `.env.local` — add `NEXT_PUBLIC_FINALE_ACCOUNT_PATH`
- Modify: `.env.example` — add same

**Step 1: Add env var**

```env
# Finale account slug for constructing PO URLs (not a secret — just the account path)
NEXT_PUBLIC_FINALE_ACCOUNT_PATH=buildasoil
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "chore(env): add NEXT_PUBLIC_FINALE_ACCOUNT_PATH for dashboard PO links"
```

---

## Task 4: Reconciliation Action API Route

**Files:**
- Create: `src/app/api/dashboard/reconciliation-action/route.ts`

**Step 1: Write the API route**

```typescript
/**
 * @file    reconciliation-action/route.ts
 * @purpose Dashboard API for approving, rejecting, pausing, and dismissing reconciliations.
 *          Mirrors the Telegram approval flow but runs server-side in Next.js.
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    supabase, finale/reconciler, finale/client, intelligence/memory
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";
import { FinaleClient } from "@/lib/finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    buildAuditMetadata,
    ReconciliationResult,
} from "@/lib/finale/reconciler";

type ActionRequest = {
    action: "approve" | "pause" | "dismiss" | "rematch";
    activityLogId: string;
    dismissReason?: "dropship" | "already_handled" | "duplicate" | "credit_memo" | "statement" | "not_ours";
    rematchPoNumber?: string;
};

export async function POST(req: Request) {
    try {
        const body: ActionRequest = await req.json();
        const { action, activityLogId, dismissReason, rematchPoNumber } = body;

        const supabase = createClient();
        if (!supabase) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        // 1. Fetch the original activity log entry
        const { data: logEntry, error: fetchError } = await supabase
            .from("ap_activity_log")
            .select("*")
            .eq("id", activityLogId)
            .single();

        if (fetchError || !logEntry) {
            return NextResponse.json({ error: "Activity log entry not found" }, { status: 404 });
        }

        if (logEntry.reviewed_at) {
            return NextResponse.json({ error: `Already ${logEntry.reviewed_action}` }, { status: 409 });
        }

        const metadata = logEntry.metadata || {};
        const now = new Date().toISOString();

        // ── APPROVE: Re-derive reconciliation from stored data, apply to Finale ──
        if (action === "approve") {
            const finale = new FinaleClient();

            // Re-run reconciliation to get fresh ReconciliationResult
            // We need the invoice data — reconstruct minimal InvoiceData from metadata
            const reconResult: ReconciliationResult = await reconcileInvoiceToPO(
                {
                    invoiceNumber: metadata.invoiceNumber,
                    vendorName: metadata.vendorName || logEntry.email_from,
                    poNumber: metadata.orderId,
                    total: 0, // not used for apply; reconcileInvoiceToPO re-fetches
                    lineItems: [],
                    fees: [],
                } as any,
                metadata.orderId,
                finale
            );

            if (reconResult.overallVerdict === "duplicate") {
                return NextResponse.json({
                    success: false,
                    message: "This invoice has already been reconciled.",
                });
            }

            // Approve ALL changes — same as Telegram approve
            const approvedPriceItems = reconResult.priceChanges
                .filter(pc => pc.verdict === "needs_approval" || pc.verdict === "auto_approve")
                .map(pc => pc.productId);
            const approvedFeeTypes = reconResult.feeChanges
                .filter(fc => fc.verdict === "needs_approval" || fc.verdict === "auto_approve")
                .map(fc => fc.feeType);

            const applyResult = await applyReconciliation(
                reconResult, finale, approvedPriceItems, approvedFeeTypes
            );

            // Update the log entry with review status
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "approved",
                action_taken: `Dashboard approved: ${applyResult.applied.length} applied, ${applyResult.skipped.length} skipped`,
                metadata: {
                    ...metadata,
                    ...buildAuditMetadata(reconResult, applyResult, "manual"),
                },
            }).eq("id", activityLogId);

            // Write vendor_name to purchase_orders for future matching
            if (reconResult.vendorName && reconResult.orderId) {
                await supabase.from("purchase_orders").upsert({
                    po_number: reconResult.orderId,
                    vendor_name: reconResult.vendorName,
                    status: "open",
                }, { onConflict: "po_number", ignoreDuplicates: false });
            }

            // Pinecone memory — non-blocking
            writeApprovalMemory(reconResult, applyResult, "dashboard");

            return NextResponse.json({
                success: true,
                message: `✅ Applied ${applyResult.applied.length} change(s) to PO ${reconResult.orderId}.`,
                applied: applyResult.applied,
                skipped: applyResult.skipped,
                errors: applyResult.errors,
            });
        }

        // ── PAUSE: Mark for research, no Finale changes ──
        if (action === "pause") {
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "paused",
            }).eq("id", activityLogId);

            return NextResponse.json({
                success: true,
                message: `⏸️ Paused for research. PO ${metadata.orderId} unchanged in Finale.`,
            });
        }

        // ── DISMISS: Mark as dismissed with reason, no Finale changes ──
        if (action === "dismiss") {
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "dismissed",
                dismiss_reason: dismissReason || null,
            }).eq("id", activityLogId);

            // Learn from dismissal — non-blocking
            writeDismissMemory(metadata, dismissReason || "unknown");

            return NextResponse.json({
                success: true,
                message: `⏭️ Dismissed (${dismissReason}). No Finale changes.`,
            });
        }

        // ── REMATCH: Re-run reconciliation against a different PO ──
        if (action === "rematch" && rematchPoNumber) {
            const finale = new FinaleClient();
            const reconResult = await reconcileInvoiceToPO(
                {
                    invoiceNumber: metadata.invoiceNumber,
                    vendorName: metadata.vendorName || logEntry.email_from,
                    poNumber: rematchPoNumber,
                    total: 0,
                    lineItems: [],
                    fees: [],
                } as any,
                rematchPoNumber,
                finale
            );

            if (reconResult.overallVerdict === "no_match") {
                return NextResponse.json({
                    success: false,
                    message: `PO ${rematchPoNumber} not found in Finale.`,
                });
            }

            // Update the log entry with new PO match
            await supabase.from("ap_activity_log").update({
                reviewed_at: now,
                reviewed_action: "re-matched",
                metadata: {
                    ...metadata,
                    rematchedFrom: metadata.orderId,
                    orderId: rematchPoNumber,
                    verdict: reconResult.overallVerdict,
                    totalImpact: reconResult.totalDollarImpact,
                    priceChanges: reconResult.priceChanges.map(pc => ({
                        productId: pc.productId,
                        description: pc.description,
                        from: pc.poPrice,
                        to: pc.invoicePrice,
                        pct: parseFloat((pc.percentChange * 100).toFixed(2)),
                        impact: parseFloat(pc.dollarImpact.toFixed(2)),
                        verdict: pc.verdict,
                    })),
                    feeChanges: reconResult.feeChanges.map(fc => ({
                        type: fc.feeType,
                        description: fc.description,
                        from: fc.existingAmount,
                        to: fc.amount,
                        delta: parseFloat((fc.amount - fc.existingAmount).toFixed(2)),
                        verdict: fc.verdict,
                    })),
                },
            }).eq("id", activityLogId);

            return NextResponse.json({
                success: true,
                message: `🔄 Re-matched to PO ${rematchPoNumber}. Verdict: ${reconResult.overallVerdict}.`,
                verdict: reconResult.overallVerdict,
                summary: reconResult.summary,
            });
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });

    } catch (err: any) {
        console.error("Reconciliation action error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── Memory helpers (non-blocking) ──────────────────────────────────────────

async function writeApprovalMemory(
    result: ReconciliationResult,
    applyResult: { applied: string[]; errors: string[] },
    trigger: string
): Promise<void> {
    try {
        const { remember } = await import("@/lib/intelligence/memory");
        const vendorSlug = result.vendorName.replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
        await remember({
            category: "decision",
            content: `PO ${result.orderId} reconciliation approved via ${trigger}. ${applyResult.applied.length} changes applied. Vendor: ${result.vendorName}. Invoice: ${result.invoiceNumber}. Impact: $${result.totalDollarImpact.toFixed(2)}.`,
            tags: ["reconciliation", "approved", result.orderId, vendorSlug],
            source: "dashboard",
            relatedTo: result.vendorName,
            priority: "normal",
        });
    } catch { /* non-blocking */ }
}

async function writeDismissMemory(
    metadata: any,
    reason: string
): Promise<void> {
    try {
        const { remember } = await import("@/lib/intelligence/memory");
        const vendorSlug = (metadata.vendorName || "").replace(/\s+/g, "_").toLowerCase().replace(/[^a-z0-9_]/g, "");
        await remember({
            category: "process",
            content: `Invoice ${metadata.invoiceNumber} dismissed as "${reason}". Vendor: ${metadata.vendorName}. PO: ${metadata.orderId}. Learning: ${reason === "dropship" ? "Vendor may be dropship-only" : reason === "statement" ? "Email classifier misidentified statement as invoice" : "Manual override"}.`,
            tags: ["reconciliation", "dismissed", reason, vendorSlug],
            source: "dashboard",
            relatedTo: metadata.vendorName,
            priority: reason === "dropship" ? "high" : "normal",
        });
    } catch { /* non-blocking */ }
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/app/api/dashboard/reconciliation-action/route.ts
git commit -m "feat(api): add reconciliation-action endpoint for dashboard approve/pause/dismiss"
```

---

## Task 5: Re-match Candidates API Route

**Files:**
- Create: `src/app/api/dashboard/rematch-candidates/route.ts`

**Step 1: Write the API route**

```typescript
/**
 * @file    rematch-candidates/route.ts
 * @purpose Fetches candidate POs from Finale for a given vendor to support
 *          the re-match flow on the dashboard.
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    finale/client
 */

import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const vendor = searchParams.get("vendor");

        if (!vendor) {
            return NextResponse.json({ error: "vendor parameter required" }, { status: 400 });
        }

        const finale = new FinaleClient();
        const candidates = await finale.searchPurchaseOrdersByVendor(vendor, 90); // last 90 days

        return NextResponse.json({
            candidates: candidates.map((po: any) => ({
                orderId: po.orderId,
                orderDate: po.orderDate,
                total: po.total,
                status: po.status,
                itemCount: po.items?.length || 0,
            })),
        });
    } catch (err: any) {
        console.error("Rematch candidates error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
```

**Step 2: If `searchPurchaseOrdersByVendor` doesn't exist on FinaleClient, add it**

Check `client.ts` for an existing vendor PO search method. If missing, add a minimal one that queries the Finale GraphQL API for recent POs by supplier name.

**Step 3: Commit**

```bash
git add src/app/api/dashboard/rematch-candidates/route.ts
git commit -m "feat(api): add rematch-candidates endpoint for PO re-match suggestions"
```

---

## Task 6: Rewrite ActivityFeed with reconciliation card expansion

**Files:**
- Modify: `src/components/dashboard/ActivityFeed.tsx`

This is the largest change. The ActivityFeed needs:

1. **PO button → real Finale link** (same base64 pattern as ReceivedItemsPanel)
2. **INV button → toggles inline detail expansion**
3. **Reconciliation cards expand** to show price/fee changes from metadata
4. **Action buttons** for approve/pause/dismiss based on card state
5. **Re-match UI** with candidate PO chips + natural language input
6. **Dismiss menu** with structured options
7. **Visual status** reflecting reviewed_at / reviewed_action state

**Step 1: Add `reviewed_at` and `reviewed_action` to the ActivityLog type**

```typescript
type ActivityLog = {
    id: string;
    created_at: string;
    email_from: string;
    email_subject: string;
    intent: string;
    action_taken: string;
    metadata: any;
    reviewed_at: string | null;
    reviewed_action: string | null;
    dismiss_reason: string | null;
};
```

**Step 2: Build the Finale URL helper**

```typescript
function buildFinaleUrl(orderId: string): string {
    const accountPath = process.env.NEXT_PUBLIC_FINALE_ACCOUNT_PATH || "buildasoil";
    const orderApiPath = `/${accountPath}/api/order/${orderId}`;
    const encoded = typeof window !== "undefined"
        ? btoa(orderApiPath)
        : Buffer.from(orderApiPath).toString("base64");
    return `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encoded}`;
}
```

**Step 3: Build ReconciliationCard sub-component**

This renders inside the existing card content for RECONCILIATION intent entries. Shows:
- Price changes table (from `metadata.priceChanges`)
- Fee changes (from `metadata.feeChanges`)
- Tracking info (from `metadata.tracking`)
- Dollar impact total
- Action buttons based on review state

**Step 4: Build DismissMenu sub-component**

Renders the 6 dismiss options as buttons when dismiss flow is active.

**Step 5: Build RematchPanel sub-component**

Fetches candidate POs via `/api/dashboard/rematch-candidates`, renders as tappable chips, includes natural language text input.

**Step 6: Wire up realtime subscription for UPDATE events**

Current subscription only listens for `INSERT`. Add `UPDATE` listener so reviewed state changes propagate in real-time.

**Step 7: Verify with dev server**

```bash
npm run dev
```
Navigate to dashboard, verify reconciliation cards render with expanded data, PO links work, action buttons visible.

**Step 8: Commit**

```bash
git add src/components/dashboard/ActivityFeed.tsx
git commit -m "feat(dashboard): full reconciliation card with PO links, change details, approve/dismiss flow"
```

---

## Task 7: Wire up learning feedback for future autonomy

**Files:**
- Modify: `src/app/api/dashboard/reconciliation-action/route.ts` (already done in Task 4)
- Verify: Pinecone memory writes are working for all action types

**Step 1: Verify memory writes**

After approving/dismissing a test reconciliation from the dashboard, check Pinecone for the memory entry:
- Approval → `"decision"` category with `"approved"` tag
- Dismiss → `"process"` category with dismiss reason tag

**Step 2: Validate vendor profile enrichment**

Check that `vendors.name` in Supabase gets pattern data written. Future task: add `default_dismiss_action` and `auto_approve_threshold` columns to `vendors` table.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat(learning): verify memory writes for reconciliation actions"
```

---

## Task 8: Final verification and cleanup

**Step 1: Full TypeScript check**

```bash
npx tsc --noEmit
```

**Step 2: Dev server smoke test**

1. Navigate to dashboard
2. Verify reconciliation entries show PO links → opens Finale
3. Verify clicking INV shows inline details
4. Verify Approve button → calls API → shows success
5. Verify Pause → shows "PAUSED" badge
6. Verify Dismiss menu → all 6 options work

**Step 3: Commit and push**

```bash
git add -A
git commit -m "feat(dashboard): complete reconciliation approval/dismiss flow with learning"
```
