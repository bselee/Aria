#!/usr/bin/env bash
# check-refs.sh — Quick scan for bare supabase/db references that would
# cause runtime crashes. Catches the class of bug fixed in 3d792fa.
# Runs in milliseconds vs tsc's minutes.
set -e

ARIA="$(cd "$(dirname "$0")/.." && pwd)"
HAD_ERROR=0

# Pattern 1: await supabase. calls without createClient in the file
BAD=$(grep -rn "await supabase\." "$ARIA/src" --include="*.ts" 2>/dev/null | grep -vE "(import.*createClient|createClient\(\)|@deps)" || true)
if [ -n "$BAD" ]; then
  echo "ERROR: bare 'await supabase.' found (missing createClient in scope):"
  echo "$BAD"
  HAD_ERROR=1
fi

# Pattern 2: db.from calls without createClient or const db = in the file
BAD=$(grep -rn "await db\." "$ARIA/src" --include="*.ts" 2>/dev/null | grep -vE "(import.*createClient|createClient\(\)|const db =|@deps|\.db\.|@google)" || true)
if [ -n "$BAD" ]; then
  echo "ERROR: bare 'await db.' found (missing createClient/const db in scope):"
  echo "$BAD"
  HAD_ERROR=1
fi

if [ "$HAD_ERROR" -eq 1 ]; then
  echo "check:refs — FAILED"
  exit 1
fi

echo "check:refs — clean (no bare supabase/db refs)"
exit 0
