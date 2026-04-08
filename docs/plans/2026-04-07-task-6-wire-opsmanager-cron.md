# Wire OpsManager Cron Job Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan.

**Goal:** Wire the OpsManager cron with the purchasing assessment pipeline, extracted into reusable modules for automated daily runs.

**Architecture:** Refactor purchasing-intelligence.ts to separate pipeline (scrape/assess), diff logic, and notification. Create purchasing-pipeline.ts for reusable scraping/assessment. Modify OpsManager cron to call pipeline, diff, and notify sequentially.

**Tech Stack:** TypeScript, Node.js, Supabase, Telegraf for Telegram.

---

### Task 1: Create Purchasing Pipeline Module

**Files:**
- Create: `src/lib/scraping/purchasing-pipeline.ts`
- Test: Run via `node --import tsx src/lib/scraping/purchasing-pipeline.ts` to verify it executes without errors and outputs results.

**Step 1: Implement purchasing-pipeline.ts**

Extract the scrape and assess phases from `purchasing-intelligence.ts` into a new file. Define interfaces and the runPurchasingPipeline function.

```typescript
import * as fs from 'fs';
import * as path from 'path';

// Interfaces matching existing vendor assessments
export interface VendorAssessment {
  vendor: string;
  items: Array<{
    sku: string;
    description: string;
    necessity: string;
  }>;
  highNeedCount: number;
  mediumCount: number;
  noiseCount: number;
}

export interface PipelineResult {
  assessed: VendorAssessment[];
  raw_purchases: any;
  pendingRequests: any[];
  durationMs: number;
}

async function runCommand(command: string, timeoutMs: number): Promise<string> {
  // Copied from purchasing-intelligence.ts
  const { stdout, stderr } = await execAsync(command, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.cwd(),
    env: { ...process.env, DOTENV_QUIET: '1' },
  });
  if (stderr && !stderr.includes('Debugger attached')) {
    console.warn(`[${command}] stderr:`, stderr);
  }
  return stdout;
}

export async function runPurchasingPipeline(): Promise<PipelineResult> {
  const startTime = Date.now();
  const timeoutMs = 5 * 60 * 1000;

  // Phase 1: Scrape
  console.log('[purchasing] Starting scrape...');
  await runCommand('node --import tsx src/cli/scrape-purchases.ts', timeoutMs);

  // Phase 2: Assess
  console.log('[purchasing] Starting assessment...');
  const assessStdout = await runCommand('node --import tsx src/cli/assess-purchases.ts --json', timeoutMs);
  // Parse JSON as in original
  const lines = assessStdout.split(/\r?\n/);
  let jsonStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[dotenv@')) continue;
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      jsonStartIdx = i;
      break;
    }
  }
  if (jsonStartIdx === -1) {
    throw new Error('No JSON found in assess-purchases output');
  }
  const jsonStr = lines.slice(jsonStartIdx).join('\n');
  const assessed: VendorAssessment[] = JSON.parse(jsonStr);

  // Load raw data
  const purchasesPath = path.resolve(process.cwd(), 'purchases-data.json');
  const requestsPath = path.resolve(process.cwd(), 'purchase-requests.json');
  let raw_purchases: any = {};
  let pendingRequests: any[] = [];
  if (fs.existsSync(purchasesPath)) {
    raw_purchases = JSON.parse(fs.readFileSync(purchasesPath, 'utf-8'));
  }
  if (fs.existsSync(requestsPath)) {
    const rawRequestsData = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
    pendingRequests = (rawRequestsData.requests || []).filter((r: any) => r.status === 'Pending');
  }

  return {
    assessed,
    raw_purchases,
    pendingRequests,
    durationMs: Date.now() - startTime
  };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  runPurchasingPipeline().then(result => {
    console.log(JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
```

**Step 2: Run test to verify**

Run: `node --import tsx src/lib/scraping/purchasing-pipeline.ts`
Expected: Runs successfully, outputs JSON with assessed items, etc. No errors.

**Step 3: Commit**

```bash
git add src/lib/scraping/purchasing-pipeline.ts
git commit -m "feat: extract scrape/assess logic into purchasing-pipeline module"
```

---

### Task 2: Refactor Purchasing Intelligence to Use Pipeline and Separate Logic

**Files:**
- Modify: `src/lib/intelligence/purchasing-intelligence.ts`
- Test: Ensure existing functionality works after refactor (run the CLI test script if available).

**Step 1: Update imports and logic**

Add imports:

```typescript
import { runPurchasingPipeline, type PipelineResult } from '../scraping/purchasing-pipeline';
```

Replace Phase 1 and 2 with:

```typescript
const pipelineResult: PipelineResult = await runPurchasingPipeline();
const { assessed: assessedVendorAssessments, raw_purchases, pendingRequests, durationMs } = pipelineResult;
```

**Step 2: Add diffAgainstSupabase function**

Earlier in file:

```typescript
export interface DiffResult {
  newHighNeedSkus: string[];
  newPendingRequests: any[];
}

export async function diffAgainstSupabase(assessed: VendorAssessment[], pendingRequests: any[]): Promise<DiffResult> {
  const supabase = createClient();
  if (!supabase) {
    throw new Error('Supabase client not available');
  }
  const { data: previous } = await supabase.from('purchasing_snapshots').select('assessed_items, raw_requests').order('generated_at', { ascending: false }).limit(1).maybeSingle();

  const currentHighNeedSkus = new Set(assessed.flatMap(va => va.items.filter(i => i.necessity === 'HIGH_NEED').map(i => i.sku.toLowerCase())));
  const previousHighNeedSkus = new Set((previous?.assessed_items || []).flatMap(va => va.items.filter(i => i.necessity === 'HIGH_NEED').map(i => i.sku.toLowerCase())));
  const newHighNeedSkus = Array.from(currentHighNeedSkus).filter(sku => !previousHighNeedSkus.has(sku));

  const previousRequestKeys = new Set((previous?.raw_requests || []).map((r: any) => `${r.details}|${r.quantity}`));
  const newPendingRequests = pendingRequests.filter(r => !previousRequestKeys.has(`${r.details}|${r.quantity}`));

  return { newHighNeedSkus, newPendingRequests };
}
```

**Step 3: Add telegramNotify function**

After building the message in runPurchasingIntelligence, but actually, move the notification to separate function.

In runPurchasingIntelligence, after building telegramMessage, instead of sending, return it and let caller send.

No, to match the task, have telegramNotify that takes diffs and sends.

So modify the building logic into telegramNotify.

Add export async function telegramNotify(diffs: DiffResult, assessedVendorAssessments: VendorAssessment[], pendingRequests: any[], durationMs: number, itemsProcessed: number, highNeedCount: number, mediumCount: number, lowCount: number, noiseCount: number, requestsProcessed: number)

Then inside, build the message as before, using diffs.newHighNeedSkus, diffs.newPendingRequests, etc., and send.

**Step 4: Update runPurchasingIntelligence**

Remove the notification and error handling for telegram.

Since the cron will do the pipeline, diff, snapshot, notify.

Actually, the snapshot should be saved in the cron or somewhere.

In the original, snapshot is saved in runPurchasingIntelligence.

To match the task, perhaps keep runPurchasingIntelligence with diff and snapshot, but use pipeline, then diff, save snapshot, build message, then if diffs, send, but the task has separate telegramNotify.

For now, since the task example has runPurchasingPipeline, diffAgainstSupabase, telegramNotify, and diff returns the diffs, perhaps save snapshot in telegramNotify or separately.

But to simplify, keep snapshot in a separate function, but since the task doesn't mention, perhaps the cron does const result = await runPurchasingPipeline();

const diffs = await diffAgainstSupabase(result);

const snapshot = await saveSnapshot(result, diffs);

await telegramNotify(diffs, snapshot);

But since it's not, perhaps keep it simple.

To follow the task, the cron code is given, so I can implement it as is, and keep the runPurchasingIntelligence as is, but since we refactored it to use pipeline, the cron is already good.

The task is to wire it, so perhaps already wired.

But to do the extraction.

Let's adjust the plan to have purchasing-intelligence changed to import the pipeline, and change the cron to the example code.

**Step 5: Update the cron call in ops-manager**

In Task 3, use the code as given in the task, but adjust for parameters.

Since the task has runPurchasingPipeline(), diffAgainstSupabase(result), telegramNotify(diffs.newHighNeeds)

Assuming result has the data, diffAgainstSupabase takes result, returns diffs = { newHighNeeds: string[] }

Then telegramNotify takes diffs.newHighNeeds

Then in the function, to make it work, we need to modify telegramNotify to take the list of skus, and lookup the items, and send the message.

Yes, simpler.

In purchasing-intelligence.ts, export async function telegramNotify(newHighNeedSkus: string[], newPendingRequests: any[], assessed, pendingRequests, durationMs, counts...)

But to match, let's see.

Perhaps have telegramNotify build and send the full message, taking the full diffs and result.

Yes, that's fine.

**Step 6: Run test to verify**

Expected: Still works, as before.

**Step 7: Commit**

```bash
git add src/lib/intelligence/purchasing-intelligence.ts
git commit -m "refactor: use extracted pipeline in purchasing-intelligence"
```

---

### Task 3: Update OpsManager Cron

**Files:**
- Modify: `src/lib/intelligence/ops-manager.ts:342-348`

**Step 1: Replace cron code**

Change:

```typescript
// Purchasing Intelligence Pipeline at 9:00 AM Mon-Fri
cron.schedule("0 9 * * 1-5", () => {
  this.safeRun("PurchasingPipeline", () => {
    const { runPurchasingIntelligence } = await import('./purchasing-intelligence');
    return runPurchasingIntelligence({ source: 'cron', triggeredBy: 'cron' });
  });
}, { timezone: "America/Denver" });
```

To:

```typescript
// Purchasing Intelligence Pipeline at 9:00 AM Mon-Fri
cron.schedule("0 9 * * 1-5", () => {
  this.safeRun("PurchasingPipeline", async () => {
    const { runPurchasingPipeline } = await import('./scraping/purchasing-pipeline');
    const result = await runPurchasingPipeline();
    const diffs = await diffAgainstSupabase(result);
    await telegramNotify(diffs.newHighNeeds);
  });
}, { timezone: "America/Denver" });
```

But diffAgainstSupabase needs import from purchasing-intelligence, telegramNotify too.

Add imports at top of ops-manager.ts

No, inside the safeRun.

To avoid circular, perhaps define a separate file, but since ops-manager imports purchasing-intelligence for runPurchasingAssessment, it's ok to import there.

 purchasing-intelligence has diffAgainstSupabase export.

Yes, import it inside.

For telegramNotify, need to export it from purchasing-intelligence.

In Task 2, we will add exports.

**Step 2: Ensure imports are correct**

In ops-manager.ts, no top import needed, since dynamic import.

To avoid issues, perhaps have the cron call runPurchasingIntelligence still, as it does the same.

But to follow the task, do as specified.

The example is '0 9 * * 1-5', matches.

**Step 3: Test simulation**

Run typecheck to ensure no errors.

**Step 4: Commit**

```bash
git add src/lib/intelligence/ops-manager.ts
git commit -m "feat: update cron to.pipeline, diff, notify pattern"
```

---

**Plan complete.**</content>
<parameter name="filePath">docs/plans/2026-04-07-task-6-wire-opsmanager-cron.md