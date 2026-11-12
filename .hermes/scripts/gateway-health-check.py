#!/usr/bin/env python3
"""
@file    gateway-health-check.py
@purpose DETECT only. Reports whether the default gateway's event loop is answering.
         Healing is deliberately NOT done here: this script runs as a Hermes cron job, so
         it executes inside the very gateway it would be restarting, and it cannot run at
         all when that loop is wedged. Restarts belong to the external
         Hermes_Gateway_Keepalive task -> scripts/hermes_gateway_ctl.py ensure.
@author  Hermia
@created 2026-11-12 (rewritten; see archive backups/gateway-cleanup-20261112.tar.gz)
@deps    scripts/hermes_gateway_ctl.py (same directory), stdlib only
@env     HERMES_HOME, HERMES_GATEWAY_PORT

2026-11-12 rewrite (Hermia) - what the old version did wrong:
  * It treated "TCP 127.0.0.1:8642 accepts a connect" as healthy. A wedged event loop keeps
    the listen socket open, so it reported a dead gateway as fine for hours (01:01 incident).
  * Worse, on a *failed* port check it deleted gateway.lock + gateway.pid for both the
    default and hermia profiles. Those files are the control identity the Desktop reads,
    so unlinking them under a live gateway is how the Desktop started reporting
    "Gateway inaccessible (invalid_control_peer)".
  * It force-reinstalled aiohttp inline on a probe miss, which could spend minutes of the
    shared venv during an unrelated outage.
Exit codes: 0 healthy, 1 unhealthy (cron surfaces it), 2 probe unavailable.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from hermes_gateway_ctl import PORT, probe  # noqa: E402  (same-directory sibling)


def main() -> int:
    try:
        status = probe()
    except Exception as exc:  # noqa: BLE001 - a probe crash must not look like an outage
        print(f"PROBE ERROR: {type(exc).__name__}: {exc}")
        return 2

    print(
        f"port={PORT} verdict={status['verdict']} pid={status.get('pid') or '-'} "
        f"http={status.get('http') or '-'} detail={status.get('detail')}"
    )
    if status.verdict == "healthy":
        return 0
    print(
        "UNHEALTHY: the external keepalive task (Hermes_Gateway_Keepalive -> "
        "hermes_gateway_ctl.py ensure) heals this within 10 minutes."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
