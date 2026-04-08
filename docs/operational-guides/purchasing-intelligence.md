# Purchasing Intelligence Operational Guide

## Overview

The Purchasing Intelligence system automates the process of identifying what to reorder by:

1. Scraping the Finale purchasing dashboard (basauto.vercel.app/purchases)
2. Cross-referencing scraped items against Finale inventory (stock, velocity, lead time, open POs)
3. Including pending purchase requests from the team
4. Classifying each item as **HIGH_NEED**, **MEDIUM**, **LOW**, or **NOISE**
5. Diffing against the previous run to detect new urgent items
6. Sending Telegram alerts for new HIGH_NEED items and new pending requests
7. Persisting a daily snapshot to Supabase for historical analysis

## Schedule

- **Automated run**: Every Monday–Friday at 9:00 AM (America/Denver timezone)
- **Manual trigger**: Use Telegram command `/purchases` for a full pipeline run
- **Scrape-only**: Use Telegram command `/scrape_purchasing_dashboard` for a fresh data pull

## Cookie Expiration

The Playwright persistent session expires after 30 days (2026-05-07). If the scrape fails with "redirect to /auth/signin", you will receive a Telegram reminder to refresh the session cookie.

To refresh:
1. Open Chrome DevTools on the Finale dashboard (F12)
2. Go to Application → Storage → Cookies
3. Copy all cookie values and update `.basauto-session.json` in project root
4. Restart `aria-bot` (`pm2 restart aria-bot`)

## Configuration

Ensure these environment variables are set in `.env.local`:

```env
PLAYWRIGHT_SESSION_PATH=.basauto-session.json   # default
PLAYWRIGHT_USER_DATA_DIR=./chrome-profile      # default
TELEGRAM_CHAT_ID=...                            # where alerts go
```

## Database

Snapshots are stored in `purchasing_snapshots` table:
- `raw_purchases`: grouped vendor items (purchases-data.json format)
- `raw_requests`: pending purchase requests (filtered)
- `assessed_items`: full assessment results with necessity levels
- `new_high_need_skus`: SKUs newly classified as HIGH_NEED vs. previous
- `new_pending_requests`: newly added pending requests
- `duration_ms`, `items_processed`, `requests_processed`, etc.

## Files

- Scraper: `src/lib/scraping/purchasing-dashboard.ts`
- Snapshot helper: `src/lib/purchasing/snapshot.ts`
- Orchestration: `src/lib/intelligence/purchasing-intelligence.ts`
- Assessment: `src/cli/assess-purchases.ts`
- Telegram commands: `src/cli/commands/operations.ts` (`/purchases`, `/scrape_purchasing_dashboard`)
- OpsManager cron: `src/lib/intelligence/ops-manager.ts` (line ~342)

## Troubleshooting

- **Session expired**: Watch for Telegram reminder; follow refresh steps.
- **No data**: Ensure Finale is accessible and credentials valid.
- **Assessment errors**: Run `node --import tsx src/cli/assess-purchases.ts` manually to see logs.
- **Snapshot errors**: Check Supabase connection and table existence.

## Outputs

- `purchases-data.json`: Raw scraped data (grouped by vendor)
- `assessed-purchases.json`: Assessment results (human-readable + JSON)
- `purchasing_snapshots` DB: Historical records for diffing
