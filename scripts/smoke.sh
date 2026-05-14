#!/usr/bin/env bash
# Post-restart smoke check for a pm2 process.
# Usage: bash scripts/smoke.sh <pm2-process-name>
# Prints any current-hour error/failed/unhandled lines from pm2 logs,
# excluding informational OpenRouter fallback warnings.
# No output = process boot is clean.

set -euo pipefail

proc="${1:?usage: smoke.sh <pm2-process-name>}"
hour="$(date '+%Y-%m-%d %H:')"

# Wait briefly for restart to settle.
sleep 5

errors="$(
    pm2 logs "$proc" --lines 200 --nostream 2>&1 \
    | grep "$hour" \
    | grep -Ei 'error|failed|unhandled|ECONNREFUSED' \
    | grep -viE 'openrouter.*falling back|info[[:space:]]' \
    || true
)"

if [ -n "$errors" ]; then
    echo "smoke[$proc]: errors detected in current-hour window:"
    echo "$errors"
    exit 1
fi

# Dashboard-specific HTTP probe: catches the "200 OK with dead JS chunks" state
# where .next/static/chunks was wiped but next start still serves stale HTML.
# Without this, the broken page returns 200, logs nothing, smoke is "clean".
if [ "$proc" = "aria-dashboard" ]; then
    html="$(curl -s --max-time 10 http://localhost:3001/dashboard || true)"
    if [ -z "$html" ]; then
        echo "smoke[$proc]: dashboard did not respond on :3001"
        exit 1
    fi
    chunk="$(echo "$html" | grep -oE '/_next/static/chunks/app/dashboard/page-[a-f0-9]+\.js' | head -1)"
    if [ -z "$chunk" ]; then
        echo "smoke[$proc]: served HTML has no dashboard page chunk reference"
        exit 1
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:3001${chunk}")"
    if [ "$code" != "200" ]; then
        echo "smoke[$proc]: chunk ${chunk} returned HTTP ${code} — stale HTML vs disk (rebuild .next)"
        exit 1
    fi
fi

echo "smoke[$proc]: clean"
exit 0
