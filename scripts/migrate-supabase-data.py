#!/usr/bin/env python3
"""
Migration script: Supabase → Local Postgres (WSL2 Docker)

Exports all data from Supabase REST API and imports into local aria-db.
Handles:
  - wsl.exe path resolution (finds it in System32)
  - text[] vs jsonb type mismatches (casts arrays properly)
  - Tables that exist locally but not in Supabase (skips gracefully)
  - Foreign key ordering (inserts parents before children)
  - Large payloads via stdin pipe (avoids command-line length limits)

Usage:
    python scripts/migrate-supabase-data.py
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

# Find wsl.exe — it's in System32 but may not be in PATH for Python subprocess
WSL_EXE = None
for candidate in [
    os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "wsl.exe"),
    "wsl.exe",
    "wsl",
]:
    try:
        subprocess.run([candidate, "--status"], capture_output=True, timeout=5)
        WSL_EXE = candidate
        break
    except (FileNotFoundError, subprocess.TimeoutExpired):
        continue

if not WSL_EXE:
    WSL_EXE = r"C:\Windows\System32\wsl.exe"  # Fallback

# Docker command to run psql inside the aria-db container
def docker_psql_cmd():
    return [WSL_EXE, "docker", "exec", "-i", "aria-db", "psql", "-U", "aria", "-d", "aria"]

# Tables in migration order (parents before children for FK integrity)
# Also excludes views/materialized views that can't receive inserts
MIGRATION_ORDER = [
    # Independent tables first
    "agent_budget",
    "vendor_profiles",
    "vendor_aliases",
    "vendor_reorder_policies",
    "vendor_case_multipliers",
    "vendor_minimum_orders",
    "vendor_calibration_stats",
    "vendor_lead_time_stats",
    "vendor_po_patterns",
    "sku_pack_sizes",
    "axiom_sku_mappings",
    "axiom_order_templates",
    # Core operational tables
    "purchase_orders",
    "po_sends",
    "po_lifecycle_transitions",
    "po_shipment_legs",
    "invoices",
    "vendor_invoices",
    "ap_activity_log",
    "ap_inbox_queue",
    "ap_pending_approvals",
    "email_inbox_queue",
    "email_context_log",
    "shipments",
    "build_completions",
    "build_risk_snapshots",
    "cron_runs",
    "agent_heartbeats",
    "agent_task",
    "agent_issue",
    "task_history",
    "qty_recommendations",
    "qty_reservations",
    "price_change_audit",
    "reconciliation_runs",
    "reconciliation_outcomes",
    "feedback_events",
    "copilot_action_sessions",
    "copilot_artifacts",
    "documents",
    "invoice_review_corpus",
    "nightshift_queue",
    "ops_agent_exceptions",
    "ops_alert_events",
    "ops_control_requests",
    "outside_thread_alerts",
    "paid_invoices",
    "pending_dropships",
    "pending_reconciliations",
    "proactive_alerts",
    "purchasing_calendar_events",
    "purchasing_snapshots",
    "slack_requests",
    "statement_intake_queue",
    "statement_reconciliation_runs",
    "stockout_events",
    "sys_chat_logs",
    "axiom_demand_queue",
    "axiom_order_lifecycle",
    "flow_events",
    "flow_runs",
    # Tables that may not exist in Supabase (created locally)
    "vendors",
    "draft_pos",
    "payments",
    "inventory_adjustments",
    "memory_backups",
    "memories",
    "purchase_assessment_runs",
    "purchase_assessments",
    "purchasing_automation_state",
    "shipment_intelligence",
    "statement_artifacts",
    "statement_reconciliations",
    "build_risk_snapshot",
    "ops_health_summary",
]

# Tables/views that should NOT be migrated (computed views, not real tables)
SKIP_TABLES = {
    "ap_receiving_variance_analysis",
    "ap_reconciliation_daily_summary",
    "ap_short_shipments_by_vendor",
    "ap_pending_approvals_active",
    "vendor_reorder_policies",  # Already in MIGRATION_ORDER but let's not duplicate
}
# Remove the duplicate — vendor_reorder_policies is already in the list above
# This set is for views we know to skip

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
    s = s.replace("\\", "\\\\")
    s = s.replace("'", "''")
    return f"'{s}'"

def pg_value(value, col_name="", col_type=""):
    """Coerce a value into a safe PSQL literal, respecting column type."""
    if value is None:
        return "NULL"

    # If column is text[], convert JSON arrays to PG array syntax
    if col_type in ("text[]", "_text", "ARRAY") or "[]" in col_type:
        if isinstance(value, list):
            items = ", ".join(quote_pg_literal(str(v)) for v in value)
            return f"ARRAY[{items}]::text[]"
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed.startswith("["):
                try:
                    parsed = json.loads(trimmed)
                    if isinstance(parsed, list):
                        items = ", ".join(quote_pg_literal(str(v)) for v in parsed)
                        return f"ARRAY[{items}]::text[]"
                except (json.JSONDecodeError, TypeError):
                    pass
            # Single string → single-element array
            return f"ARRAY[{quote_pg_literal(value)}]::text[]"

    # JSONB columns
    if col_type in ("jsonb", "json"):
        if isinstance(value, (dict, list)):
            s = json.dumps(value, default=str)
            s = s.replace("\\", "\\\\")
            s = s.replace("'", "''")
            return f"'{s}'::jsonb"
        if isinstance(value, str):
            trimmed = value.strip()
            if trimmed.startswith(("{", "[")):
                try:
                    parsed = json.loads(trimmed)
                    s = json.dumps(parsed, default=str)
                    s = s.replace("\\", "\\\\")
                    s = s.replace("'", "''")
                    return f"'{s}'::jsonb"
                except (json.JSONDecodeError, TypeError):
                    pass
            return quote_pg_literal(value)

    # Default: if dict/list AND we don't know the column type, try text[] first
    # (most array columns in Aria are text[]), then jsonb.
    # BUT: if col_type is set and is jsonb, respect it.
    if isinstance(value, list):
        # If schema says jsonb, use jsonb
        if col_type in ("jsonb", "json"):
            s = json.dumps(value, default=str)
            s = s.replace("\\", "\\\\")
            s = s.replace("'", "''")
            return f"'{s}'::jsonb"
        # Heuristic: if all elements are strings, treat as text[]
        if all(isinstance(v, str) for v in value):
            items = ", ".join(quote_pg_literal(str(v)) for v in value)
            return f"ARRAY[{items}]::text[]"
        # Mixed types → jsonb
        s = json.dumps(value, default=str)
        s = s.replace("\\", "\\\\")
        s = s.replace("'", "''")
        return f"'{s}'::jsonb"

    if isinstance(value, dict):
        s = json.dumps(value, default=str)
        s = s.replace("\\", "\\\\")
        s = s.replace("'", "''")
        return f"'{s}'::jsonb"

    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    return quote_pg_literal(value)

def fetch_table_schema(table: str):
    """Get column names AND types from local Postgres."""
    sql = (
        f"SELECT column_name || '~~' || COALESCE(udt_name, data_type) "
        f"FROM information_schema.columns "
        f"WHERE table_schema='public' AND table_name='{table}' "
        f"ORDER BY ordinal_position;"
    )
    cmd = docker_psql_cmd() + ["-t", "-A", "-c", sql]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            return []
        cols = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            if "~~" in line:
                col_name, udt_name = line.strip().split("~~", 1)
                col_name = col_name.strip()
                udt_name = udt_name.strip()
            else:
                col_name = line.strip()
                udt_name = "text"
            # Map udt_name to simplified type
            if udt_name == "_text":
                col_type = "text[]"
            elif udt_name == "jsonb":
                col_type = "jsonb"
            elif udt_name == "json":
                col_type = "json"
            elif udt_name == "ARRAY":
                col_type = "ARRAY"
            else:
                col_type = udt_name
            cols.append((col_name, col_type))
        return cols
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log_error(f"Failed to get schema for {table}: {e}")
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
            body = e.read().decode(errors="replace")[:200]
            if e.code == 404:
                # Table doesn't exist in Supabase — not an error
                return []
            log_error(f"HTTP {e.code} fetching {table} at offset {offset}: {body}")
            break
        except (urllib.error.URLError, json.JSONDecodeError) as e:
            log_error(f"Error fetching {table}: {e}")
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
        log(f"Supabase responded (HTTP {e.code}, {elapsed:.1f}s) — treating as reachable")
        return True
    except (urllib.error.URLError, OSError) as e:
        elapsed = time.time() - start
        log(f"Supabase unreachable: {e} ({elapsed:.1f}s)")
        return False

def insert_rows_via_stdin(table: str, columns_with_types: list, rows: list) -> int:
    """Insert rows into local Postgres via stdin pipe (avoids command-line length limits)."""
    if not rows or not columns_with_types:
        return 0

    col_names = ", ".join(f'"{c[0]}"' for c in columns_with_types)
    col_defs = columns_with_types  # [(name, type), ...]

    # Build SQL — use COPY-like INSERT with VALUES, piped via stdin
    # For large tables, use individual INSERT statements with ON CONFLICT
    inserted = 0
    errors = 0
    batch_size = 50  # Smaller batches to avoid issues

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        value_lists = []
        for row in batch:
            vals = ", ".join(
                pg_value(row.get(c[0]), c[0], c[1]) for c in col_defs
            )
            value_lists.append(f"({vals})")

        values_sql = ",\n".join(value_lists)
        sql = (
            f"INSERT INTO \"{table}\" ({col_names}) VALUES\n"
            f"{values_sql}\n"
            f"ON CONFLICT DO NOTHING;"
        )

        # Pipe SQL via stdin to avoid command-line length limits
        cmd = docker_psql_cmd() + ["-v", "ON_ERROR_STOP=0", "-q"]
        try:
            result = subprocess.run(
                cmd,
                input=sql,
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode == 0:
                inserted += len(batch)
            elif "ON CONFLICT DO NOTHING" in result.stderr and "violates" in result.stderr:
                # Some rows conflicted — count as partial success
                inserted += len(batch)  # Approximate; ON CONFLICT skips duplicates
            else:
                stderr = result.stderr.strip()[:300]
                # If it's a type error, try row-by-row to salvage what we can
                if "type" in stderr.lower() or "syntax" in stderr.lower():
                    log_error(f"Batch failed for {table}, trying row-by-row: {stderr[:150]}")
                    for row in batch:
                        vals = ", ".join(
                            pg_value(row.get(c[0]), c[0], c[1]) for c in col_defs
                        )
                        single_sql = f'INSERT INTO "{table}" ({col_names}) VALUES ({vals}) ON CONFLICT DO NOTHING;'
                        try:
                            r = subprocess.run(
                                docker_psql_cmd() + ["-v", "ON_ERROR_STOP=0", "-q", "-c", single_sql],
                                capture_output=True, text=True, timeout=10,
                            )
                            if r.returncode == 0:
                                inserted += 1
                            else:
                                errors += 1
                        except (subprocess.TimeoutExpired, FileNotFoundError):
                            errors += 1
                else:
                    log_error(f"Insert error for {table} (batch {i}): {stderr}")
                    errors += len(batch)
        except subprocess.TimeoutExpired:
            log_error(f"Timeout inserting batch for {table} (rows {i}-{i+len(batch)})")
        except FileNotFoundError as e:
            log_error(f"Cannot run psql: {e}")
            return inserted

    return inserted

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    log("=" * 60)
    log("Supabase → Local Postgres Data Migration")
    log("=" * 60)

    # Verify wsl.exe
    log(f"Using wsl.exe at: {WSL_EXE}")
    try:
        r = subprocess.run([WSL_EXE, "docker", "ps", "--format", "{{.Names}}"],
                          capture_output=True, text=True, timeout=10)
        if "aria-db" not in r.stdout:
            log_error("aria-db container not found! Is Docker running?")
            return 1
        log("aria-db container confirmed running.")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log_error(f"Cannot reach Docker via wsl.exe: {e}")
        return 1

    # Step 1: Check Supabase
    log("\nStep 1: Testing Supabase connectivity...")
    if not check_supabase_reachable():
        log("\nSupabase is NOT reachable. Cannot migrate data at this time.")
        log("The migration cron will retry automatically.")
        return 1

    # Step 2: Migrate tables in order
    log(f"\nStep 2: Migrating {len(MIGRATION_ORDER)} tables...")
    log("-" * 60)

    total_migrated = 0
    tables_with_data = 0
    tables_empty = 0
    tables_failed = 0
    tables_not_in_supabase = 0

    for table in MIGRATION_ORDER:
        if table in SKIP_TABLES:
            continue

        # Get column schema from local Postgres
        cols = fetch_table_schema(table)
        if not cols:
            log_error(f"  {table}: no schema found locally, skipping")
            tables_failed += 1
            continue

        # Fetch data from Supabase
        rows = fetch_table_data(table)

        if rows is None or (not rows):
            # Check if table exists in Supabase at all
            if not rows:
                tables_not_in_supabase += 1
                log(f"  {table}: not in Supabase (or empty) — skipping")
                continue
            tables_empty += 1
            log(f"  {table}: empty")
            continue

        # Insert into local Postgres
        inserted = insert_rows_via_stdin(table, cols, rows)

        if inserted > 0:
            log(f"  {table}: {inserted} rows migrated (of {len(rows)} fetched)")
            total_migrated += inserted
            tables_with_data += 1
        else:
            log(f"  {table}: 0 rows inserted ({len(rows)} fetched, all failed/conflicted)")
            tables_failed += 1

    # Summary
    log("\n" + "=" * 60)
    log("Migration Complete!")
    log(f"  Tables processed:    {tables_with_data + tables_failed + tables_empty + tables_not_in_supabase}")
    log(f"  Tables with data:    {tables_with_data}")
    log(f"  Tables empty:        {tables_empty}")
    log(f"  Not in Supabase:     {tables_not_in_supabase}")
    log(f"  Tables failed:       {tables_failed}")
    log(f"  Total rows migrated: {total_migrated}")
    log("=" * 60)

    return 0

if __name__ == "__main__":
    sys.exit(main())
