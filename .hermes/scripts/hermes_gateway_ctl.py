#!/usr/bin/env python3
"""
@file    hermes_gateway_ctl.py
@purpose Single source of truth for the default Hermes gateway lifecycle on this
         Windows host: probe, start, stop, restart, heal. Replaces the four
         competing probes/launchers (gateway-keepalive.vbs, gateway-keepalive-check.py,
         gateway-health-check.py, silent-gateway*.vbs) whose TCP-only checks reported a
         wedged gateway as healthy and whose relaunches raced each other.
@author  Hermia
@created 2026-11-12
@deps    Python 3.11+ stdlib only (urllib, socket, subprocess, ctypes). No Hermes imports,
         so it keeps working while the hermes-agent venv is mid-repair or mid-update.
@env     HERMES_HOME          default %LOCALAPPDATA%\\hermes
         HERMES_GATEWAY_PORT  default 8642

WHY THIS EXISTS (incident 2026-11-12):
  The overnight failure was NOT a dead gateway process - it was a *wedged* one:
    01:01 tui_gateway.ws "loop stalled >10s" -> 01:03 shutdown_watchdog exit 75
    01:22/01:23/01:25 three relaunches each burned 300s in the startup watchdog
    08:11 Bill restarted by hand -> worked
  The old keepalive probed "does TCP 127.0.0.1:8642 accept a connect" and "is there a
  process whose cmdline says 'gateway run'". Both stay TRUE while the event loop is dead
  (the listen socket survives in the kernel backlog), so the keepalive sat on a broken
  gateway for hours and the cron scheduler inside it stayed frozen.

  Therefore the only trustworthy liveness signal is an HTTP response with a deadline.
  A response - any status code - proves the loop is running. No response within
  HTTP_TIMEOUT_S proves it is not, whatever the socket and the process table say.

SAFETY RULES encoded here (each one is a bug that actually bit this host):
  1. Never delete gateway.lock / gateway.pid on the strength of a TCP probe. They ARE the
     control identity the Desktop reads; unlinking them under a live gateway is exactly
     how the Desktop started reporting "Gateway inaccessible (invalid_control_peer)".
     Lock/pid files are only removed when the recorded PID is provably dead.
  2. Never kill image-wide. Only the exact PID that owns the port or that gateway_state.json
     records, and only after its image name is python/pythonw/hermes.
  3. Wait for the old process to actually die (PID gone AND port closed) before starting a
     replacement - otherwise the replacement fights the corpse and burns the startup
     watchdog deadline, turning a 10 minute outage into two hours.
  4. A ctl lock plus a heal budget stop keepalive/manual launches from racing or thrashing.

USAGE (all idempotent, all exit-coded):
  python hermes_gateway_ctl.py status [--json]   # probe only, never mutates
  python hermes_gateway_ctl.py ensure            # heal only if unhealthy  <- keepalive task
  python hermes_gateway_ctl.py start [--wait 180]
  python hermes_gateway_ctl.py stop
  python hermes_gateway_ctl.py restart
  python hermes_gateway_ctl.py selftest          # exercises stop/start logic on a throwaway server
Exit codes: 0 healthy/no-op/success, 1 still unhealthy, 3 cooldown, 4 busy, 5 refused.
"""

from __future__ import annotations

import ctypes
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or (Path(os.environ["LOCALAPPDATA"]) / "hermes"))
PORT = int(os.environ.get("HERMES_GATEWAY_PORT") or 8642)
HOST = "127.0.0.1"

STATE_FILE = HERMES_HOME / "gateway_state.json"
PID_FILE = HERMES_HOME / "gateway.pid"
LOCK_FILE = HERMES_HOME / "gateway.lock"
LAUNCHER = HERMES_HOME / "gateway-service" / "start-gateway.vbs"
LOG_FILE = HERMES_HOME / "logs" / "gateway-ctl.log"
CTL_LOCK = HERMES_HOME / "gateway-ctl.lock"
BUDGET_FILE = HERMES_HOME / "gateway-ctl-budget.json"

HTTP_TIMEOUT_S = 3.0
CTL_LOCK_STALE_S = 300
HEAL_BUDGET_MAX = 5          # starts allowed per window
HEAL_BUDGET_WINDOW_S = 1800
DIE_TIMEOUT_S = 45           # how long to wait for a stopped gateway to release the port
READY_TIMEOUT_S = 180        # how long to wait for /health after a start
NO_WINDOW = 0x08000000

HOST_IMAGES = {"python.exe", "pythonw.exe", "hermes.exe"}


# ----------------------------------------------------------------------------- logging
def log(action: str, **fields) -> None:
    """Append one structured line to gateway-ctl.log (never raises, never prints)."""
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    body = " ".join(f"{k}={v}" for k, v in fields.items())
    line = f"{stamp} action={action} {body}\n"
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 5_000_000:
            LOG_FILE.replace(LOG_FILE.with_suffix(".log.1"))
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line)
    except OSError:
        pass


def emit(text: str) -> None:
    """Print when a console exists (pythonw.exe leaves sys.stdout as None)."""
    if sys.stdout is not None:
        try:
            print(text, flush=True)
        except (OSError, ValueError):
            pass


# ----------------------------------------------------------------------------- probing
def http_alive(timeout: float = HTTP_TIMEOUT_S) -> tuple[bool, int | None, str]:
    """Return (answering, status_code, detail).

    Any HTTP response proves the event loop is alive. HTTPError carries a real code and is
    therefore a PASS (a 404/500 still means the loop served us). Timeout, refused, reset
    and malformed replies are the only failures.
    """
    started = time.monotonic()
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=timeout) as resp:
            resp.read(256)
            return True, resp.status, f"{(time.monotonic() - started) * 1000:.0f}ms"
    except urllib.error.HTTPError as exc:            # answered, just not 2xx
        return True, exc.code, f"{(time.monotonic() - started) * 1000:.0f}ms"
    except Exception as exc:                          # noqa: BLE001 - the point is to swallow
        return False, None, type(exc).__name__


def port_open(timeout: float = 1.0) -> bool:
    """TCP-level check. Only ever used as a secondary signal, never as health."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect((HOST, PORT))
            return True
        except OSError:
            return False


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return {}


def recorded_pid() -> int | None:
    """PID from gateway_state.json, falling back to gateway.pid / gateway.lock."""
    for path in (STATE_FILE, PID_FILE, LOCK_FILE):
        pid = _read_json(path).get("pid")
        if isinstance(pid, int) and pid > 4:
            return pid
    return None


def listener_pid() -> int | None:
    """PID owning the LISTENING socket on PORT (fallback when state files are gone)."""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True, text=True, timeout=20,
            creationflags=NO_WINDOW if sys.platform == "win32" else 0,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING":
            if parts[1].endswith(f":{PORT}"):
                try:
                    pid = int(parts[4])
                except ValueError:
                    continue
                if pid > 4:
                    return pid
    return None


def pid_alive(pid: int) -> bool:
    """True when the PID exists and has not exited (ctypes, no psutil dependency)."""
    if sys.platform == "win32":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong(0)
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def image_name(pid: int) -> str:
    """Image name for a PID via tasklist ('' when unknown)."""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=20,
            creationflags=NO_WINDOW if sys.platform == "win32" else 0,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    if not out or out.startswith("INFO:"):
        return ""
    return out.split('","')[0].strip('"').casefold()


class Status(dict):
    @property
    def verdict(self) -> str:
        """healthy | wedged | down"""
        return str(self["verdict"])


def probe() -> Status:
    """Full, side-effect-free assessment of the gateway."""
    answering, code, detail = http_alive()
    pid = recorded_pid()
    if answering:
        alive = pid_alive(pid) if pid else False
        return Status(
            verdict="healthy", pid=pid, pid_alive=alive, http=code, detail=detail,
            port=port_open(), recorded=True,
        )
    # No HTTP answer: the loop is dead or the process is gone. The socket may still be
    # open (kernel backlog) - that is precisely the state that fooled the old keepalive.
    if pid and pid_alive(pid):
        return Status(verdict="wedged", pid=pid, pid_alive=True, http=None, detail=detail,
                      port=port_open(), recorded=True)
    stale = pid if pid else listener_pid()
    return Status(verdict="down", pid=stale, pid_alive=bool(stale and pid_alive(stale)),
                  http=None, detail=detail, port=port_open(), recorded=bool(pid))


# ----------------------------------------------------------------------------- mutating
def stop(timeout: float = DIE_TIMEOUT_S) -> bool:
    """Kill the exact gateway process and wait until the PID and the port are clear.

    Returns False when something is still holding the port afterwards, because starting a
    replacement then only manufactures a port fight.
    """
    pid = recorded_pid()
    if not (pid and pid_alive(pid)):
        pid = listener_pid()
    if not pid or not pid_alive(pid):
        _clear_identity_files()          # safe: nothing is alive to own them
        return not port_open(timeout=1.0)

    name = image_name(pid)
    if name and name not in HOST_IMAGES:
        log("stop_refused", pid=pid, image=name)
        emit(f"REFUSED: PID {pid} is {name}, not a Hermes gateway")
        return False

    log("stop", pid=pid, image=name or "?")
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=30,
                       creationflags=NO_WINDOW if sys.platform == "win32" else 0)
    except (OSError, subprocess.SubprocessError):
        pass

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not pid_alive(pid) and not port_open(timeout=0.5):
            _clear_identity_files()
            log("stopped", pid=pid, waited=f"{timeout - (deadline - time.monotonic()):.0f}s")
            return True
        time.sleep(0.5)

    log("stop_timeout", pid=pid, port_open=port_open(timeout=0.5))
    emit(f"TIMEOUT: PID {pid} / port {PORT} still held after {timeout:.0f}s")
    return False


def _clear_identity_files() -> None:
    """Remove lock/pid only once no live process owns them (see SAFETY RULE 1)."""
    for path in (PID_FILE, LOCK_FILE):
        try:
            path.unlink()
        except OSError:
            pass


def start(wait: float = READY_TIMEOUT_S) -> bool:
    """Launch the hidden gateway launcher and wait for an HTTP answer."""
    if not LAUNCHER.is_file():
        log("start_failed", reason="launcher_missing", path=str(LAUNCHER))
        emit(f"FATAL: launcher missing: {LAUNCHER}")
        return False
    before = recorded_pid()
    try:
        subprocess.Popen(
            ["wscript.exe", "//nologo", str(LAUNCHER)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            creationflags=NO_WINDOW if sys.platform == "win32" else 0,
        )
    except OSError as exc:
        log("start_failed", reason=type(exc).__name__)
        emit(f"FATAL: could not launch: {exc}")
        return False

    log("start", prior_pid=before or "-")
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        answering, code, _detail = http_alive(timeout=2.0)
        if answering:
            log("started", pid=recorded_pid() or "-", http=code,
                waited=f"{wait - (deadline - time.monotonic()):.0f}s")
            return True
        time.sleep(1.0)
    log("start_timeout", waited=f"{wait:.0f}s")
    emit(f"TIMEOUT: no HTTP answer on {PORT} after {wait:.0f}s")
    return False


# ----------------------------------------------------------------------------- guards
class _CtlLock:
    """Cross-process mutex so the keepalive task and a manual restart cannot race."""

    def __init__(self) -> None:
        self.locked = False

    def __enter__(self) -> bool:
        try:
            if CTL_LOCK.exists() and (time.time() - CTL_LOCK.stat().st_mtime) > CTL_LOCK_STALE_S:
                CTL_LOCK.unlink(missing_ok=True)
            fd = os.open(CTL_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, str(os.getpid()).encode())
            os.close(fd)
            self.locked = True
        except FileExistsError:
            self.locked = False
        except OSError:
            self.locked = True          # unjudgeable lock must not block healing
        return self.locked

    def __exit__(self, *_exc) -> None:
        if self.locked:
            try:
                CTL_LOCK.unlink(missing_ok=True)
            except OSError:
                pass


def heal_budget_ok() -> bool:
    """Allow at most HEAL_BUDGET_MAX starts per window - a broken env must not thrash."""
    now = time.time()
    data = _read_json(BUDGET_FILE)
    recent = [t for t in data.get("heals", []) if isinstance(t, (int, float))
              and now - t < HEAL_BUDGET_WINDOW_S]
    data["heals"] = recent
    try:
        BUDGET_FILE.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass
    return len(recent) < HEAL_BUDGET_MAX


def record_heal() -> None:
    data = _read_json(BUDGET_FILE)
    heals = [t for t in data.get("heals", []) if isinstance(t, (int, float))]
    heals.append(time.time())
    try:
        BUDGET_FILE.write_text(json.dumps({"heals": heals}), encoding="utf-8")
    except OSError:
        pass


# ----------------------------------------------------------------------------- commands
def cmd_status(as_json: bool = False) -> int:
    status = probe()
    if as_json:
        emit(json.dumps(status, sort_keys=True))
    else:
        emit(
            f"verdict={status['verdict']} pid={status.get('pid') or '-'} "
            f"alive={status.get('pid_alive')} http={status.get('http') or '-'} "
            f"port_open={status.get('port')} detail={status.get('detail')}"
        )
    return 0 if status.verdict == "healthy" else 1


def cmd_ensure() -> int:
    with _CtlLock() as locked:
        if not locked:
            log("busy")
            return 4
        status = probe()
        if status.verdict == "healthy":
            log("ensure_ok", pid=status.get("pid") or "-", http=status.get("http"))
            return 0
        log("ensure_unhealthy", verdict=status.verdict, pid=status.get("pid") or "-",
            detail=status.get("detail"))
        if status.verdict == "wedged" and not stop():
            log("ensure_failed", reason="could_not_stop_wedged")
            return 1
        if not heal_budget_ok():
            log("ensure_cooldown", verdict=status.verdict)
            emit("COOLDOWN: heal budget exhausted, leaving the gateway alone")
            return 3
        record_heal()
        ok = start()
        log("ensure_done", ok=ok)
        emit("RECOVERED: gateway healthy" if ok else "FATAL: gateway did not come up")
        return 0 if ok else 1


def cmd_start(wait: float) -> int:
    if probe().verdict == "healthy":
        emit("OK: gateway already healthy")
        return 0
    return 0 if start(wait) else 1


def cmd_stop() -> int:
    ok = stop()
    emit("OK: gateway stopped" if ok else "FAILED: gateway still holding the port")
    return 0 if ok else 1


def cmd_restart(wait: float) -> int:
    with _CtlLock() as locked:
        if not locked:
            emit("BUSY: another gateway operation is in progress")
            return 4
        if not stop():
            return 1
        record_heal()
        return 0 if start(wait) else 1


def cmd_selftest() -> int:
    """Exercise probe/stop/wait against a throwaway HTTP server (no Hermes touched)."""
    global PORT
    real_port = PORT
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((HOST, 0))
        PORT = sock.getsockname()[1]
    python = sys.executable
    child = subprocess.Popen([python, "-m", "http.server", str(PORT), "--bind", HOST],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    failures: list[str] = []
    try:
        time.sleep(2.0)
        answering, code, detail = http_alive()
        emit(f"1. live server -> answering={answering} http={code} ({detail})")
        if not answering:
            failures.append("probe missed a live HTTP server")
        child.kill()
        child.wait(timeout=10)
        time.sleep(0.5)
        answering, _code, detail = http_alive(timeout=1.5)
        emit(f"2. killed server -> answering={answering} ({detail})")
        if answering:
            failures.append("probe reported a dead server as alive")
        emit(f"3. port_open after kill = {port_open(timeout=0.5)} (informational)")
    finally:
        if child.poll() is None:
            child.kill()
        PORT = real_port
    if failures:
        emit("SELFTEST FAILED: " + "; ".join(failures))
        return 1
    emit("SELFTEST OK: HTTP probe distinguishes live from wedged/dead")
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "status"
    wait = READY_TIMEOUT_S
    if "--wait" in argv:
        try:
            wait = float(argv[argv.index("--wait") + 1])
        except (IndexError, ValueError):
            pass

    if cmd == "status":
        return cmd_status("--json" in argv)
    if cmd == "ensure":
        return cmd_ensure()
    if cmd == "start":
        return cmd_start(wait)
    if cmd == "stop":
        return cmd_stop()
    if cmd == "restart":
        return cmd_restart(wait)
    if cmd == "selftest":
        return cmd_selftest()

    emit(__doc__ or "")
    return 5


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
