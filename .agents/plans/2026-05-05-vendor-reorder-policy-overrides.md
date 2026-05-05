# Vendor Reorder Policy Overrides Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add vendor-level reorder policy overrides so Finale remains the source of truth for SKU order increments while Aria can tune vendor lead time, order cycle, and MOQ behavior.

**Architecture:** Keep SKU-level quantity multiples in Finale via `orderIncrementQuantity`; do not create Rootwise-specific pack-size logic. Add a compact Supabase-backed vendor policy layer that feeds `getPurchasingIntelligence()` before it calls the pure `recommendQty()` calculator. Extend the calculator to support vendor order cycle / cover-window overrides, lead-time overrides, MOQ `enforce | warn | ignore`, and review flags for large overbuy caused by pack, MOQ, or cycle rounding.

**Tech Stack:** TypeScript, Next.js API routes, Supabase migrations, Finale REST/GraphQL client, Vitest.

---

## Current State

- `src/lib/purchasing/qty-recommender.ts` is the canonical pure reorder quantity calculator.
- `FinaleClient.getPurchasingIntelligence()` in `src/lib/finale/client.ts` already reads Finale `orderIncrementQuantity` and passes it as `orderIncrementQty`.
- `recommendQty()` already snaps quantities to `orderIncrementQty`.
- `vendor_minimum_orders` currently stores vendor-level minimum order dollars/eaches and `loadVendorMOQs()` applies them.
- The current cover logic is global: `lead time + 60 days`.
- The missing behavior is vendor-specific planning policy:
  - Colorful Packaging should use a 30-45 day lead-time assumption and order roughly 6 months at a time.
  - Some vendor minimums should be enforceable, warn-only, or ignored.
  - Rootwise should use Finale SKU-level increments, not a custom Rootwise table.

## Business Rules

1. Finale is authoritative for SKU-level order increments.
2. Vendor policy is authoritative for order cadence and minimum override behavior.
3. Policy precedence:
   - future SKU policy override
   - vendor policy override
   - Finale SKU fields
   - system defaults
4. Default vendor behavior must remain unchanged.
5. Colorful Packaging seed policy:
   - `vendor_party_id = '10918'`
   - `lead_time_override_days = 45`
   - `target_cover_days = 180`
   - `moq_mode = 'warn'` unless a known hard MOQ is later confirmed
   - notes: `Custom packaging: 30-45 day lead time, order roughly 6 months at a time.`
6. Rootwise seed policy: none required unless later business review wants a different order cycle.

---

### Task 1: Add Vendor Policy Migration

**Files:**
- Create: `supabase/migrations/20260506000002_vendor_reorder_policies.sql`

**Step 1: Write the migration**

Create a table separate from `vendor_minimum_orders` so MOQ facts and planning preferences do not get mixed together.

```sql
CREATE TABLE IF NOT EXISTS public.vendor_reorder_policies (
    vendor_party_id TEXT PRIMARY KEY,
    vendor_name TEXT,
    lead_time_override_days INTEGER,
    target_cover_days INTEGER,
    moq_mode TEXT NOT NULL DEFAULT 'enforce',
    overbuy_review_pct NUMERIC(8,2) NOT NULL DEFAULT 50,
    overbuy_review_dollars NUMERIC(12,2) NOT NULL DEFAULT 1000,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vendor_reorder_policies_moq_mode_chk
        CHECK (moq_mode IN ('enforce', 'warn', 'ignore')),
    CONSTRAINT vendor_reorder_policies_lead_chk
        CHECK (lead_time_override_days IS NULL OR lead_time_override_days > 0),
    CONSTRAINT vendor_reorder_policies_cover_chk
        CHECK (target_cover_days IS NULL OR target_cover_days > 0)
);

COMMENT ON TABLE public.vendor_reorder_policies IS
    'Vendor-level reorder planning policy. Finale remains SKU-level source for order increments; this table controls vendor lead-time override, cover window, MOQ behavior, and review thresholds.';

INSERT INTO public.vendor_reorder_policies (
    vendor_party_id,
    vendor_name,
    lead_time_override_days,
    target_cover_days,
    moq_mode,
    overbuy_review_pct,
    overbuy_review_dollars,
    notes
)
VALUES (
    '10918',
    'Colorful Packaging Ltd',
    45,
    180,
    'warn',
    50,
    1000,
    'Custom packaging: 30-45 day lead time, order roughly 6 months at a time.'
)
ON CONFLICT (vendor_party_id) DO UPDATE SET
    vendor_name = EXCLUDED.vendor_name,
    lead_time_override_days = EXCLUDED.lead_time_override_days,
    target_cover_days = EXCLUDED.target_cover_days,
    moq_mode = EXCLUDED.moq_mode,
    overbuy_review_pct = EXCLUDED.overbuy_review_pct,
    overbuy_review_dollars = EXCLUDED.overbuy_review_dollars,
    notes = EXCLUDED.notes,
    updated_at = now();
```

**Step 2: Verify migration syntax locally**

Run:

```bash
node --import tsx _run_migration.js supabase/migrations/20260506000002_vendor_reorder_policies.sql
```

Expected: migration applies without SQL errors.

**Step 3: Commit**

```bash
git add supabase/migrations/20260506000002_vendor_reorder_policies.sql
git commit -m "feat(purchasing): add vendor reorder policy table"
```

---

### Task 2: Add Policy Loader

**Files:**
- Modify: `src/lib/purchasing/calibration.ts`
- Test: `src/lib/purchasing/calibration.test.ts` if one exists; otherwise create `src/lib/purchasing/calibration.test.ts` with mocked Supabase client only if local patterns support it. If mocking this module is too noisy, skip direct DB loader tests and cover behavior through `qty-recommender.test.ts` plus `FinaleClient` wiring tests.

**Step 1: Add types**

Add near the vendor MOQ section in `src/lib/purchasing/calibration.ts`:

```ts
export type VendorMoqMode = "enforce" | "warn" | "ignore";

export interface VendorReorderPolicy {
    vendorPartyId: string;
    vendorName: string | null;
    leadTimeOverrideDays: number | null;
    targetCoverDays: number | null;
    moqMode: VendorMoqMode;
    overbuyReviewPct: number;
    overbuyReviewDollars: number;
    notes: string | null;
}
```

**Step 2: Add loader**

```ts
export async function loadVendorReorderPolicies(
    vendorPartyIds: string[]
): Promise<Map<string, VendorReorderPolicy>> {
    const map = new Map<string, VendorReorderPolicy>();
    if (vendorPartyIds.length === 0) return map;
    const db = createClient();
    if (!db) return map;
    try {
        const { data } = await db
            .from("vendor_reorder_policies")
            .select("vendor_party_id, vendor_name, lead_time_override_days, target_cover_days, moq_mode, overbuy_review_pct, overbuy_review_dollars, notes")
            .in("vendor_party_id", vendorPartyIds);
        for (const row of data ?? []) {
            map.set(row.vendor_party_id, {
                vendorPartyId: row.vendor_party_id,
                vendorName: row.vendor_name ?? null,
                leadTimeOverrideDays: row.lead_time_override_days,
                targetCoverDays: row.target_cover_days,
                moqMode: (row.moq_mode ?? "enforce") as VendorMoqMode,
                overbuyReviewPct: Number(row.overbuy_review_pct ?? 50),
                overbuyReviewDollars: Number(row.overbuy_review_dollars ?? 1000),
                notes: row.notes ?? null,
            });
        }
    } catch (err: any) {
        console.warn(`[calibration] loadVendorReorderPolicies failed: ${err.message}`);
    }
    return map;
}
```

**Step 3: Typecheck**

Run:

```bash
npm run typecheck:cli
```

Expected: no new TypeScript errors from `calibration.ts`.

**Step 4: Commit**

```bash
git add src/lib/purchasing/calibration.ts
git commit -m "feat(purchasing): load vendor reorder policies"
```

---

### Task 3: Extend Pure Recommender for Vendor Policy

**Files:**
- Modify: `src/lib/purchasing/qty-recommender.ts`
- Modify: `src/lib/purchasing/qty-recommender.test.ts`

**Step 1: Write failing tests**

Add tests to `qty-recommender.test.ts`.

```ts
describe("recommendQty - vendor reorder policy", () => {
    it("uses targetCoverDays as total cover when provided", () => {
        const result = recommendQty(baseInput({
            dailyRate: 2,
            stockOnHand: 50,
            leadTimeDays: 14,
            targetCoverDays: 180,
        }));

        expect(result.coverDays).toBe(180);
        expect(result.rawNeededEaches).toBe(310);
        expect(result.provenance.find(p => p.step === "cover_days")?.detail).toContain("vendor policy");
    });

    it("uses lead time override ahead of Finale or history lead", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 0,
            leadTimeDays: 14,
            leadTimeOverrideDays: 45,
        }));

        expect(result.leadTimeUsed).toBe(45);
        expect(result.provenance.find(p => p.step === "lead_time")?.detail).toContain("override");
    });

    it("warns but does not bump quantity when moqMode is warn", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 44,
            leadTimeDays: 14,
            minimumOrderEaches: 100,
            moqMode: "warn",
        }));

        expect(result.suggestedQty).toBe(30);
        expect(result.moqApplied).toBe(false);
        expect(result.moqWarning).toBe(true);
        expect(result.provenance.find(p => p.step === "moq")?.detail).toContain("warn-only");
    });

    it("ignores MOQ when moqMode is ignore", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 44,
            leadTimeDays: 14,
            minimumOrderEaches: 100,
            moqMode: "ignore",
        }));

        expect(result.suggestedQty).toBe(30);
        expect(result.moqApplied).toBe(false);
        expect(result.moqWarning).toBe(false);
    });

    it("flags review when rounding creates a large overbuy", () => {
        const result = recommendQty(baseInput({
            dailyRate: 1,
            stockOnHand: 44,
            leadTimeDays: 14,
            orderIncrementQty: 100,
            unitPrice: 20,
            overbuyReviewPct: 50,
            overbuyReviewDollars: 1000,
        }));

        expect(result.suggestedQty).toBe(100);
        expect(result.reviewRequired).toBe(true);
        expect(result.reviewReasons.join(" ")).toContain("overbuy");
    });
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
npx vitest run src/lib/purchasing/qty-recommender.test.ts
```

Expected: FAIL because the new input/result fields do not exist.

**Step 3: Extend input and result types**

Add to `RecommenderInput`:

```ts
leadTimeOverrideDays?: number | null;
targetCoverDays?: number | null;
moqMode?: "enforce" | "warn" | "ignore";
overbuyReviewPct?: number | null;
overbuyReviewDollars?: number | null;
```

Add to `RecommenderResult`:

```ts
moqWarning: boolean;
reviewRequired: boolean;
reviewReasons: string[];
```

**Step 4: Implement lead-time override**

Change the lead-time basis block so `leadTimeOverrideDays` wins before P90:

```ts
const leadTimeOverride = input.leadTimeOverrideDays ?? null;
const leadTimeP90 = input.leadTimeP90 ?? null;
const leadTimeUsed = leadTimeOverride != null && leadTimeOverride > 0
    ? leadTimeOverride
    : (leadTimeP90 != null && leadTimeP90 > 0)
        ? leadTimeP90
        : input.leadTimeDays;
const leadTimeBasis: "p90" | "median" | "point" = (leadTimeP90 != null && leadTimeP90 > 0 && !(leadTimeOverride != null && leadTimeOverride > 0))
    ? "p90"
    : input.leadTimeProvenance === "vendor_median" ? "median" : "point";
```

Add a provenance branch:

```ts
if (leadTimeOverride != null && leadTimeOverride > 0) {
    trace.push({
        step: "lead_time",
        detail: `Using ${leadTimeOverride}d vendor policy override instead of ${input.leadTimeDays}d (${input.leadTimeProvenance})`,
        value: leadTimeUsed,
    });
} else if (leadTimeBasis === "p90") {
    ...
}
```

**Step 5: Implement target cover days**

Replace the current cover-days calculation with:

```ts
const targetCoverDays = input.targetCoverDays ?? null;
const buffer = input.coverBufferDays ?? 60;
const safetyMultiplier = Math.max(0.5, Math.min(2.5, input.safetyMultiplier ?? 1));
let coverDays: number;

if (targetCoverDays != null && targetCoverDays > 0) {
    coverDays = Math.max(leadTimeUsed, targetCoverDays);
    trace.push({
        step: "cover_days",
        detail: `Using ${coverDays}d total cover from vendor policy`,
        value: coverDays,
    });
} else {
    const adjustedBuffer = Math.round(buffer * safetyMultiplier);
    coverDays = leadTimeUsed + adjustedBuffer;
    ...
}
```

**Step 6: Implement MOQ modes**

Before the MOQ block:

```ts
const moqMode = input.moqMode ?? "enforce";
let moqApplied = false;
let moqWarning = false;
```

Inside MOQ handling:

- `ignore`: emit provenance step and do not bump.
- `warn`: emit provenance step, set `moqWarning = true`, do not bump.
- `enforce`: keep existing bump behavior.

Use helper variables so minimum-eaches and minimum-dollars share the same behavior.

**Step 7: Implement overbuy review flags**

After MOQ handling and before urgency:

```ts
const reviewReasons: string[] = [];
if (rawNeededEaches > 0 && suggestedQty > rawNeededEaches) {
    const overbuyQty = suggestedQty - rawNeededEaches;
    const overbuyPct = (overbuyQty / rawNeededEaches) * 100;
    const overbuyDollars = input.unitPrice && input.unitPrice > 0 ? overbuyQty * input.unitPrice : 0;
    const pctThreshold = input.overbuyReviewPct ?? 50;
    const dollarsThreshold = input.overbuyReviewDollars ?? 1000;
    if (overbuyPct >= pctThreshold || overbuyDollars >= dollarsThreshold) {
        reviewReasons.push(
            `Large overbuy from ordering constraints: +${Math.round(overbuyQty)} eaches (${Math.round(overbuyPct)}%)` +
            (overbuyDollars > 0 ? `, approx $${overbuyDollars.toFixed(0)}` : "")
        );
        trace.push({
            step: "review",
            detail: reviewReasons[reviewReasons.length - 1],
            value: Math.round(overbuyQty),
        });
    }
}
const reviewRequired = reviewReasons.length > 0;
```

Return `moqWarning`, `reviewRequired`, and `reviewReasons`.

**Step 8: Bump `QTY_FORMULA_VERSION`**

The recommender's behavior is materially changing (lead-time override path,
target cover path, MOQ tri-state, review flags). The canonical-recommender
plan (`2026-05-05-canonical-recommender.md`) requires bumping
`QTY_FORMULA_VERSION` on behavioral change so calibration can bucket error
rates per formula version. Without the bump, the calibration loop blends
pre-policy and post-policy recs, contaminating the `safety_multiplier`.

In `src/lib/purchasing/qty-recommender.ts`:

```ts
export const QTY_FORMULA_VERSION = "v2.1-vendor-policy-2026-05-06";
```

**Step 9: Note safety-multiplier bypass on cover override**

When `targetCoverDays` is set, `safetyMultiplier` is intentionally bypassed —
Will set the cover on purpose; calibration shouldn't dampen it. Make this
visible in the provenance trace:

```ts
trace.push({
    step: "cover_days",
    detail: `Using ${coverDays}d total cover from vendor policy (safetyMultiplier=${safetyMultiplier.toFixed(2)} bypassed)`,
    value: coverDays,
});
```

So the dashboard "Why X?" drawer reflects that the bypass is by design.

**Step 10: Run tests**

Run:

```bash
npx vitest run src/lib/purchasing/qty-recommender.test.ts
```

Expected: PASS.

**Step 11: Commit**

```bash
git add src/lib/purchasing/qty-recommender.ts src/lib/purchasing/qty-recommender.test.ts
git commit -m "feat(purchasing): support vendor reorder policy in qty recommender

Bumps QTY_FORMULA_VERSION to v2.1-vendor-policy-2026-05-06 so calibration
can bucket error rates separately from pre-policy recs. Cover override
bypasses safetyMultiplier by design (Will sets cover deliberately)."
```

---

### Task 4: Wire Vendor Policy into Purchasing Intelligence

**Files:**
- Modify: `src/lib/finale/client.ts`
- Test: existing route/client tests if practical:
  - `src/app/api/dashboard/purchasing/route.test.ts`
  - `src/lib/finale/client.test.ts`
  - If these are too integration-heavy, add unit coverage around `recommendQty()` and keep the wiring change small.

**Step 1: Import policy loader**

In `src/lib/finale/client.ts`, extend the calibration import:

```ts
import {
    loadActiveReservations,
    loadCalibrationStats,
    loadVendorMOQs,
    loadVendorReorderPolicies,
    recordRecommendationSnapshots,
    type RecommendationSnapshot,
} from "@/lib/purchasing/calibration";
```

**Step 2: Add a local cache map in `getPurchasingIntelligence()`**

Near the existing `calibrationCache` and `moqCache`, add:

```ts
const reorderPolicyCache = new Map<string, Awaited<ReturnType<typeof loadVendorReorderPolicies>> extends Map<string, infer T> ? T : never>();
```

If that inferred type is ugly in practice, import `type VendorReorderPolicy` from `calibration.ts` and use:

```ts
const reorderPolicyCache = new Map<string, VendorReorderPolicy>();
```

**Step 3: Load policy alongside calibration and MOQ**

Replace the existing per-vendor lookup:

```ts
const [calMap, moqMap] = await Promise.all([
    loadCalibrationStats([partyId]),
    loadVendorMOQs([partyId]),
]);
```

With:

```ts
const [calMap, moqMap, policyMap] = await Promise.all([
    loadCalibrationStats([partyId]),
    loadVendorMOQs([partyId]),
    loadVendorReorderPolicies([partyId]),
]);
```

Then cache:

```ts
const policy = policyMap.get(partyId);
if (policy) reorderPolicyCache.set(partyId, policy);
```

**Step 4: Apply lead time override**

Keep the existing `leadTimeDays` and `leadTimeProvenance` calculation intact, then before creating `recInputs`:

```ts
const reorderPolicy = reorderPolicyCache.get(partyId);
const effectiveLeadTimeDays = reorderPolicy?.leadTimeOverrideDays ?? leadTimeDays;
const effectiveLeadTimeProvenance = reorderPolicy?.leadTimeOverrideDays
    ? `${reorderPolicy.leadTimeOverrideDays}d vendor policy override`
    : leadTimeProvenance;
```

**Step 5: Pass policy fields into recommender**

In `recInputs`, use:

```ts
leadTimeDays: effectiveLeadTimeDays,
leadTimeProvenance: effectiveLeadTimeProvenance,
leadTimeOverrideDays: reorderPolicy?.leadTimeOverrideDays ?? null,
targetCoverDays: reorderPolicy?.targetCoverDays ?? null,
moqMode: reorderPolicy?.moqMode ?? "enforce",
overbuyReviewPct: reorderPolicy?.overbuyReviewPct ?? 50,
overbuyReviewDollars: reorderPolicy?.overbuyReviewDollars ?? 1000,
```

Continue passing Finale `orderIncrementQty` unchanged.

**Note on calibration accuracy:** the existing snapshot writer at
`client.ts:~4974` already persists the entire `recInputs` object as
`qty_recommendations.inputs_jsonb`. This means every rec automatically
captures the policy values that drove it — calibration retros can
reconstruct exactly what policy was active when each rec was made,
even after a policy edit. No additional snapshot changes needed.

**Step 6: Add fields to `PurchasingItem`**

Extend `PurchasingItem` in `src/lib/finale/client.ts`:

```ts
vendorPolicy?: {
    leadTimeOverrideDays: number | null;
    targetCoverDays: number | null;
    moqMode: "enforce" | "warn" | "ignore";
    overbuyReviewPct: number;
    overbuyReviewDollars: number;
    notes: string | null;
};
moqWarning?: boolean;
reviewRequired?: boolean;
reviewReasons?: string[];
```

When pushing `items.push({ ... })`, add:

```ts
leadTimeDays: effectiveLeadTimeDays,
leadTimeProvenance: effectiveLeadTimeProvenance,
vendorPolicy: reorderPolicy ? {
    leadTimeOverrideDays: reorderPolicy.leadTimeOverrideDays,
    targetCoverDays: reorderPolicy.targetCoverDays,
    moqMode: reorderPolicy.moqMode,
    overbuyReviewPct: reorderPolicy.overbuyReviewPct,
    overbuyReviewDollars: reorderPolicy.overbuyReviewDollars,
    notes: reorderPolicy.notes,
} : undefined,
moqWarning: rec.moqWarning,
reviewRequired: rec.reviewRequired,
reviewReasons: rec.reviewReasons,
```

**Step 7: Run focused tests**

Run:

```bash
npx vitest run src/lib/purchasing/qty-recommender.test.ts src/app/api/dashboard/purchasing/route.test.ts
```

Expected: PASS or only unrelated pre-existing failures. If route tests fail due to new fields, update test fixtures to include optional fields or assert the new Colorful-style behavior with mocked client data.

**Step 8: Commit**

```bash
git add src/lib/finale/client.ts src/app/api/dashboard/purchasing/route.test.ts
git commit -m "feat(purchasing): apply vendor reorder policy during recommendations"
```

---

### Task 5: Surface Policy and Review Reasons in the Dashboard

**Files:**
- Modify: `src/components/dashboard/PurchasingPanel.tsx`
- Test: `src/components/dashboard/PurchasingPanel.test.tsx`

**Step 1: Find item type definitions**

Search in `PurchasingPanel.tsx` for the local item/group interfaces. Add optional fields matching `PurchasingItem`:

```ts
vendorPolicy?: {
    leadTimeOverrideDays: number | null;
    targetCoverDays: number | null;
    moqMode: "enforce" | "warn" | "ignore";
    overbuyReviewPct: number;
    overbuyReviewDollars: number;
    notes: string | null;
};
moqWarning?: boolean;
reviewRequired?: boolean;
reviewReasons?: string[];
```

**Step 2: Add small badges, not a new large UI**

Near the existing suggested quantity / recommendation explanation display, add compact indicators:

```tsx
{item.vendorPolicy?.targetCoverDays ? (
    <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">
        {item.vendorPolicy.targetCoverDays}d cover
    </span>
) : null}
{item.vendorPolicy?.leadTimeOverrideDays ? (
    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-700">
        {item.vendorPolicy.leadTimeOverrideDays}d lead
    </span>
) : null}
{item.moqWarning ? (
    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">
        MOQ warn
    </span>
) : null}
{item.reviewRequired ? (
    <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700">
        Review
    </span>
) : null}
```

Use existing panel styling if nearby code has a stronger pattern.

**Step 3: Add review reasons to detail/provenance area**

Where the item renders recommendation provenance or details, add:

```tsx
{item.reviewReasons?.length ? (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">
        {item.reviewReasons.map(reason => (
            <div key={reason}>{reason}</div>
        ))}
    </div>
) : null}
```

**Step 4: Add/adjust component tests**

In `src/components/dashboard/PurchasingPanel.test.tsx`, add or update a fixture item with:

```ts
vendorPolicy: {
    leadTimeOverrideDays: 45,
    targetCoverDays: 180,
    moqMode: "warn",
    overbuyReviewPct: 50,
    overbuyReviewDollars: 1000,
    notes: "Custom packaging",
},
moqWarning: true,
reviewRequired: true,
reviewReasons: ["Large overbuy from ordering constraints: +100 eaches (55%)"],
```

Assert the UI shows:

```ts
expect(screen.getByText("180d cover")).toBeTruthy();
expect(screen.getByText("45d lead")).toBeTruthy();
expect(screen.getByText("MOQ warn")).toBeTruthy();
expect(screen.getByText("Review")).toBeTruthy();
expect(screen.getByText(/Large overbuy/)).toBeTruthy();
```

**Step 5: Run tests**

Run:

```bash
npx vitest run src/components/dashboard/PurchasingPanel.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/dashboard/PurchasingPanel.tsx src/components/dashboard/PurchasingPanel.test.tsx
git commit -m "feat(purchasing): show vendor policy badges and review reasons"
```

---

### Task 6: Add a Manual Policy Inspection CLI

**Files:**
- Create: `src/cli/vendor-reorder-policy.ts`
- Modify: `package.json` only if this repo convention lists CLI scripts there. Otherwise skip package changes and run through `node --import tsx`.

**Step 1: Create a small read-only CLI**

```ts
import "dotenv/config";
import { loadVendorReorderPolicies } from "@/lib/purchasing/calibration";

async function main() {
    const ids = process.argv.slice(2);
    if (ids.length === 0) {
        console.error("Usage: node --import tsx src/cli/vendor-reorder-policy.ts <vendorPartyId> [...]");
        process.exit(1);
    }
    const policies = await loadVendorReorderPolicies(ids);
    for (const id of ids) {
        const policy = policies.get(id);
        if (!policy) {
            console.log(`${id}: no vendor reorder policy`);
            continue;
        }
        console.log(`${id}: ${policy.vendorName ?? "Unknown"}`);
        console.log(`  lead override: ${policy.leadTimeOverrideDays ?? "default"}`);
        console.log(`  target cover: ${policy.targetCoverDays ?? "default"}`);
        console.log(`  MOQ mode: ${policy.moqMode}`);
        console.log(`  review: ${policy.overbuyReviewPct}% or $${policy.overbuyReviewDollars}`);
        if (policy.notes) console.log(`  notes: ${policy.notes}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
```

**Step 2: Run against Colorful**

Run:

```bash
node --import tsx src/cli/vendor-reorder-policy.ts 10918
```

Expected:

```text
10918: Colorful Packaging Ltd
  lead override: 45
  target cover: 180
  MOQ mode: warn
```

**Step 3: Commit**

```bash
git add src/cli/vendor-reorder-policy.ts package.json
git commit -m "chore(purchasing): add vendor reorder policy inspection cli"
```

---

### Task 7: Final Verification

**Files:**
- No edits unless failures require fixes.

**Step 1: Run focused tests**

```bash
npx vitest run src/lib/purchasing/qty-recommender.test.ts src/components/dashboard/PurchasingPanel.test.tsx src/app/api/dashboard/purchasing/route.test.ts
```

Expected: PASS.

**Step 2: Run typecheck**

```bash
npm run typecheck:cli
```

Expected: PASS or only documented unrelated pre-existing errors. If there are pre-existing errors, capture exact lines in final notes.

**Step 3: Run purchasing scan manually if credentials are available**

```bash
curl "http://localhost:3000/api/dashboard/purchasing?bust=1&daysBack=365"
```

Expected:

- Response includes `Colorful Packaging Ltd`.
- Colorful items include `vendorPolicy.targetCoverDays = 180`.
- Colorful recommendations use `coverDays = 180` in provenance.
- Rootwise items continue to show Finale-derived `orderIncrementQty`; no Rootwise-specific policy is required.

**Step 4: Start or reuse dev server for UI check**

If no server is running:

```bash
npm run dev
```

Open the dashboard purchasing panel and verify:

- Colorful shows `180d cover`.
- Colorful shows `45d lead`.
- Any warning/review lines are visible without blocking normal browsing.
- Suggested quantities remain snapped to Finale SKU increments.

**Step 5: Commit verification fixes**

If any test/UI fixes were needed:

```bash
git add <changed-files>
git commit -m "fix(purchasing): stabilize vendor reorder policy rollout"
```

---

## Expected first-PO behavior under the Colorful seed

The 180-day cover seed is intentionally aggressive — first Colorful PO under
this policy will likely recommend ~3-5x the historical pattern. That's by
design (custom-packaged vendor, big batch cadence). Two follow-on effects
to be aware of:

1. **Lifecycle ribbon (Phase C) will show a large "rec N → ordered M"
   divergence on the first Colorful PO if Will overrides the suggested qty.**
   That divergence is expected, not a bug — Will may not yet trust the 180-day
   cover number.

2. **Calibration loop will see negative bias on Colorful for ~6 months.**
   Aria's recommendation will exceed actual ordered qty until enough cycles
   have passed for the safety_multiplier to settle. This is intentional —
   the policy bypasses safety_multiplier for cover specifically so calibration
   doesn't dampen Will's chosen 180-day number.

Neither effect is a problem; both are visible in the dashboard and harmless.

---

## Rollback

If the policy behavior causes bad recommendations:

1. Set Colorful policy back to defaults:

```sql
DELETE FROM public.vendor_reorder_policies WHERE vendor_party_id = '10918';
```

2. Or change MOQ behavior only:

```sql
UPDATE public.vendor_reorder_policies
SET moq_mode = 'ignore', updated_at = now()
WHERE vendor_party_id = '10918';
```

3. Re-run purchasing with `?bust=1` to clear the 30-minute API cache.

## Non-Goals

- Do not add a Rootwise-specific quantity table.
- Do not duplicate Finale `Std reorder in qty of`.
- Do not automate checkout.
- Do not build a full vendor policy editor in this pass.
- Do not change draft PO creation semantics except for preserving the recommended quantities produced by the existing flow.

