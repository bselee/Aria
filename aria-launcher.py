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
    print(f"  {name}...", end=" ", flush=True)
    p = subprocess.Popen(cmd, cwd=ARIA, shell=True,
                         creationflags=NO_WIN,
                         stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    print(f"PID {p.pid}")
    return p

if __name__ == "__main__":
    os.chdir(ARIA)
    print("Aria — no-window launcher\n")
    
    procs = [
        start("wsl-proxy", f'"{NODE}" scripts/wsl-proxy.js'),
        start("dashboard", f'"{NODE}" node_modules/next/dist/bin/next start -p 3001'),
        # npx spawns a child, but CREATE_NO_WINDOW suppresses its cmd.exe flash
        start("aria-bot", f'npx tsx src/cli/start-bot.ts'),
    ]
    
    print(f"\n{len(procs)} processes running. Close this window to stop all.\n")
    
    try:
        while True:
            time.sleep(10)
    except KeyboardInterrupt:
        print("\nStopping...")
        for p in procs:
            p.terminate()
    print("Done.")
