#!/usr/bin/env bash
# @file    scripts/portability-pack.sh
# @purpose Create a full portability bundle: Aria repo (minus build artifacts) +
#          secrets (.env.local, OAuth tokens) + PostgreSQL dump + SQLite copy +
#          local storage + Obsidian vault + Hermes user data. Restore with the
#          restore.sh that ships inside the bundle (or scripts/portability-restore.sh).
# @usage   bash scripts/portability-pack.sh [-o OUTDIR] [--full] [--keep N]
#            -o OUTDIR  bundle parent dir (default: ~/portability-bundles)
#            --full     include heavy state (Hermes state.db, 1.3 GB) — use for a real move,
#                       omit for daily insurance bundles
#            --keep N   retain N newest bundles (default 7)
# @deps    pg_dump (PostgreSQL 16), node + better-sqlite3 (optional), bash
# @env     none required (PG password read from scripts/backup-aria-db.ps1 convention)
# @author  Hermia
# @created 2026-08-31

set -euo pipefail

ARIA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_HOME="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes"
OUT_DIR="$HOME/portability-bundles"
KEEP=7
FULL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) OUT_DIR="$2"; shift 2 ;;
    --full) FULL=1; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
BUNDLE="$OUT_DIR/portability-bundle-$STAMP"
BUNDLE_WIN="$(cygpath -w "$BUNDLE")"   # native tools (pg_dump, python) need C:/... not /c/...
mkdir -p "$BUNDLE"/{aria,secrets,db,storage/local,storage/billcom,obsidian,hermes}

log() { echo "[pack] $*"; }
warn() { echo "[pack][warn] $*"; }

log "ARIA_ROOT=$ARIA_ROOT"
log "HERMES_HOME=$HERMES_HOME"
log "BUNDLE=$BUNDLE"

# ── 1. PostgreSQL dump ────────────────────────────────────────────────────────
PG_DUMP="$(command -v pg_dump || echo '/c/Program Files/PostgreSQL/16/bin/pg_dump.exe')"
if [[ -x "$PG_DUMP" || -f "$PG_DUMP" ]]; then
  log "dumping aria DB (pg_dump -Fc)…"
  PGPASSWORD=arialocal "$PG_DUMP" -U aria -h 127.0.0.1 -p 5432 -d aria -Fc -Z 6 \
    -f "$BUNDLE_WIN/db/aria.dump" \
    || warn "pg_dump failed (exit $?) — bundle will lack the PG dump; run with 2>&1 to see the error"
else
  warn "pg_dump not found — bundle will lack the PG dump (install PostgreSQL 16 first)"
fi

# ── 2. SQLite sidecar copy (vacuumed if better-sqlite3 available) ─────────────
if [[ -f "$ARIA_ROOT/aria-local.db" ]]; then
  if node -e "require('better-sqlite3')" 2>/dev/null; then
    log "copying aria-local.db (VACUUM INTO)…"
    node "$ARIA_ROOT/scripts/vacuum-sqlite.js" "$ARIA_ROOT/aria-local.db" "$BUNDLE_WIN/db/aria-local.db" 2>/dev/null \
      || cp "$ARIA_ROOT/aria-local.db" "$BUNDLE/db/aria-local.db"
  else
    log "copying aria-local.db (plain copy — better-sqlite3 unavailable)…"
    cp "$ARIA_ROOT/aria-local.db" "$BUNDLE/db/aria-local.db"
  fi
else
  warn "aria-local.db not found"
fi

# ── 3. Aria repo (no build artifacts, no backups, no caches) ─────────────────
log "copying Aria repo (excluding node_modules/.next/backups/data/logs…)…"
(cd "$ARIA_ROOT" && tar -cf - \
    --exclude=node_modules --exclude=.next --exclude=backups --exclude=backup \
    --exclude=data --exclude=logs --exclude=chrome-profile --exclude=tmp \
    --exclude=scratch --exclude=__pycache__ --exclude="aria-local.db*" \
    --exclude="backups-archive*.tar.gz" .) \
  | (mkdir -p "$BUNDLE/aria" && tar -xf - -C "$BUNDLE/aria")
log "repo copied"

# ── 4. Secrets (gitignored — never committed) ────────────────────────────────
log "copying secrets…"
for f in .env.local token.json ap-token.json token-ap.json token-default.json \
         calendar-token.json google-credentials.json postgrest.conf mcp.json \
         ecosystem.config.json; do
  [[ -f "$ARIA_ROOT/$f" ]] && cp "$ARIA_ROOT/$f" "$BUNDLE/secrets/"
done

# ── 5. Local storage ─────────────────────────────────────────────────────────
log "copying local storage…"
[[ -d "$ARIA_ROOT/local/storage" ]] && cp -r "$ARIA_ROOT/local/storage/." "$BUNDLE/storage/local/"
[[ -d "$HOME/Downloads/Aria-Ingest/billcom" ]] && cp -r "$HOME/Downloads/Aria-Ingest/billcom/." "$BUNDLE/storage/billcom/"

# ── 6. Obsidian vault ────────────────────────────────────────────────────────
VAULT="$HOME/Documents/Obsidian Vault"
if [[ -d "$VAULT" ]]; then
  log "copying Obsidian vault…"
  cp -r "$VAULT" "$BUNDLE/obsidian/"
else
  warn "Obsidian vault not found at $VAULT"
fi

# ── 7. Hermes user data ──────────────────────────────────────────────────────
log "copying Hermes user data…"
HERMES_DIRS=(profiles skills plugins cron memories sessions scripts)
for d in "${HERMES_DIRS[@]}"; do
  [[ -d "$HERMES_HOME/$d" ]] && cp -r "$HERMES_HOME/$d" "$BUNDLE/hermes/"
done
for f in config.yaml profile.yaml SOUL.md active_profile kanban.db kanban.db-shm kanban.db-wal \
         projects.db projects.db-shm projects.db-wal response_store.db runs_idempotency.db \
         verification_evidence.db; do
  [[ -e "$HERMES_HOME/$f" ]] && cp "$HERMES_HOME/$f" "$BUNDLE/hermes/"
done
if [[ $FULL -eq 1 ]]; then
  log "(--full) including Hermes state.db…"
  for f in state.db state.db-shm state.db-wal; do
    [[ -e "$HERMES_HOME/$f" ]] && cp "$HERMES_HOME/$f" "$BUNDLE/hermes/"
  done
else
  log "excluding Hermes state.db (use --full for a real move)"
fi

# ── 8. Self-contained restore script ─────────────────────────────────────────
if [[ -f "$ARIA_ROOT/scripts/portability-restore.sh" ]]; then
  cp "$ARIA_ROOT/scripts/portability-restore.sh" "$BUNDLE/restore.sh"
  chmod +x "$BUNDLE/restore.sh" 2>/dev/null || true
fi

# ── 9. Manifest ──────────────────────────────────────────────────────────────
log "writing manifest…"
python - "$BUNDLE_WIN" <<'PY'
import json, os, sys, hashlib, datetime
bundle = sys.argv[1]
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
def tree_size(root):
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            try: total += os.path.getsize(os.path.join(dirpath, f))
            except OSError: pass
    return total
secrets = {}
secrets_dir = os.path.join(bundle, "secrets")
for f in sorted(os.listdir(secrets_dir)):
    p = os.path.join(secrets_dir, f)
    try: secrets[f] = {"sha256": sha(p), "bytes": os.path.getsize(p)}
    except OSError: pass
manifest = {
    "created": datetime.datetime.now().isoformat(),
    "source_machine": os.environ.get("COMPUTERNAME", "unknown"),
    "node": os.popen("node --version").read().strip(),
    "pg_dump_present": os.path.exists(os.path.join(bundle, "db", "aria.dump")),
    "aria_local_db_present": os.path.exists(os.path.join(bundle, "db", "aria-local.db")),
    "full": bool(os.path.exists(os.path.join(bundle, "hermes", "state.db"))),
    "secrets_sha256": secrets,
    "sizes_bytes": {sub: tree_size(os.path.join(bundle, sub)) for sub in
                    ("aria", "secrets", "db", "storage", "obsidian", "hermes")},
}
with open(os.path.join(bundle, "MANIFEST.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print(json.dumps(manifest["sizes_bytes"]))
PY

# ── 10. Retention ────────────────────────────────────────────────────────────
TOTAL="$(du -sh "$BUNDLE" | cut -f1)"
log "bundle complete: $BUNDLE ($TOTAL)"
rm -f "$OUT_DIR/latest" && ln -s "$BUNDLE" "$OUT_DIR/latest" 2>/dev/null || true
if command -v python >/dev/null; then
  python - "$OUT_DIR" "$KEEP" <<'PY'
import sys, os, glob, shutil
out, keep = sys.argv[1], int(sys.argv[2])
bundles = sorted(glob.glob(os.path.join(out, "portability-bundle-*")))
for old in bundles[:-keep] if len(bundles) > keep else []:
    shutil.rmtree(old, ignore_errors=True)
    print("pruned", os.path.basename(old))
PY
fi
echo "BUNDLE_PATH=$BUNDLE"
echo "TOTAL_SIZE=$TOTAL"
