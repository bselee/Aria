# Aria DB Ownership: PostgreSQL vs SQLite

*Written 2026-08-11 — snapshot, not contract. Update as schema evolves.*

---

## PostgreSQL (PostgREST on aria-db :5433)

**Role:** Operational record, audit trail, sync target. The "canonical" store for data shared across processes.

| Table | Purpose | Critical Path? |
|---|---|---|
| `cron_runs` | Cron job execution audit (159k+ rows as of 2026-08-11) | Yes — control plane |
| `email_inbox_queue` | Email processing pipeline | Conditional — when PostgREST is up |
| `purchase_orders` | Core PO data, lifecycle state, line items | Yes — primary source |
| `agent_task` | Agent task queue | Yes — multi-agent dispatch |
| `task_history` | Agent task execution history | No — observability |
| `agent_heartbeats` | Agent liveness | No — ops monitoring |
| `ops_control_requests` | Control plane commands | Yes |
| `vendor_contacts` | Vendor contact metadata | Reference |
| `vendor_emails` | Vendor email routing | Reference |

**Maintenance:** `scripts/prune-retention.js` (nightly 3am MT)
- Batched DELETE of cron_runs > 14d and email_inbox_queue > 30d
- VACUUM FULL + ANALYZE reclaims bloat
- Budget: 180s

---

## SQLite (aria-local.db in project root)

**Role:** Local-first, crash-safe cache and critical-path primary store. Survives PostgREST outages.

| Table | Purpose | Critical Path? |
|---|---|---|
| `ap_local_forwards` | **LOCAL-FIRST** AP invoice forwarding (replaced PG `ap_inbox_queue` for critical path) | **Yes** |
| `ap_activity_log` | Activity/intent logging | Yes — audit |
| `po_lifecycle_cache` | Crash-safe PO lifecycle transitions (written BEFORE PG) | **Yes** |
| `sync_queue` | SQLite → PostgREST async sync | Yes — data integrity |
| `dedup_cache` | Persistent dedup (survives restarts) | Yes |
| `receiving_cache` | Finale PO receiving data (TTL) | Conditional |
| `shipments_cache` | Tracking data cache | Conditional |
| `po_cache` | PO data cache (1h TTL) | No — read-through |
| `invoice_cache` | Invoice data cache (24h TTL) | No — read-through |
| `billcom_bills_ref` | Bill.com reference/dedup data | Reference |
| `browserbase_sessions` | Browser automation usage tracking | No |
| `cognitive_rounds` | Cognitive decision log | No — observability |
| `sys_chat_logs` | Chat conversation log | No |
| `purchasing_calendar_events` | Calendar sync state | Conditional |

**Maintenance:** WAL checkpoint (see below). No cron job — `WAL` auto-checkpoints on commit, but long-running processes can accumulate large WAL files.

---

## WAL Checkpoint

- **Journal mode:** WAL (`PRAGMA journal_mode = WAL`)
- **File:** `aria-local.db-wal` — may grow large if aria-bot runs without checkpoints
- **Current:** 4.0 MB (healthy) — was 1.1 GB before 2026-08-11 checkpoint
- **Checkpoint command:** Connect with `better-sqlite3`, run `PRAGMA wal_checkpoint(TRUNCATE)` then close
- **Frequency:** Manual only. No cron job. Run if WAL exceeds ~500 MB

---

## Migration Trend

SQLite is the **local-first primary** for critical-path operations. PostgreSQL remains the **sync target** and **multi-process shared state**. When PostgREST is down:
- AP forwarding still works (SQLite `ap_local_forwards` → sync queue retries)
- Activity logging still works (SQLite `ap_activity_log`)
- PO lifecycle transitions still work (SQLite `po_lifecycle_cache`)

Rule of thumb: **new critical-path data → SQLite first, then PG via sync_queue.**