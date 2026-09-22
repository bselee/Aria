#!/usr/bin/env bash
# @file    scripts/portability-restore.sh
# @purpose Restore an Aria + Hermes portability bundle on a (new) Windows machine.
#          Ships inside every bundle as restore.sh. Run from Git Bash.
# @usage   bash restore.sh [BUNDLE_DIR] [--force] [--dry-run]
#            BUNDLE_DIR  path to a portability-bundle-* directory
#                        (default: newest in ~/portability-bundles)
#            --force     overwrite existing target directories
#            --dry-run   print the plan without doing anything
# @deps    Node 24 LTS, PostgreSQL 16 (service postgresql-x64-16), Git Bash, PM2
# @author  Hermia
# @created 2026-08-31

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
ARIA_TARGET="${ARIA_TARGET:-$HOME/Documents/Projects/aria}"
HERMES_HOME="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes"
VAULT_TARGET="$HOME/Documents/Obsidian Vault"
BILLCOM_TARGET="$HOME/Downloads/Aria-Ingest/billcom"
FORCE=0
DRY=0

# ── Resolve bundle ───────────────────────────────────────────────────────────
BUNDLE="${1:-}"
if [[ -z "$BUNDLE" || "$BUNDLE" == --* ]]; then
  for extra in "$@"; do
    case "$extra" in
      --force) FORCE=1 ;;
      --dry-run) DRY=1 ;;
    esac
  done
  BUNDLE="$(ls -dt "$HOME_DIR/portability-bundles"/portability-bundle-* 2>/dev/null | head -1)"
fi
for extra in "$@"; do
  case "$extra" in
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
  esac
done
if [[ -z "$BUNDLE" || ! -d "$BUNDLE" ]]; then
  echo "ERROR: bundle not found. Pass a portability-bundle-* directory."
  exit 1
fi

step() { echo; echo "== $* =="; }
say() { echo "   $*"; }
need() { [[ $DRY -eq 1 ]] && say "[dry-run] would: $*" || eval "$*"; }

step "Bundle: $BUNDLE"
[[ -f "$BUNDLE/MANIFEST.json" ]] && say "Manifest present ($(du -sh "$BUNDLE" | cut -f1) bundle)"
if [[ $DRY -eq 1 ]]; then echo; echo "DRY RUN — no changes made."; exit 0; fi

# ── 0. Preflight ─────────────────────────────────────────────────────────────
step "Preflight"
NODE_VER="$(node --version 2>/dev/null || echo missing)"
say "node: $NODE_VER (need >= 22; install Node 24 LTS if missing)"
if ! command -v node >/dev/null || [[ "$NODE_VER" == missing ]]; then
  echo "  Install Node 24 LTS first: https://nodejs.org (or use a portable node24 tree)."; exit 1
fi
if ! sc query postgresql-x64-16 >/dev/null 2>&1; then
  echo "  PostgreSQL 16 service not running. Install PG16 (winget install PostgreSQL.PostgreSQL.16) and start postgresql-x64-16."; exit 1
fi
say "postgresql-x64-16: running"
command -v psql >/dev/null 2>&1 || PG_BIN="/c/Program Files/PostgreSQL/16/bin"
command -v pm2 >/dev/null 2>&1 || say "  note: pm2 not on PATH — will use npx pm2"

# ── 1. Database ──────────────────────────────────────────────────────────────
step "PostgreSQL restore"
if [[ -f "$BUNDLE/db/aria.dump" ]]; then
  PSQL="$(command -v psql || echo '/c/Program Files/PostgreSQL/16/bin/psql.exe')"
  PGRESTORE="$(command -v pg_restore || echo '/c/Program Files/PostgreSQL/16/bin/pg_restore.exe')"
  export PGPASSWORD=arialocal
  say "ensuring roles aria/anon…"
  "$PSQL" -U postgres -h 127.0.0.1 -p 5432 -d postgres -v ON_ERROR_STOP=0 \
    -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='aria') THEN CREATE ROLE aria LOGIN PASSWORD 'arialocal'; ELSE ALTER ROLE aria WITH LOGIN PASSWORD 'arialocal'; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; END \$\$;" \
    >/dev/null 2>&1 || say "  role setup skipped (run as superuser if needed)"
  say "restoring dump (pg_restore --clean --if-exists)…"
  "$PGRESTORE" -U aria -h 127.0.0.1 -p 5432 -d aria --clean --if-exists \
    -f "$BUNDLE/db/aria.dump" 2>/dev/null \
    || { say "  restore failed — ensure DB 'aria' exists (createdb -U postgres aria) then re-run"; }
  say "resyncing serial sequences (known post-restore 23505 trap)…"
  "$PSQL" -U aria -h 127.0.0.1 -p 5432 -d aria -v ON_ERROR_STOP=0 <<'SQL' >/dev/null 2>&1 || true
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schemaname, c.relname AS tablename, a.attname AS colname,
           pg_get_serial_sequence(n.nspname||'.'||c.relname, a.attname) AS seq
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
    WHERE pg_get_serial_sequence(n.nspname||'.'||c.relname, a.attname) IS NOT NULL
  LOOP
    IF r.seq IS NOT NULL THEN
      EXECUTE format('SELECT setval(%L, GREATEST((SELECT COALESCE(MAX(%I),1) FROM %I.%I), 1), true)',
        r.seq, r.colname, r.schemaname, r.tablename);
    END IF;
  END LOOP;
END $$;
SQL
  unset PGPASSWORD
  say "database restored + sequences resynced"
else
  say "no aria.dump in bundle — skipping PG restore"
fi
if [[ -f "$BUNDLE/db/aria-local.db" ]]; then
  say "restoring aria-local.db (SQLite sidecar)…"
  cp "$BUNDLE/db/aria-local.db" "$ARIA_TARGET/aria-local.db" 2>/dev/null \
    || say "  (aria repo not copied yet — sidecar will land after repo step)"
fi

# ── 2. Aria repo ─────────────────────────────────────────────────────────────
step "Aria repo"
if [[ -d "$ARIA_TARGET/.git" && $FORCE -eq 0 ]]; then
  say "repo already exists at $ARIA_TARGET — skipping (use --force to overwrite)"
elif [[ -d "$BUNDLE/aria" ]]; then
  mkdir -p "$ARIA_TARGET"
  say "copying repo (this includes .git — your branch and untracked work move with it)…"
  cp -r "$BUNDLE/aria/." "$ARIA_TARGET/"
fi

# ── 3. Secrets ───────────────────────────────────────────────────────────────
step "Secrets"
if [[ -d "$BUNDLE/secrets" ]]; then
  for f in "$BUNDLE"/secrets/*; do
    [[ -f "$f" ]] && cp "$f" "$ARIA_TARGET/$(basename "$f")" && say "  $(basename "$f")"
  done
fi

# ── 4. Storage + Obsidian ────────────────────────────────────────────────────
step "Storage + Obsidian"
[[ -d "$BUNDLE/storage/local" ]] && { mkdir -p "$ARIA_TARGET/local/storage"; cp -r "$BUNDLE/storage/local/." "$ARIA_TARGET/local/storage/"; say "local/storage restored"; }
[[ -d "$BUNDLE/storage/billcom" ]] && { mkdir -p "$BILLCOM_TARGET"; cp -r "$BUNDLE/storage/billcom/." "$BILLCOM_TARGET/"; say "Aria-Ingest/billcom restored"; }
if [[ -d "$BUNDLE/obsidian/Obsidian Vault" && ! -d "$VAULT_TARGET" ]]; then
  mkdir -p "$HOME/Documents"; cp -r "$BUNDLE/obsidian/Obsidian Vault" "$VAULT_TARGET"; say "Obsidian vault restored"
elif [[ -d "$BUNDLE/obsidian/Obsidian Vault" ]]; then
  say "vault already exists — skipping (merge manually if needed)"
fi

# ── 5. Hermes user data ──────────────────────────────────────────────────────
step "Hermes user data"
if [[ -d "$BUNDLE/hermes" ]]; then
  mkdir -p "$HERMES_HOME"
  for item in "$BUNDLE"/hermes/*; do
    name="$(basename "$item")"
    if [[ -e "$HERMES_HOME/$name" && $FORCE -eq 0 ]]; then
      say "  $name exists — skipping (use --force to overwrite)"
    else
      cp -r "$item" "$HERMES_HOME/$name" && say "  $name"
    fi
  done
  say "NOTE: re-authenticate Hermes (auth.json keys are machine-bound);"
  say "      then run hermes update to rebuild hermes-agent if not already installed."
fi

# ── 6. Dependencies + build ──────────────────────────────────────────────────
step "Dependencies + build"
if [[ -d "$ARIA_TARGET/node_modules" && $FORCE -eq 0 ]]; then
  say "node_modules present — skipping npm ci (use --force to reinstall)"
else
  (cd "$ARIA_TARGET" && npm ci --no-audit --no-fund) || (cd "$ARIA_TARGET" && npm install --no-audit --no-fund)
fi
(cd "$ARIA_TARGET" && npm run build) && say "build OK"

# ── 7. PM2 ───────────────────────────────────────────────────────────────────
step "PM2"
if [[ -f "$ARIA_TARGET/ecosystem.config.json" ]]; then
  (cd "$ARIA_TARGET" && npx pm2 start ecosystem.config.json && npx pm2 save) \
    && say "PM2 started from ecosystem.config.json"
fi

# ── 8. Scheduled task (best effort) ──────────────────────────────────────────
step "Scheduled task"
if [[ -f "$ARIA_TARGET/scripts/register-backup-task.ps1" ]]; then
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$ARIA_TARGET/scripts/register-backup-task.ps1")" 2>/dev/null \
    && say "AriaDailyBackup registered (daily 03:00)" || say "task registration skipped (needs admin or non-admin fallback)"
fi

# ── 9. Verify ────────────────────────────────────────────────────────────────
step "Verify"
curl -s --max-time 8 -o /dev/null -w "   PostgREST :5434 -> %{http_code}\n" http://localhost:5434/ || say "   PostgREST not responding yet (wait 15s for schema cache)"
curl -s --max-time 8 -o /dev/null -w "   Dashboard :3001 -> %{http_code}\n" http://localhost:3001/dashboard || say "   Dashboard not up yet (next start takes ~35s)"
npx pm2 list 2>/dev/null | grep -E "aria-(bot|dashboard|postgrest|pg-health)" || say "   pm2 list unavailable"
echo
echo "Restore complete. Next: verify dashboard panels, unlock 1Password, re-auth Hermes if needed."
