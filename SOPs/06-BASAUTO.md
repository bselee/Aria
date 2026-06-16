# 06 — BASAUTO Cross-Reference Polling

**Domain:** External Purchasing Data (basauto.vercel.app)  
**Owner:** aria-purchasing  
**Last Updated:** 2026-06-15

## Flow
- Cron `basauto-poll` runs at 6 AM via `scripts/basauto_poll.py`
- Session token: `~/AppData/Local/hermes/cache/basauto/session-token.txt` (30d cookie)
- Oracle wins on BOM items
- BASAUTO catches supplies (BAS101 / CSW102)
- Results funnel through same TG path as Slack

**Related Skill:** `purchases-crawl`

---
**Status:** Basic flow documented.