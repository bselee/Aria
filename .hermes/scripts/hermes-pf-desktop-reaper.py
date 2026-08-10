#!/usr/bin/env python3
"""
@file        hermes-pf-desktop-reaper.py
@purpose     Backstop watchdog: kill any C:\\Program Files\\Hermes Electron tree.
             That install is a STALE Jun-4 packaged build. It must never own the
             Hermes Desktop session on this machine.
@author      Hermia
@created     2026-08-10
@deps        stdlib only (subprocess, csv, os, sys, datetime)
@env         none

WHY THIS EXISTS
---------------
Recurring morning failure: two Desktop windows open, one shows "setting up" then
dies, the other says ready but the sidebar has NO pinned sessions.

Root cause (verified 2026-08-10):
  * C:\\Program Files\\Hermes\\Hermes.exe (built 2026-06-04, commit de370fd1)
    was being launched -- often with `--profile hermia`.
  * It pins its backend to FIXED port 9120. Racing instances both try to bind
    it, so one dies with:
        ERROR: [Errno 10048] error while attempting to bind on address
        ('127.0.0.1', 9120) ... only one usage of each socket address
        Hermes backend exited (1)
    That is the "setting up" window that stops.
  * It predates the pin-sync commits (99ffea6d0 / 8ce8b70dc / 090d14647,
    2026-07-31), so it cannot read pins from state.db (`sessions.pinned`). It
    only reads localStorage `hermes.desktop.pinnedSessions`, which no longer
    exists in the LevelDB -> the Pinned section renders EMPTY even though
    state.db holds 13 pinned rows.
  * `--profile hermia` compounded it: that profile's state.db has 0 sessions.

The correct build is:
  C:\\Users\\BuildASoil\\AppData\\Local\\hermes\\hermes-agent\\apps\\desktop\\release\\win-unpacked\\Hermes.exe
launched via Desktop\\Hermes-Desktop.vbs with NO --profile (default HERMES_HOME),
whose backend binds an EPHEMERAL port (`serve --port 0`).

SAFETY
------
Matches strictly on ExecutablePath starting with C:\\Program Files\\Hermes.
NEVER image-wide (`taskkill /IM Hermes.exe` would kill Bill's active CLI and the
real Desktop). The venv CLI at ...\\hermes-agent\\venv\\Scripts\\hermes.exe and the
win-unpacked Desktop are explicitly out of scope.

OUTPUT CONTRACT (designed for cronjob no_agent=True / silent watchdog)
---------------------------------------------------------------------
Prints NOTHING when the machine is clean, so a scheduled run stays silent.
Prints a one-line report ONLY when it actually reaped something.
"""

from __future__ import annotations

import csv
import io
import os
import subprocess
import sys
from datetime import datetime

PF_PREFIX = r"c:\program files\hermes"
LOG_PATH = os.path.join(
    os.environ.get("LOCALAPPDATA", r"C:\Users\BuildASoil\AppData\Local"),
    "hermes",
    "logs",
    "pf-desktop-reaper.log",
)


def _wmic_processes() -> list[dict[str, str]]:
    """Return [{pid, ppid, name, exe}] for every process, via wmic CSV.

    Returns an empty list when wmic is unavailable or returns nothing usable --
    a watchdog must never raise on a hostile environment.
    """
    try:
        out = subprocess.run(
            [
                "wmic",
                "process",
                "get",
                "ProcessId,ParentProcessId,Name,ExecutablePath",
                "/format:csv",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
    except Exception:
        return []

    rows: list[dict[str, str]] = []
    # wmic CSV: Node,ExecutablePath,Name,ParentProcessId,ProcessId
    reader = csv.reader(io.StringIO(out.strip()))
    for parts in reader:
        if len(parts) < 5:
            continue
        _node, exe, name, ppid, pid = parts[0], parts[1], parts[2], parts[3], parts[4]
        if not pid.isdigit():
            continue
        rows.append(
            {
                "pid": pid,
                "ppid": ppid if ppid.isdigit() else "0",
                "name": name,
                "exe": exe or "",
            }
        )
    return rows


def _is_program_files_hermes(proc: dict[str, str]) -> bool:
    return proc["exe"].lower().startswith(PF_PREFIX)


def _kill(pid: str) -> bool:
    try:
        res = subprocess.run(
            ["taskkill", "/PID", pid, "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return res.returncode == 0
    except Exception:
        return False


def main() -> int:
    procs = _wmic_processes()
    if not procs:
        return 0

    targets = [p for p in procs if _is_program_files_hermes(p)]
    if not targets:
        return 0  # clean -> stay silent

    # Kill parents first; /T takes their children with them.
    by_pid = {p["pid"]: p for p in targets}
    parents = [p for p in targets if p["ppid"] not in by_pid]
    ordered = parents + [p for p in targets if p not in parents]

    killed: list[str] = []
    for proc in ordered:
        if _kill(proc["pid"]):
            killed.append(proc["pid"])

    stamp = datetime.now().isoformat(timespec="seconds")
    msg = (
        f"Hermes PF reaper: killed {len(killed)}/{len(targets)} "
        f"stale 'C:\\Program Files\\Hermes' process(es) "
        f"(pids={','.join(killed) or 'none'}). "
        f"That build races port 9120 and cannot read pins from state.db."
    )

    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{stamp} {msg}\n")
    except Exception:
        pass

    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
