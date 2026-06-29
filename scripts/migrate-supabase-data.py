#!/usr/bin/env python3
"""
Migration script: Supabase → Local Postgres (WSL2 Docker)

Tests if Supabase is reachable. If so, exports all data table-by-table via the
Supabase REST API and imports into the local aria-db Postgres container.
If Supabase is down, logs which tables need manual migration and exits gracefully.

Usage:
    python scripts/migrate-supabase-data.py

Requires: Python 3.11+, urllib (stdlib), subprocess (stdlib), wsl.exe (on Windows)
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ─── Configuration ───────────────────────────────────────────────────────────

SUPABASE_URL = "https://wvpgkyrbhvywdxnuxymn.supabase.co"
SERVICE_ROLE_KEY = ""

# Docker command prefix — uses wsl.exe to reach the WSL2 Docker daemon
DOCKER_CMD = ["wsl.exe", "docker", "exec", "aria-db", "psql", "-U", "aria", "-d", "aria"]

# Tables to migrate (in priority order)
PRIORITY_TABLES = [
    "purchase_orders",
    "ap_activity_log",
    "vendor_invoices",
    "vendor_profiles",
    "invoices",
    "email_inbox_queue",
    "ap_inbox_queue",
    "po_sends",
    "shipments",
    "vendor_aliases",
    "agent_heartbeats",
    "cron_runs",
    "build_risk_snapshots",
    "vendor_reorder_policies",
    "vendor_lead_time_stats",
    "qty_recommendations",
    "slack_requests",
    "task_history",
    "agent_task",
    "agent_budget",
]

# All 77 tables
ALL_TABLES = sorted([
    "agent_budget", "agent_heartbeats", "agent_issue", "agent_task",
    "ap_activity_log", "ap_inbox_queue", "ap_pending_approvals",
    "ap_pending_approvals_active", "ap_receiving_variance_analysis",
    "ap_reconciliation_daily_summary", "ap_short_shipments_by_vendor",
    "axiom_demand_queue", "axiom_order_lifecycle", "axiom_order_templates",
    "axiom_sku_mappings", "build_completions", "build_risk_snapshot",
    "build_risk_snapshots", "copilot_action_sessions", "copilot_artifacts",
    "cron_runs", "documents", "draft_pos", "email_context_log",
    "email_inbox_queue", "feedback_events", "flow_events", "flow_runs",
    "inventory_adjustments", "invoice_review_corpus", "invoices",
    "memories", "memory_backups", "nightshift_queue",
    "ops_agent_exceptions", "ops_alert_events", "ops_control_requests",
    "ops_health_summary", "outside_thread_alerts", "paid_invoices",
    "payments", "pending_dropships", "pending_reconciliations",
    "po_lifecycle_transitions", "po_sends", "po_shipment_legs",
    "price_change_audit", "proactive_alerts", "purchase_assessment_runs",
    "purchase_assessments", "purchase_orders", "purchasing_automation_state",
    "purchasing_calendar_events", "purchasing_snapshots",
    "qty_recommendations", "qty_reservations", "reconciliation_outcomes",
    "reconciliation_runs", "shipment_intelligence", "shipments",
    "skills", "sku_pack_sizes", "slack_requests",
    "statement_intake_queue", "statement_reconciliation_runs",
    "statement_reconciliations", "stockout_events", "sys_chat_logs",
    "task_history", "vendor_aliases", "vendor_calibration_stats",
    "vendor_case_multipliers", "vendor_invoices", "vendor_lead_time_stats",
    "vendor_minimum_orders", "vendor_po_patterns", "vendor_profiles",
    "vendor_reorder_policies",
])


# ─── Helpers ─────────────────────────────────────────────────────────────────

def log(msg: str):
    print(f"[migrate] {msg}", flush=True)


def log_error(msg: str):
    print(f"[migrate] ERROR: {msg}", flush=True, file=sys.stderr)


def quote_pg_literal(value):
    """Escape a string for use in a PostgreSQL single-quoted string."""
    if value is None:
        return "NULL"
    s = str(value)
    s = s.replace("'", "''")
    s = s.replace("\\", "\\\\")
    return f"'{s}'"


def jsonb_to_pg(value):
    """Convert a Python dict/list to a PostgreSQL JSONB literal."""
    if value is None:
        return "NULL"
    s = json.dumps(value, default=str)
    s = s.replace("'", "''")
    s = s.replace("\\", "\\\\")
    return f"'{s}'::jsonb"


def pg_value(value, col_name=""):
    """Coerce a value into a safe PSQL literal."""
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        return jsonb_to_pg(value)
    # Some APIs return JSON as strings — detect if it looks like JSON for known JSONB columns
    if isinstance(value, str) and col_name in (
        "data", "metadata", "config", "payload", "context", "details",
        "state", "attributes", "snapshot", "body", "content", "extra",
        "raw_data", "analysis", "summary", "template", "mappings",
    ):
        trimmed = value.strip()
        if trimmed.startswith(("{", "[")):
            try:
                parsed = json.loads(trimmed)
                if isinstance(parsed, (dict, list)):
                    return jsonb_to_pg(parsed)
            except (json.JSONDecodeError, TypeError):
                pass
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return quote_pg_literal(value)


def fetch_table_columns(table: str) -> list:
    """Get column names from local Postgres via information_schema."""
    sql = f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position;"
    cmd = DOCKER_CMD + ["-t", "-A", "-c", sql]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            log_error(f"Failed to get columns for {table}: {result.stderr.strip()}")
            return []
        cols = [c.strip() for c in result.stdout.strip().split("\n") if c.strip()]
        return cols
    except subprocess.TimeoutExpired:
        log_error(f"Timeout getting columns for {table}")
        return []
    except FileNotFoundError:
        log_error("wsl.exe not found — is WSL installed?")
        return []


def fetch_table_data(table: str, limit: int = 10000) -> list:
    """Fetch all rows from a Supabase table via REST API."""
    rows = []
    offset = 0
    while True:
        url = f"{SUPABASE_URL}/rest/v1/{table}?limit={limit}&offset={offset}"
        req = urllib.request.Request(url)
        req.add_header("apikey", SERVICE_ROLE_KEY)
        req.add_header("Authorization", f"Bearer {SERVICE_ROLE_KEY}")
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if not data:
                    break
                rows.extend(data)
                if len(data) < limit:
                    break
                offset += limit
        except urllib.error.HTTPError as e:
            log_error(f"HTTP {e.code} fetching {table} at offset {offset}: {e.read().decode(errors='replace')[:200]}")
            break
        except urllib.error.URLError as e:
            log_error(f"URL error fetching {table}: {e.reason}")
            break
        except json.JSONDecodeError as e:
            log_error(f"JSON decode error for {table}: {e}")
            break
    return rows


def check_supabase_reachable() -> bool:
    """Test if Supabase REST API responds."""
    url = f"{SUPABASE_URL}/rest/v1/"
    req = urllib.request.Request(url)
    req.add_header("apikey", SERVICE_ROLE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_ROLE_KEY}")
    req.add_header("Accept", "application/json")
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            elapsed = time.time() - start
            log(f"Supabase reachable (HTTP {resp.status}, {elapsed:.1f}s)")
            return True
    except urllib.error.HTTPError as e:
        elapsed = time.time() - start
        log(f"Supabase responded with HTTP {e.code} ({elapsed:.1f}s) — treating as reachable")
        return True  # Even 4xx means the server is up and we can query
    except urllib.error.URLError as e:
        elapsed = time.time() - start
        log(f"Supabase unreachable: {e.reason} ({elapsed:.1f}s)")
        return False
    except OSError as e:
        elapsed = time.time() - start
        log(f"Supabase unreachable (OS error): {e} ({elapsed:.1f}s)")
        return False
    except Exception as e:
        elapsed = time.time() - start
        log(f"Supabase unreachable: {type(e).__name__}: {e} ({elapsed:.1f}s)")
        return False


def insert_rows_via_psql(table: str, columns: list, rows: list) -> int:
    """Insert rows into local Postgres via docker exec psql."""
    if not rows:
        return 0

    col_names = ", ".join(f'"{c}"' for c in columns)
    inserted = 0
    batch_size = 100  # Keep batches small to avoid command-line length limits

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        value_lists = []
        for row in batch:
            vals = ", ".join(
                pg_value(row.get(c), c) for c in columns
            )
            value_lists.append(f"({vals})")

        values_sql = ",\n".join(value_lists)
        sql = (
            f"INSERT INTO \"{table}\" ({col_names}) VALUES\n"
            f"{values_sql}\n"
            f"ON CONFLICT DO NOTHING;"
        )

        cmd = DOCKER_CMD + ["-c", sql]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0:
                inserted += len(batch)
            else:
                stderr = result.stderr.strip()
                log_error(f"Batch insert error for {table} "
                          f"(rows {i}-{i+len(batch)}): {stderr[:200]}")
        except subprocess.TimeoutExpired:
            log_error(f"Timeout inserting batch for {table} (rows {i}-{i+len(batch)})")
        except FileNotFoundError:
            log_error("wsl.exe not found — cannot run psql")
            return inserted

    return inserted


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    log("=" * 60)
    log("Supabase → Local Postgres Data Migration")
    log("=" * 60)

    # Step 1: Check if Supabase is reachable
    log("Step 1: Testing Supabase connectivity...")
    reachable = check_supabase_reachable()

    if not reachable:
        log("")
        log("!" * 60)
        log("  Supabase is NOT reachable (likely 522 / Cloudflare timeout).")
        log("  Data migration cannot proceed at this time.")
        log("")
        log("  Tables that need manual migration (once Supabase is back up):")
        log("  " + "-" * 57)
        log("  PRIORITY TABLES (most referenced in codebase):")
        for t in PRIORITY_TABLES:
            log(f"    - {t}")
        log("")
        log("  ALL TABLES (77 total):")
        for t in ALL_TABLES:
            log(f"    - {t}")
        log("")
        log("  To migrate when Supabase is available, run:")
        log("    python scripts/migrate-supabase-data.py")
        log("!" * 60)
        return 1

    # Step 2: Get all table names
    log("Step 2: Fetching table list from local Postgres...")
    tables_in_db = fetch_all_tables_from_local()

    if not tables_in_db:
        log_error("No tables found in local database!")
        return 1

    log(f"Found {len(tables_in_db)} tables in local database.")

    # Start with priority tables, then do the rest
    migrate_order = (
        [t for t in PRIORITY_TABLES if t in tables_in_db] +
        [t for t in sorted(tables_in_db) if t not in PRIORITY_TABLES]
    )

    # Step 3: Migrate each table
    total_rows = 0
    success_count = 0
    fail_count = 0

    log("")
    log("Step 3: Migrating data...")
    log("")

    for table in migrate_order:
        sys.stdout.write(f"  Processing: {table} ... ")
        sys.stdout.flush()

        # Get columns from local DB
        columns = fetch_table_columns(table)
        if not columns:
            log("SKIPPED (no columns found)")
            fail_count += 1
            continue

        # Fetch data from Supabase
        rows = fetch_table_data(table)
        if not rows:
            log(f"0 rows (table empty or unreachable)")
            continue

        # Insert into local Postgres
        inserted = insert_rows_via_psql(table, columns, rows)
        total_rows += inserted

        if inserted > 0:
            log(f"{inserted} rows migrated")
            success_count += 1
        else:
            log(f"0 rows (insert failed or all conflicted)")
            fail_count += 1

        # Small delay between tables to avoid overwhelming
        time.sleep(0.5)

    # Summary
    log("")
    log("=" * 60)
    log("Migration Complete!")
    log(f"  Tables processed: {success_count + fail_count}")
    log(f"  Tables with data: {success_count}")
    log(f"  Tables skipped:   {fail_count}")
    log(f"  Total rows migrated: {total_rows}")
    log("=" * 60)

    return 0


def fetch_all_tables_from_local() -> list:
    """Get all public table names from local Postgres."""
    sql = "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name;"
    cmd = DOCKER_CMD + ["-t", "-A", "-c", sql]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            log_error(f"Failed to list tables: {result.stderr.strip()}")
            return []
        tables = [t.strip() for t in result.stdout.strip().split("\n") if t.strip()]
        return tables
    except subprocess.TimeoutExpired:
        log_error("Timeout listing tables")
        return []
    except FileNotFoundError:
        log_error("wsl.exe not found")
        return []


if __name__ == "__main__":
    sys.exit(main())
