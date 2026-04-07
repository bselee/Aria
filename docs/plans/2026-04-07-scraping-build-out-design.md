# Scraping Build Out Design

## Overall Approach
Incremental Development: Run current assessment first for quick validation, then build out hardened Playwright standardization and automation pipeline using existing patterns.

## Section 1: Playwright Standardization and Browser Hardening
Create shared `src/lib/scraping/browser-manager.ts` as a TypeScript singleton class:

### Class Structure
- `launchBrowser(options)`: Launches headless Chrome with production flags (--no-sandbox, --disable-dev-shm-usage), supports cookie injection from env vars or JSON files, and runs in persistent contexts for session reuse (similar to `reconcile-uline.ts`)
- `checkSession`: Validates active session by loading a test URL; returns true/false and estimates expiry based on redirect patterns
- Error handling stack: Retry failed page loads (up to 3 attempts with exponential backoff), log errors with timestamps to console/file, and throw unrecoverable errors (e.g., authentication failures) for upstream handling
- Integration: Wire into ALL existing scraping scripts (purchasing dashboard, ULINE details, FedEx CSV, etc.) to standardize browser management and reduce code duplication

### Browser Flags and Security
- default: headless mode, disable sandbox, share dev shm (for Windows compatibility)
- custom options support: user-agent overrides, viewport settings, proxy configs
- Session persistence: Reuse browser contexts across scraper runs to avoid re-authentication

## Section 2: Execute and Extend Assess-Purchases Pipeline
Immediate actions:
- Run `node --import tsx src/cli/assess-purchases.ts` against `purchases-data.json`
- Cross-reference 38 scraped items via `getPurchasingIntelligence()` calls (stock/velocity/POs/lead times)
- Classify output: HIGH_NEED / MEDIUM / LOW / NOISE with console + JSON summaries

### Extensions
- Add SKU matching: Use fuzzy matcher from Slack watchdog to map scraped item "details" strings to Finale SKUs
- Filtering: Process only `status === 'Pending'` items to avoid re-assessing ordered requests
- Comparison logic: Diff classifications against Finale reality-check to eliminate dashboard noise
- Output: Enhanced JSON with matched SKUs, urgency scores, and deduped needs

## Section 3: Wire Full Automation Pipeline
Integrate hardened flow into OpsManager cron schedule (Mon-Fri 9:00 AM MST):

### Cron Workflow
1. Scrape: Execute purchasing dashboard scrape using new browser-manager
2. Assess: Run extended assess-purchases.ts against fresh data
3. Diff: Compare results against previous Supabase snapshot (table: purchasing_dash_snapshots?)
4. Notify: Telegram alert for new HIGH_NEED items and new Pending requests only

### Bot Integration
- Add `/scrape_purchasing_dashboard` tool in `start-bot.ts` for manual on-demand execution
- Uses same assessment pipeline, returns live results via chat

### Session Management
- Expiry monitoring: On scrape failure with /auth/signin redirect, send Telegram notification: "Purchasing dashboard session expired (2026-05-07). Refresh .basauto-session.json in DevTools."
- Refresh flow: Document step-by-step renewal process in repo README

## Success Criteria
- Purchasing dashboard scraping runs reliably without session issues
- assess-purchases.ts accurately filters "real" needs from dashboard noise
- all HIGH_NEED/Pending items trigger automated notifications
- reusable browser utilities enable future scraping without code duplication

Approved: 2026-04-07