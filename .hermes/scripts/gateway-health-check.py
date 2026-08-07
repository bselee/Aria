#!/usr/bin/env python3
"""
Gateway health watchdog — checks port 8642, auto-recovers aiohttp corruption.
Runs every 5 minutes via cron. Silent when healthy, reports only on recovery.
"""
import subprocess
import sys
import time
import os

HERMES_VENV = os.path.expandvars(
    r"%USERPROFILE%\AppData\Local\hermes\hermes-agent\venv\Scripts"
)
GATEWAY_PORT = 8642
HERMES_AGENT_DIR = os.path.expandvars(
    r"%USERPROFILE%\AppData\Local\hermes\hermes-agent"
)
HERMES_EXE = os.path.join(HERMES_VENV, "hermes.exe")
PYTHON_EXE = os.path.join(HERMES_VENV, "python.exe")
UV_EXE = os.path.expandvars(r"%USERPROFILE%\AppData\Local\hermes\bin\uv.exe")


def check_port(port):
    """Check if something is listening on the given port."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except Exception:
        return False


def _hide_kwargs():
    """Windows CREATE_NO_WINDOW so cron ticks never flash a console."""
    if sys.platform == "win32":
        return {"creationflags": 0x08000000}
    return {}


def check_aiohttp():
    """Returns True if aiohttp imports cleanly."""
    try:
        result = subprocess.run(
            [PYTHON_EXE, "-c", "import aiohttp; print(aiohttp.__version__)"],
            capture_output=True, text=True, timeout=10,
            **_hide_kwargs(),
        )
        return result.returncode == 0 and "3." in result.stdout
    except Exception:
        return False


def fix_aiohttp():
    """Force-reinstall aiohttp in the venv."""
    result = subprocess.run(
        [UV_EXE, "pip", "install", "--python", PYTHON_EXE,
         "--force-reinstall", "aiohttp==3.13.4"],
        capture_output=True, text=True, timeout=120,
        cwd=HERMES_AGENT_DIR,
        **_hide_kwargs(),
    )
    return result.returncode == 0


def kill_stale_gateways():
    """Clean lock files for default + hermia profiles (never force-kill live PIDs)."""
    base = os.path.expandvars(r"%USERPROFILE%\AppData\Local\hermes")
    for rel in (
        r"gateway.lock",
        r"gateway.pid",
        r"profiles\hermia\gateway.lock",
        r"profiles\hermia\gateway.pid",
    ):
        f = os.path.join(base, rel)
        if os.path.exists(f):
            try:
                os.remove(f)
            except OSError:
                pass


def start_gateway():
    """Start default gateway hidden via proven silent VBS (no console)."""
    vbs = os.path.expandvars(
        r"%USERPROFILE%\AppData\Local\hermes\gateway-service\silent-gateway-default.vbs"
    )
    kwargs = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "stdin": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    subprocess.Popen(
        ["wscript.exe", "//nologo", vbs],
        **kwargs,
    )
    for _ in range(40):
        time.sleep(0.5)
        if check_port(GATEWAY_PORT):
            return True
    return False


def main():
    if check_port(GATEWAY_PORT):
        # Gateway is up — silent exit
        print("OK: gateway healthy")
        return

    # Gateway is DOWN
    aiohttp_ok = check_aiohttp()
    
    if not aiohttp_ok:
        print("ACTION: aiohttp corrupted — reinstalling...")
        if fix_aiohttp():
            print("ACTION: aiohttp reinstalled successfully")
        else:
            print("FATAL: aiohttp reinstall failed")
            sys.exit(1)
    
    # Kill stale processes and clean locks
    kill_stale_gateways()
    time.sleep(1)
    
    # Start gateway
    print("ACTION: starting gateway...")
    if start_gateway():
        print("RECOVERED: gateway auto-restarted successfully")
    else:
        print("FATAL: gateway failed to start after recovery")
        sys.exit(1)


if __name__ == "__main__":
    main()
