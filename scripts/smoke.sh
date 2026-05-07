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

if [ -z "$errors" ]; then
    echo "smoke[$proc]: clean"
    exit 0
fi

echo "smoke[$proc]: errors detected in current-hour window:"
echo "$errors"
exit 1
