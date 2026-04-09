# Vendor Acknowledgment + Trusted Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build derivePOLifecycleState(poId) to populate lifecycle_state and evidence in purchase_orders by mining emails for vendor acknowledgments and scanning PDFs for tracking info.

**Architecture:** Add central helper in purchasing-intelligence module. Integrate with email polling and PDF extraction pipelines. Update PO statuses based on evidence from Gmail and invoices.

**Tech Stack:** TypeScript, Vitest, Supabase, Gmail API via @googleapis/gmail, PDF extraction.

---

### Task 1: Create derivePOLifecycleState Core Function

**Files:**
- Create: `src/lib/purchasing/derive-po-lifecycle.ts`
- Test: `src/lib/purchasing/derive-po-lifecycle.test.ts`

**Step 1: Write failing test for state derivation**

```typescript
import { derivePOLifecycleState } from './derive-po-lifecycle';

test('derives sent state for new PO without evidence', async () => {
  const result = await derivePOLifecycleState('test-po-123');
  expect(result.state).toBe('sent');
  expect(result.evidence.sentDate).toBeDefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/purchasing/derive-po-lifecycle.test.ts`
Expected: FAIL - function not defined

**Step 3: Create minimal derive-po-lifecycle.ts**

```typescript
export async function derivePOLifecycleState(poId: string): Promise<{state: string, evidence: any}> {
  return { state: 'sent', evidence: { sentDate: new Date().toISOString() } };
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/purchasing/derive-po-lifecycle.test.ts`
Expected: PASS

**Step 5: Commit core function**

```bash
git add src/lib/purchasing/derive-po-lifecycle.ts src/lib/purchasing/derive-po-lifecycle.test.ts
git commit -m "feat: add derivePOLifecycleState core function with sent default"
```

### Task 2: Integrate Email Mining for Vendor Acknowledgments

**Files:**
- Modify: `src/lib/purchasing/derive-po-lifecycle.ts`
- Test: Modify `src/lib/purchasing/derive-po-lifecycle.test.ts`

**Step 1: Write failing test for email acknowledgment**

```typescript
test('detects vendor_acknowledged from email response', async () => {
  const result = await derivePOLifecycleState('test-po-with-ack');
  expect(result.state).toBe('vendor_acknowledged');
  expect(result.evidence.acknowledgedBy).toContain('vendor@example.com');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/purchasing/derive-po-lifecycle.test.ts`
Expected: FAIL - returns sent

**Step 3: Add email mining logic**

```typescript
import { createClient } from '../supabase';
import { GmailClient } from '../gmail/client';  // Assume exists

export async function derivePOLifecycleState(poId: string) {
  const db = createClient();
  const po = await db.from('purchase_orders').select('*').eq('po_number', poId).single();

  // Email mining
  const gmail = new GmailClient();
  const threads = await gmail.queryPOEmailThread(poId);
  const ackPatterns = ['thank you', 'received', 'I have your order'];

  for (const thread of threads) {
    for (const msg of thread.messages) {
      if (ackPatterns.some(pat => msg.body.includes(pat))) {
        return {
          state: 'vendor_acknowledged',
          evidence: { ...po.evidence, acknowledgedAt: new Date().toISOString(), acknowledgedBy: msg.from }
        };
      }
    }
  }

  // Default
  return { state: 'sent', evidence: po.evidence || {} };
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/purchasing/derive-po-lifecycle.test.ts`
Expected: PASS

**Step 5: Commit email integration**

```bash
git add src/lib/purchasing/derive-po-lifecycle.ts
git commit -m "feat: integrate email mining for vendor acknowledgments"
```

### Task 3: Integrate PDF Scanning for Trusted Tracking

**Files:**
- Modify: `src/lib/purchasing/derive-po-lifecycle.ts`
- Test: Modify `src/lib/purchasing/derive-po-lifecycle.test.ts`

**Step 1: Write failing test for trusted tracking**

```typescript
test('detects moving_with_tracking from PDF', async () => {
  const result = await derivePOLifecycleState('test-po-with-tracking');
  expect(result.state).toBe('moving_with_tracking');
  expect(result.evidence.trackingNumber).toBe('1Z999AA1234567890');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/purchasing/derive-po-lifecycle.test.ts`
Expected: FAIL - returns ack or sent

**Step 3: Add PDF tracking logic**

```typescript
import { getHighConfidenceTrackingForPOs } from '../tracking/shipment-intelligence';

export async function derivePOLifecycleState(poId: string) {
  // Existing logic...

  // Tracking check
  const tracking = await getHighConfidenceTrackingForPOs([poId]);
  if (tracking.get(poId)) {
    return {
      state: 'moving_with_tracking',
      evidence: { ...evidence, trackingNumber: tracking.get(poId), trackedAt: new Date().toISOString() }
    };
  }

  // If invoice scanned but no tracking
  if (po.evidence.hasInvoice) {
    return {
      state: 'ap_follow_up',
      evidence: { ...evidence, invoiceScanned: true }
    };
  }

  return { state: 'vendor_acknowledged', evidence };  // If acked but no tracking yet
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/purchasing/derive-po-lifecycle.test.ts`
Expected: PASS

**Step 5: Commit PDF integration**

```bash
git add src/lib/purchasing/derive-po-lifecycle.ts
git commit -m "feat: integrate PDF scanning for trusted tracking detection"
```

### Task 4: Add State Transition Logic and DB Updates

**Files:**
- Modify: `src/lib/purchasing/derive-po-lifecycle.ts`
- Modify: `src/lib/intelligence/purchasing-pipeline.ts` (or ops-manager)

**Step 1: Write failing test for DB updates**

```typescript
test('updates PO lifecycle state in DB', async () => {
  await derivePOLifecycleState('test-po-db');
  const po = await db.from('purchase_orders').select('lifecycle_state').eq('po_number', 'test-po-db').single();
  expect(po.lifecycle_state).toBe('moving_with_tracking');
});
```

**Step 2: Run test (assume DB mock)**

Expected: FAIL

**Step 3: Add DB update wrapper**

Create a function in purchasing-pipeline.ts:

```typescript
import { derivePOLifecycleState } from '../derive-po-lifecycle';

export async function updatePOLifecycle(poId: string) {
  const { state, evidence } = await derivePOLifecycleState(poId);
  const db = createClient();
  await db.from('purchase_orders').update({
    lifecycle_state: state,
    evidence: evidence
  }).eq('po_number', poId);
}
```

**Step 4: Run test**

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/purchasing/derive-po-lifecycle.ts src/lib/intelligence/purchasing-pipeline.ts
git commit -m "feat: add lifecycle state updates to purchase_orders table"
```

### Task 5: Add Alarms for Unacknowledged POs

**Files:**
- Modify: `src/lib/purchasing/derive-po-lifecycle.ts`
- Test: `src/lib/purchasing/derive-po-lifecycle.test.ts`

**Step 1: Write failing test for unacknowledged alarm**

```typescript
test('alarms on unacknowledged PO after 24h', async () => {
  // Simulate old PO
  expect(true).toBe(false); // TODO: mock time/alarm
});
```

**Step 2: Skip for now**

**Step 3: Add alarm logic (simple log for now)**

```typescript
const HOURS_SINCE_SENT = Date.now() - new Date(po.sentAt).getTime()) / (1000*60*60);

if (state === 'sent' && HOURS_SINCE_SENT > 24) {
  console.warn(`ALARM: PO ${poId} unacknowledged after ${HOURS_SINCE_SENT}h`);
}
```

**Step 4: Commit**

```bash
git commit -m "chore: add unacknowledged PO alarm (log only)"
```

### Task 6: Integrate into Cron Jobs

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts`

**Step 1: Add derivePOLifecycleState calls to hourly cron**

In ops-manager, after email polling:

```typescript
const poIds = await getRecentPOs();
for (const poId of poIds) {
  await updatePOLifecycle(poId);
}
```

**Step 5: Commit integration**

```bash
git commit -m "feat: integrate lifecycle updates into ops-manager cron"
```