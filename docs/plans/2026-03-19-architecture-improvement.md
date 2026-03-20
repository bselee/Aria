# ARIA Architecture Improvement Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform ARIA from a monolithic, untestable system into a modular, observable, and well-tested operations platform.

**Architecture:** Extract god-file responsibilities into focused modules with shared interfaces. Introduce a centralized cron registry for observability, an Agent base class for standardized lifecycle, and structured error tracking. Start TDD coverage from the extracted modules outward.

**Tech Stack:** TypeScript, Vitest, Supabase, Pinecone, Telegraf, node-cron

---

## Track 1: Extract Tracking Service (Lowest Risk, Highest Clarity)

> **Why first:** Zero business logic change. Pure code movement. Removes ~300 lines from ops-manager.ts. Immediately testable.

### Task 1.1: Create tracking-service.ts with types and patterns

**Files:**
- Create: `src/lib/carriers/tracking-service.ts`
- Test: `src/lib/carriers/tracking-service.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/carriers/tracking-service.test.ts
import { describe, it, expect } from 'vitest';
import {
    detectCarrier,
    extractTrackingNumber,
    carrierUrl,
    parseTrackingContent,
    TRACKING_PATTERNS,
} from './tracking-service';

describe('detectCarrier', () => {
    it('should detect UPS tracking numbers', () => {
        expect(detectCarrier('1Z999AA10123456784')).toBe('ups');
    });
    it('should detect FedEx 12-digit numbers', () => {
        expect(detectCarrier('123456789012')).toBe('fedex');
    });
    it('should detect FedEx 15-digit numbers', () => {
        expect(detectCarrier('123456789012345')).toBe('fedex');
    });
    it('should detect USPS numbers', () => {
        expect(detectCarrier('94001234567890123456789012')).toBe('usps');
    });
    it('should return null for unrecognized format', () => {
        expect(detectCarrier('XXXX')).toBeNull();
    });
});

describe('carrierUrl', () => {
    it('should build UPS URL', () => {
        const url = carrierUrl('1Z999AA10123456784');
        expect(url).toContain('ups.com');
        expect(url).toContain('1Z999AA10123456784');
    });
    it('should build FedEx URL for numeric tracking', () => {
        const url = carrierUrl('123456789012');
        expect(url).toContain('fedex.com');
    });
    it('should handle LTL carrier:::number format', () => {
        const url = carrierUrl('Old Dominion:::1234567');
        expect(url).toContain('odfl.com');
        expect(url).toContain('1234567');
    });
    it('should fallback to parcelsapp for unknown LTL carrier', () => {
        const url = carrierUrl('Unknown Freight:::9999999');
        expect(url).toContain('parcelsapp.com');
    });
});

describe('parseTrackingContent', () => {
    it('should detect delivered status', () => {
        const result = parseTrackingContent('Package delivered on March 15, 2026');
        expect(result?.category).toBe('delivered');
    });
    it('should detect out for delivery', () => {
        const result = parseTrackingContent('Your package is out for delivery');
        expect(result?.category).toBe('out_for_delivery');
    });
    it('should detect in-transit with ETA', () => {
        const result = parseTrackingContent('Estimated delivery: March 20, 2026');
        expect(result?.category).toBe('in_transit');
        expect(result?.display).toContain('March 20');
    });
    it('should detect exception', () => {
        const result = parseTrackingContent('Delivery exception reported');
        expect(result?.category).toBe('exception');
    });
    it('should return null for unparseable content', () => {
        expect(parseTrackingContent('lorem ipsum dolor sit amet')).toBeNull();
    });
});

describe('detectLTLCarrier', () => {
    it('should detect Old Dominion', () => {
        const { detectLTLCarrier } = require('./tracking-service');
        expect(detectLTLCarrier('shipped via old dominion freight')).toBe('Old Dominion');
    });
    it('should detect XPO', () => {
        const { detectLTLCarrier } = require('./tracking-service');
        expect(detectLTLCarrier('XPO Logistics tracking')).toBe('XPO Logistics');
    });
    it('should return null for unknown carrier', () => {
        const { detectLTLCarrier } = require('./tracking-service');
        expect(detectLTLCarrier('random text about shipping')).toBeNull();
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/carriers/tracking-service.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Move lines 51–389 from `ops-manager.ts` into `src/lib/carriers/tracking-service.ts`:
- `TRACKING_PATTERNS` (lines 51–63)
- `LTL_CARRIER_KEYWORDS` (lines 66–86)
- `detectLTLCarrier()` (lines 88–93)
- `TrackingCategory`, `TrackingStatus` types (lines 95–96)
- `LTL_DIRECT_LINKS` (lines 99–115)
- `carrierUrl()` (lines 117–141)
- `parseTrackingContent()` (lines 146–177)
- `isFedExNumber()` (lines 189–191)
- `getFedExTrackingStatus()` (lines 197–269) — with FedEx OAuth cache
- `getLTLTrackingStatus()` (lines 276–302)
- `getTrackingStatus()` (lines 304–365)
- `buildFollowUpEmail()` (lines 371–389)
- Add new helper: `detectCarrier()` and `extractTrackingNumber()` as public API

New file header:
```typescript
/**
 * @file    tracking-service.ts
 * @purpose Carrier tracking detection, URL generation, and status retrieval.
 *          Supports UPS, FedEx (direct API), USPS, DHL, EasyPost, and LTL freight
 *          carriers (Old Dominion, XPO, Saia, Estes, R&L, Dayton, etc.)
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    @easypost/api
 * @env     FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, EASYPOST_API_KEY
 */
```

**Step 4: Update ops-manager.ts imports**

Replace 300+ lines with:
```typescript
import {
    TRACKING_PATTERNS,
    getTrackingStatus,
    carrierUrl,
    detectLTLCarrier,
    buildFollowUpEmail,
    type TrackingStatus,
    type TrackingCategory,
} from '../carriers/tracking-service';
```

**Step 5: Run tests**

Run: `npx vitest run src/lib/carriers/tracking-service.test.ts`
Expected: ALL PASS

**Step 6: Run full typecheck**

Run: `npm run typecheck`
Expected: No new errors

**Step 7: Commit**

```bash
git add src/lib/carriers/ src/lib/intelligence/ops-manager.ts
git commit -m "refactor(tracking): extract tracking service from ops-manager

- Move TRACKING_PATTERNS, carrier detection, FedEx OAuth, EasyPost,
  LTL carrier keywords, URL builders, and status parsing
- ~300 lines removed from ops-manager.ts
- Add 15 unit tests for pure functions
- Zero behavior change"
```

---

## Track 2: Centralized Cron Registry

> **Why:** Makes the system observable. Answers "what is Aria doing right now?" from Telegram and the dashboard.

### Task 2.1: Create CronRegistry class

**Files:**
- Create: `src/lib/scheduler/cron-registry.ts`
- Test: `src/lib/scheduler/cron-registry.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/scheduler/cron-registry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-cron before importing
vi.mock('node-cron', () => ({
    default: { schedule: vi.fn() },
}));

import { CronRegistry, type CronJobDefinition } from './cron-registry';

describe('CronRegistry', () => {
    let registry: CronRegistry;

    beforeEach(() => {
        registry = new CronRegistry();
    });

    it('should register a job and track it', () => {
        registry.register({
            name: 'TestJob',
            schedule: '*/5 * * * *',
            handler: async () => {},
            group: 'email',
        });
        const jobs = registry.listJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].name).toBe('TestJob');
        expect(jobs[0].schedule).toBe('*/5 * * * *');
    });

    it('should group jobs by category', () => {
        registry.register({ name: 'Job1', schedule: '* * * * *', handler: async () => {}, group: 'email' });
        registry.register({ name: 'Job2', schedule: '* * * * *', handler: async () => {}, group: 'email' });
        registry.register({ name: 'Job3', schedule: '* * * * *', handler: async () => {}, group: 'tracking' });

        const grouped = registry.listJobsByGroup();
        expect(grouped.email).toHaveLength(2);
        expect(grouped.tracking).toHaveLength(1);
    });

    it('should update status after successful run', async () => {
        const handler = vi.fn().mockResolvedValue(undefined);
        registry.register({ name: 'SuccessJob', schedule: '* * * * *', handler, group: 'test' as any });

        await registry.executeJob('SuccessJob');
        const status = registry.getJobStatus('SuccessJob');
        expect(status?.status).toBe('success');
        expect(status?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should update status after failed run', async () => {
        const handler = vi.fn().mockRejectedValue(new Error('test error'));
        registry.register({ name: 'FailJob', schedule: '* * * * *', handler, group: 'test' as any });

        await registry.executeJob('FailJob');
        const status = registry.getJobStatus('FailJob');
        expect(status?.status).toBe('error');
        expect(status?.error).toBe('test error');
    });

    it('should format status for Telegram display', () => {
        registry.register({
            name: 'Job1',
            schedule: '0 8 * * 1-5',
            handler: async () => {},
            group: 'reports',
            description: 'Daily summary',
        });
        const formatted = registry.formatTelegramStatus();
        expect(formatted).toContain('Job1');
        expect(formatted).toContain('Daily summary');
    });

    it('should prevent duplicate job names', () => {
        registry.register({ name: 'Dup', schedule: '* * * * *', handler: async () => {}, group: 'email' });
        expect(() => {
            registry.register({ name: 'Dup', schedule: '*/5 * * * *', handler: async () => {}, group: 'tracking' });
        }).toThrow(/already registered/i);
    });

    it('should return null for unknown job status', () => {
        expect(registry.getJobStatus('NonExistent')).toBeNull();
    });
});
```

**Step 2: Write the implementation**

```typescript
// src/lib/scheduler/cron-registry.ts
/**
 * @file    cron-registry.ts
 * @purpose Centralized registry for all scheduled cron jobs. Provides typed
 *          schedule definitions, execution tracking, and formatted status
 *          output for Telegram /crons command and dashboard display.
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    node-cron
 */

import cron from 'node-cron';
import { createClient } from '../supabase';

export type CronGroup =
    | 'email'
    | 'tracking'
    | 'reports'
    | 'reconciliation'
    | 'maintenance'
    | 'purchasing'
    | 'monitoring';

export interface CronJobDefinition {
    name: string;
    schedule: string;
    handler: () => Promise<any>;
    group: CronGroup;
    description?: string;
    timezone?: string;
    enabled?: boolean;
}

export interface CronJobStatus {
    name: string;
    group: CronGroup;
    schedule: string;
    description?: string;
    lastRun: Date | null;
    durationMs: number;
    status: 'success' | 'error' | 'never_run';
    error?: string;
}
```

**Step 3: Migrate all 27 cron registrations from ops-manager.ts**

Each inline `cron.schedule()` + `this.safeRun()` block becomes a one-liner `registry.register({...})`.

**Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/scheduler/cron-registry.test.ts && npm run typecheck`

**Step 5: Commit**

```bash
git commit -m "feat(scheduler): add centralized CronRegistry with typed definitions

- All 27 cron jobs defined in CronJobDefinition objects
- Groups: email, tracking, reports, reconciliation, maintenance, purchasing, monitoring
- safeRun() with duration tracking and Supabase cron_runs audit trail
- formatTelegramStatus() for /crons command
- 7 unit tests"
```

---

## Track 3: Bot Command Modularization

> **Why:** Most user-facing improvement. Each command becomes independently testable and discoverable.

### Task 3.1: Create command interface and router

**Files:**
- Create: `src/cli/commands/types.ts`
- Create: `src/cli/commands/index.ts`

```typescript
// src/cli/commands/types.ts
/**
 * @file    types.ts
 * @purpose Shared interface for all bot command modules.
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 */

import type { Context, Telegraf } from 'telegraf';

export interface BotCommand {
    name: string;
    description: string;
    handler: (ctx: Context, deps: BotDeps) => Promise<void>;
}

export interface BotDeps {
    bot: Telegraf;
    finale: import('../../lib/finale/client').FinaleClient;
    opsManager: import('../../lib/intelligence/ops-manager').OpsManager;
    watchdog: import('../../lib/slack/watchdog').SlackWatchdog | null;
    chatHistory: Record<number, any[]>;
    chatLastActive: Record<number, number>;
}
```

### Task 3.2: Extract /status, /memory, /crons, /clear

**Files:**
- Create: `src/cli/commands/status.ts`
- Move from `start-bot.ts` lines ~140-266

### Task 3.3: Extract /product, /receivings, /stock

**Files:**
- Create: `src/cli/commands/inventory.ts`
- Move from `start-bot.ts` lines ~268-500

### Task 3.4: Extract /buildrisk, /lead, /ap

**Files:**
- Create: `src/cli/commands/operations.ts`
- Move from `start-bot.ts` lines ~500-700

### Task 3.5: Extract approval callback handlers

**Files:**
- Create: `src/cli/commands/approvals.ts`
- Move callback_query handling from `start-bot.ts`

### Task 3.6: Wire router in start-bot.ts

Replace individual `bot.command()` blocks with:
```typescript
import { allCommands } from './commands';

for (const cmd of allCommands) {
    bot.command(cmd.name, (ctx) => cmd.handler(ctx, deps));
}
```

**Step: Run typecheck + verify bot starts**

Run: `npm run typecheck`
Then: Manual test by starting the bot temporarily

**Commit:**
```bash
git commit -m "refactor(bot): modularize Telegram commands into focused modules

- Extract status, inventory, operations, and approval commands
- start-bot.ts reduced from 2,427 to ~500 lines
- Each command module independently importable and testable
- Zero behavior change"
```

---

## Track 4: Error Tracking & Learning Memory Improvements

> **Why:** Currently errors are logged to console and occasionally queued to ops_agent_exceptions. No pattern detection, no learning from recurring failures.

### Task 4.1: Structured error tracker

**Files:**
- Create: `src/lib/intelligence/error-tracker.ts`
- Test: `src/lib/intelligence/error-tracker.test.ts`

**Step 1: Write the failing test**

```typescript
// src/lib/intelligence/error-tracker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
    createClient: vi.fn(() => ({
        from: vi.fn(() => ({
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
    })),
}));

import { ErrorTracker, type TrackedError } from './error-tracker';

describe('ErrorTracker', () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
        tracker = new ErrorTracker();
    });

    it('should track an error and store context', async () => {
        const err: TrackedError = {
            agent: 'APAgent',
            operation: 'classifyEmail',
            error: new Error('API timeout'),
            severity: 'medium',
            context: { emailId: 'abc123' },
        };
        await tracker.track(err);
        const recent = tracker.getRecentErrors(1);
        expect(recent).toHaveLength(1);
        expect(recent[0].agent).toBe('APAgent');
    });

    it('should detect recurring patterns (3+ in window)', async () => {
        for (let i = 0; i < 3; i++) {
            await tracker.track({
                agent: 'TrackingAgent',
                operation: 'fetchFedEx',
                error: new Error('FedEx auth failed'),
                severity: 'medium',
            });
        }
        const patterns = tracker.detectPatterns(1);
        expect(patterns).toHaveLength(1);
        expect(patterns[0].agent).toBe('TrackingAgent');
        expect(patterns[0].count).toBeGreaterThanOrEqual(3);
    });

    it('should dedup same error within 5 minute window', async () => {
        const err: TrackedError = {
            agent: 'Supervisor',
            operation: 'supervise',
            error: new Error('connection refused'),
            severity: 'low',
        };
        await tracker.track(err);
        await tracker.track(err);
        await tracker.track(err);
        const recent = tracker.getRecentErrors(10);
        // Should have 1 entry with count=3, not 3 entries
        expect(recent).toHaveLength(1);
        expect(recent[0].count).toBe(3);
    });

    it('should auto-escalate repeated medium errors to high', () => {
        for (let i = 0; i < 5; i++) {
            tracker.track({
                agent: 'EmailIngestion',
                operation: 'run',
                error: new Error('Gmail quota'),
                severity: 'medium',
            });
        }
        const patterns = tracker.detectPatterns(1);
        expect(patterns[0].escalatedSeverity).toBe('high');
    });

    it('should format Telegram error report', () => {
        tracker.track({
            agent: 'APAgent',
            operation: 'forward',
            error: new Error('Bill.com 503'),
            severity: 'high',
        });
        const report = tracker.formatErrorReport();
        expect(report).toContain('APAgent');
        expect(report).toContain('Bill.com 503');
    });
});
```

**Step 2: Write implementation**

```typescript
// src/lib/intelligence/error-tracker.ts
/**
 * @file    error-tracker.ts
 * @purpose Structured error tracking with pattern detection, dedup,
 *          severity escalation, and Telegram reporting.
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    supabase (for persistent storage)
 */

export interface TrackedError {
    agent: string;
    operation: string;
    error: Error;
    severity: 'low' | 'medium' | 'high' | 'critical';
    context?: Record<string, any>;
}

export interface ErrorPattern {
    agent: string;
    operation: string;
    message: string;
    count: number;
    firstSeen: Date;
    lastSeen: Date;
    escalatedSeverity: 'low' | 'medium' | 'high' | 'critical';
}

interface ErrorEntry {
    agent: string;
    operation: string;
    message: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    context?: Record<string, any>;
    timestamp: Date;
    count: number;
}

export class ErrorTracker {
    private entries: ErrorEntry[] = [];
    private readonly DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    async track(err: TrackedError): Promise<void> { /* ... */ }
    getRecentErrors(limit: number): ErrorEntry[] { /* ... */ }
    detectPatterns(windowHours?: number): ErrorPattern[] { /* ... */ }
    formatErrorReport(): string { /* ... */ }
}
```

**Step 3: Run tests**

Run: `npx vitest run src/lib/intelligence/error-tracker.test.ts`

**Step 4: Integrate with safeRun in CronRegistry**

Modify `CronRegistry.executeJob()` to call `errorTracker.track()` on failures.

**Commit:**
```bash
git commit -m "feat(errors): add structured ErrorTracker with pattern detection

- In-memory error store with 5-minute dedup window
- Pattern detection: 3+ same agent+operation failures in window
- Auto-escalation: repeated medium errors → high
- Telegram report formatting
- 5 unit tests"
```

### Task 4.2: Enhance memory learning loop

**Files:**
- Modify: `src/lib/intelligence/feedback-loop.ts`
- Create: `src/lib/intelligence/feedback-loop.test.ts`

**Improvements:**
1. Test `buildLearningStatement()` for all 4 categories (correction, prediction, vendor_reliability, error_pattern)
2. Wire `ErrorTracker.track()` into `recordFeedback()` so errors become learning events
3. Active learning queries — before decisions, agents call `recallSimilarErrors()`
4. Surface drift alerts in morning heartbeat, not just weekly Kaizen

**Tests:**

```typescript
// src/lib/intelligence/feedback-loop.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../supabase', () => ({
    createClient: vi.fn(() => ({
        from: vi.fn(() => ({
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
    })),
}));

vi.mock('./memory', () => ({
    remember: vi.fn().mockResolvedValue('mock-id'),
}));

import { buildLearningStatement } from './feedback-loop';

describe('buildLearningStatement', () => {
    it('should build correction learning for user rejection', () => {
        const event = {
            category: 'correction',
            user_action: 'rejected',
            event_type: 'reconciliation',
            subject_id: 'ULINE',
            prediction: { action: 'auto_approve', confidence: 0.85 },
            actual_outcome: { action: 'manual_review' },
        };
        const stmt = buildLearningStatement(event as any);
        expect(stmt).toContain('LEARNED');
        expect(stmt).toContain('rejected');
    });

    it('should build vendor reliability statement', () => {
        const event = {
            category: 'vendor_reliability',
            event_type: 'late_delivery',
            subject_id: 'TeraGanix',
            accuracy_score: 0.3,
            actual_outcome: { days_late: 5 },
        };
        const stmt = buildLearningStatement(event as any);
        expect(stmt).toContain('VENDOR UPDATE');
        expect(stmt).toContain('TeraGanix');
    });

    it('should return null for unsupported event categories', () => {
        expect(buildLearningStatement({ category: 'engagement' } as any)).toBeNull();
    });
});
```

**Commit:**
```bash
git commit -m "feat(feedback): add tests for learning loop + error-to-learning bridge

- 3 unit tests for buildLearningStatement()
- ErrorTracker → feedback_events integration
- recallSimilarErrors() helper for active learning"
```

---

## Track 5: Test Coverage Foundation

### Task 5.1: Tracking service tests
Already covered in Track 1 — 15+ tests.

### Task 5.2: Cron registry tests
Already covered in Track 2 — 7 tests.

### Task 5.3: Feedback loop tests
Already covered in Track 4 — 3+ tests.

### Task 5.4: PO correlator / reconciler edge case tests

**Files:**
- Existing: `src/lib/finale/reconciler.test.ts` (already has 17 tests)
- Add to existing file:

```typescript
describe('reconcileInvoiceToPO - PO matching', () => {
    it('should match by exact PO number in invoice reference field');
    it('should match by vendor name + total within 5% tolerance');
    it('should prefer exact PO# match over fuzzy vendor match');
    it('should return null when no PO matches');
    it('should handle invoices with no line items gracefully');
});
```

### Task 5.5: Tracking-service integration test (mocked APIs)

**Files:**
- Create: `src/lib/carriers/tracking-service.integration.test.ts`

```typescript
describe('getTrackingStatus - FedEx API', () => {
    it('should return delivered status from FedEx API response');
    it('should handle expired OAuth token and re-authenticate');
    it('should return null when FedEx credentials are missing');
});

describe('getTrackingStatus - EasyPost fallback', () => {
    it('should use EasyPost for non-FedEx parcels');
    it('should handle EasyPost billing errors gracefully');
});
```

---

## Execution Order (Recommended)

```
Track 1 → Track 2 → Track 5.1+5.2 → Track 4 → Track 3 → Track 5.3+5.4+5.5
  │           │           │              │          │            │
  └ 1 day     └ 1 day     └ 0.5 day      └ 1 day   └ 1.5 days   └ ongoing
```

**Total estimated:** ~5-6 focused sessions

**Dependency chain:**
- Track 1 (tracking) is fully independent — start here
- Track 2 (cron) is independent — can parallel with Track 1
- Track 3 (bot) depends on Track 2 (commands need registry ref)
- Track 4 (errors) depends on Track 2 (errors recorded via registry)
- Track 5 (tests) runs alongside each track

---

## Success Metrics

After all tracks complete:
- [ ] `ops-manager.ts` drops from 2,715 lines to ~1,200
- [ ] `start-bot.ts` drops from 2,427 lines to ~500
- [ ] `/crons` shows all 27 jobs with group, schedule, last-run, and status
- [ ] Test coverage on extracted modules: 90%+
- [ ] Error patterns detected and surfaced in morning heartbeat
- [ ] Any developer can run `npx vitest` and see green across all business logic
