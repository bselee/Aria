---
name: aria-browserbase-integration
description: Browserbase cloud browser integration for Aria with free-tier usage controls
tags: [aria, browserbase, browser, automation, scraping]
---

# Browserbase Cloud Browser Integration

## Overview
Aria uses Browserbase cloud browsers for automation tasks to avoid local Chrome resource issues. Free tier has 100 sessions/month, so usage is carefully controlled.

## Architecture

### BrowserbaseManager (`src/lib/scraping/browserbase-manager.ts`)
Singleton managing cloud browser sessions:
- **Session tracking**: SQLite `browserbase_sessions` table
- **Budget enforcement**: warn at 80 sessions, block at 95 (leave 5 emergency)
- **Session reuse**: 25-minute window for same task_type
- **Auto-cleanup**: Sessions expire after 30 minutes (configurable)

### Integration Points

#### BrowserManager (`src/lib/scraping/browser-manager.ts`)
```typescript
export interface BrowserOptions {
  useBrowserbase?: boolean;  // Opt-in flag
  browserbaseTaskType?: string;  // For session reuse
  // ... other options
}

const browserManager = BrowserManager.getInstance();
const page = browserManager.getPage({
  useBrowserbase: true,
  browserbaseTaskType: 'cart-filling-uline'
});
```

#### Order Flow (`src/lib/ordering/browser-order.ts`)
When `BROWSERBASE_AUTO=true` env var is set, cart-filling uses cloud browser:
```typescript
// vendor-order.ts automatically uses Browserbase for:
// - Uline cart filling
// - Axiom cart filling
// Session type: cart-filling-${vendor}
```

## Usage Controls

### Free Tier Budget
- **Monthly limit**: 100 sessions
- **Warning threshold**: 80 sessions (logs warning)
- **Hard block**: 95 sessions (throws error, falls back to local)
- **Emergency reserve**: 5 sessions (for critical tasks)

### Session Lifecycle
- **Created**: On first page request for task_type
- **Active**: 30 minutes (configurable in manager)
- **Reuse window**: 25 minutes (same task_type gets same session)
- **Cleanup**: Auto-expired by Browserbase, tracked in SQLite

### Environment Variables
```bash
# .env.local or ~/.hermes/.env
BROWSERBASE_API_KEY=***
BROWSERBASE_PROJECT_ID=5b30efa8-596e-427c-b099-4aea155b27a7

# Auto-use Browserbase for headless tasks (opt-in)
BROWSERBASE_AUTO=true

# Budget thresholds (optional, defaults shown)
BROWSERBASE_WARN_THRESHOLD=80
BROWSERBASE_BLOCK_THRESHOLD=95
```

## Database Schema

```sql
-- aria-local.db
CREATE TABLE browserbase_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  task_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  page_count INTEGER DEFAULT 1,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_bb_sessions_task_type 
  ON browserbase_sessions(task_type, expires_at);

CREATE INDEX idx_bb_sessions_expires 
  ON browserbase_sessions(expires_at);
```

## Monitoring

### Check Usage
```typescript
import { getLocalDb } from '@/lib/storage/local-db';

const db = getLocalDb();
const monthStart = new Date();
monthStart.setDate(1);
monthStart.setHours(0, 0, 0, 0);

const result = db.prepare(`
  SELECT COUNT(*) as count 
  FROM browserbase_sessions 
  WHERE created_at >= ?
`).get(monthStart.getTime() / 1000);

console.log(`Sessions this month: ${result.count}/100`);
```

### Session Types
- `cart-filling-uline` - Uline order automation
- `cart-filling-axiom` - Axiom order automation
- `web-research` - General research tasks
- `scraper-${domain}` - Domain-specific scraping

## Fallback Behavior

When Browserbase is unavailable or over budget:
1. **Budget exceeded**: Throws error, caught by BrowserManager
2. **API failure**: Logs error, falls back to local Chrome
3. **Session creation timeout**: 10-second timeout, falls back to local

BrowserManager automatically handles fallback:
```typescript
try {
  return await browserbaseManager.getPage(options);
} catch (error) {
  console.warn('Browserbase unavailable, using local Chrome');
  return await this.fallbackToLocalChrome(options);
}
```

## Best Practices

### 1. Use Descriptive Task Types
```typescript
// Good - specific task type enables reuse
browserbaseTaskType: 'cart-filling-uline-po-12345'

// Bad - too generic, no reuse benefit
browserbaseTaskType: 'automation'
```

### 2. Batch Operations
When possible, reuse sessions for multiple operations:
```typescript
// Good - single session for multiple vendors
const page = browserManager.getPage({
  useBrowserbase: true,
  browserbaseTaskType: 'multi-vendor-order'
});
await fillUlineCart(page, ...);
await fillAxiomCart(page, ...);
browserManager.releasePage(page);
```

### 3. Monitor Usage
Check budget before large batches:
```typescript
const bbManager = BrowserbaseManager.getInstance();
const remaining = bbManager.getRemainingBudget();
if (remaining < 10) {
  console.warn(`Low Browserbase budget: ${remaining} sessions left`);
  // Consider falling back to local or delaying non-critical tasks
}
```

## Troubleshooting

### Sessions Not Reusing
- Check task_type matches exactly
- Verify session hasn't expired (>30 min old)
- Check SQLite: `SELECT * FROM browserbase_sessions WHERE task_type = '...'`

### Budget Errors
- Check monthly usage: `SELECT COUNT(*) FROM browserbase_sessions WHERE created_at >= ?`
- Consider increasing thresholds in .env.local
- Or upgrade Browserbase plan

### API Failures
- Verify API key: `BROWSERBASE_API_KEY` in .env
- Check project ID: `BROWSERBASE_PROJECT_ID`
- Test connectivity: `curl https://api.browserbase.com/v1/sessions`

## Future Enhancements

1. **Session pooling**: Pre-warm sessions for common tasks
2. **Usage analytics**: Track success rates by task_type
3. **Auto-upgrade**: Switch to paid plan when hitting limits
4. **Session sharing**: Cross-process session reuse via Redis
5. **Cost tracking**: Estimate $ spent per session/task_type

## Related Files
- `src/lib/scraping/browserbase-manager.ts` - Core manager
- `src/lib/scraping/browser-manager.ts` - Integration layer
- `src/lib/ordering/browser-order.ts` - Order automation
- `src/lib/storage/local-db.ts` - Schema definition
- `.env.local` - Configuration
