# 08 — Telegram Notifications

**Domain:** Critical Alerts & Reports  
**Owner:** aria-comms  
**Last Updated:** 2026-06-15

## Rules
- `sendCriticalTelegramNotify` bypasses business-hours gate
- Morning AP health report: 8:30 AM weekdays
- TG CHAT_ID = 8531889063 (plain text only)
- Whey = Thrive Probiotics
- Non-critical use business hours gate (`aria-alert-gate` skill)

## Commands
- `/reclassify` — Flip invoice state on dashboard
- `/apsummary`, `/order`, `/vendor`, `/tracking` etc.

**Related Skill:** `aria-alert-gate`

---
**Status:** Notification rules captured.