#!/usr/bin/env python3
"""gateway-keepalive-check.py — pure probe used by tests + manual verify.

Exit 0 if default Hermes gateway appears healthy:
  - TCP 127.0.0.1:8642 accepts connect, OR
  - a non-hermia process cmdline contains 'gateway run'

Does NOT start anything. Used to validate keepalive logic without side effects.
"""
from __future__ import annotations

import socket
import subprocess
import sys

PORT = 8642
NO_WINDOW = 0x08000000


def port_open(port: int = PORT, timeout: float = 2.0) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except OSError:
        return False


def process_match() -> bool:
    flags = {"creationflags": NO_WINDOW} if sys.platform == "win32" else {}
    ps = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.Name -match '^(python|pythonw|hermes)\\.exe$' -and "
        "$_.CommandLine -and ($_.CommandLine -notmatch 'hermia') -and "
        "($_.CommandLine -match 'gateway run' -or "
        "($_.CommandLine -match 'hermes_cli\\.main' -and $_.CommandLine -match 'gateway' "
        "-and $_.CommandLine -notmatch 'desktop|serve')) } | "
        "Measure-Object | Select-Object -ExpandProperty Count"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            text=True,
            timeout=60,
            **flags,
        )
        return int((r.stdout or "0").strip() or "0") > 0
    except Exception:
        return False


def main() -> int:
    p = port_open()
    m = process_match()
    print(f"port_{PORT}={'open' if p else 'closed'} process_match={'yes' if m else 'no'}")
    if p or m:
        print("OK: default gateway appears up")
        return 0
    print("DOWN: default gateway not detected")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
