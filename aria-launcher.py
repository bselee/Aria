#!/usr/bin/env python3
"""
aria-launcher.py — starts all Aria processes with zero window pop-ups.
Uses subprocess.CREATE_NO_WINDOW (0x08000000) — Windows-only flag.
No cmd.exe, no conhost.exe, no PM2, no npx wrapper windows.
Run: python aria-launcher.py   or   double-click from Explorer.
"""
import subprocess, os, time, sys

ARIA = r"C:\Users\BuildASoil\Documents\Projects\aria"
NODE = r"C:\Program Files\nodejs\node.exe"
NO_WIN = 0x08000000

def start(name, cmd):
    print(f"  {name}... ", end="", flush=True)
    # list form, shell=False = zero cmd.exe windows ever
    p = subprocess.Popen(cmd, cwd=ARIA,
                         creationflags=NO_WIN,
                         stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    print(f"PID {p.pid}")
    return p

if __name__ == "__main__":
    os.chdir(ARIA)
    # PostgREST health gate — bail if down (WSL2 Docker local DB)
    try:
        import urllib.request, ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        urllib.request.urlopen("http://localhost:3000", timeout=2, context=ctx)
    except:
        print("PostgREST down — aborting launch")
        sys.exit(1)

    # Fire-and-forget starter — Task Scheduler + watchdog handle restarts
    start("wsl-proxy", [NODE, "scripts/wsl-proxy.js"])
    start("dashboard", [NODE, "node_modules/next/dist/bin/next", "start", "-p", "3001"])
    start("aria-bot", [NODE, "node_modules/tsx/dist/cli.mjs", "src/cli/start-bot.ts"])
    # Exit immediately — watchdog monitors health every 2 minutes
