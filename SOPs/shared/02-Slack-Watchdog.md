# 02 — Slack Watchdog & Bill-Voice Replies

**Domain:** Slack Automation (aria-slack profile)  
**Owner:** aria-slack + aria-reviewer  
**Last Updated:** 2026-06-15

## Core Behavior
- Polls `#purchase-orders` + `#purchasing` every 60s
- Reader token: Bill (xoxp), Writer: bot
- `👀` reaction on incoming requests (Eyes-Only)
- Skips messages from `SLACK_OWNER_USER_ID`

## Decision to Respond
- **PO found** → Thread reply as Bill: "SKU PO-12345 (ETA 6/10)"
- **No PO / unknown SKU** → Silent (no TG)
- **SKU not in Finale** → Silent
- **Stale >24h** → TG DM nudge
- Record all in `slack_requests` table

## Bill Voice Rules (Strict)
- NO emojis
- ≤25 words
- No bullets
- No AI-isms
- @recipient (`<@UID>` in payload)
- PO → Finale link
- NEVER use `chat.update`
- **#purchase-orders format:** `*Ordered <link|PO-####> ETA mm/dd*` (bold + linked, one per PO)

## Morning Reports
- Posts build risk report at 7:30 AM to `#purchasing` (via `SLACK_BOT_TOKEN`)

## Verification
- `node --import tsx src/cli/start-slack.ts`

**Related Skills:** `aria-slack-reply`, `aria-reviewer`

---
**Status:** Voice enforcement centralized in aria-reviewer. Next: Full thread-reply examples.