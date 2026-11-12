# Gateway lifecycle (single controller)

One script owns the default Hermes gateway: **`hermes_gateway_ctl.py`**. Everything else
(`start-gateway.vbs`, the Scheduled Task, `Hermes-Desktop.vbs`, the cron health probe) is a
thin caller. There is exactly one place that decides whether the gateway is healthy and
exactly one place that restarts it.

## Layout

| File | Role |
|---|---|
| `hermes_gateway_ctl.py` | probe / start / stop / restart / ensure / selftest. Stdlib only. |
| `start-gateway.vbs` | hidden launcher (`hermes_cli.main gateway run`), resolves the newest managed Python. |
| `gateway-health-check.py` | DETECT only, runs as a Hermes cron job inside the gateway. |
| `Hermes-Desktop.vbs` | the manual Desktop entry point; runs `ctl ensure` before Electron boots. |

Installed copies live in `%LOCALAPPDATA%\hermes\scripts\`,
`%LOCALAPPDATA%\hermes\gateway-service\`, and `%USERPROFILE%\Desktop\`. These files are
mirrors for review and disaster recovery.

## Why HTTP and not TCP

The 2026-11-12 incident: at 01:01 the event loop stalled (`ws write slow (loop stalled >10s)`),
the shutdown watchdog exited with code 75, and the next three relaunches each burned the
300s startup watchdog. The Desktop sat on "Connecting…" and the outage lasted about two
hours until a manual restart.

Every old probe asked *"does 127.0.0.1:8642 accept a TCP connect?"* and *"is there a process
whose command line says `gateway run`?"*. Both stay TRUE while the loop is dead - the listen
socket survives in the kernel backlog and the process is still in the process table. So the
keepalive kept reporting a broken gateway as healthy.

`http_alive()` asks for an **HTTP response with a 3s deadline**. Any status code proves the
loop is running; no response proves it is not. That is the only signal worth acting on.

## Rules encoded in the controller

1. **Never unlink `gateway.lock` / `gateway.pid` while the process may be alive.** They are the
   control identity the Desktop reads to reach the gateway. Deleting them under a live
   gateway is what produced `Gateway inaccessible (invalid_control_peer)`. Files are removed
   only after the recorded PID is proven dead.
2. **Never kill image-wide.** Only the exact PID from `gateway_state.json` (or the LISTENING
   owner of the port), and only after its image name is `python/pythonw/hermes`.
3. **Wait for the corpse to clear** - PID gone *and* port closed - before starting a
   replacement. Starting on top of a dying process is what turned a 10 minute outage into
   two hours of startup-watchdog timeouts.
4. **One mutex, one budget.** A ctl lock stops the keepalive and a manual restart racing; at
   most 5 starts per 30 minutes stops a broken environment from thrashing.

## Wiring

- Scheduled Task **`Hermes_Gateway_Keepalive`** - every 10 min,
  `<pythonw> hermes_gateway_ctl.py ensure`, Interactive logon, non-elevated.
  This is the only automatic actor. It must stay outside Hermes: cron lives *on* the
  gateway, so it cannot revive it.
- Scheduled Task **`Hermes_Gateway`** (at logon) - **retired.** Logon now starts nothing;
  the gateway is started manually or by the keepalive.
- Desktop: `Desktop\Hermes-Desktop.vbs` runs `ctl ensure --wait 120` before launching
  Electron, so a stale or wedged gateway can never leave the UI on "Connecting…".

## Commands

```bash
PY=<newest tools\python-*>\python.exe
"$PY" hermes_gateway_ctl.py status --json      # probe only
"$PY" hermes_gateway_ctl.py ensure             # heal if unhealthy, no-op if fine
"$PY" hermes_gateway_ctl.py restart
"$PY" hermes_gateway_ctl.py selftest           # proves HTTP probe vs a throwaway server
```

`scripts/gateway-ctl.log` gets one line per action; start there when the UI misbehaves.

## Hard rules that still apply

- Never launch the gateway or the Desktop elevated. An admin-owned socket on `:8642` makes the
  non-elevated Desktop report `Gateway inaccessible (gateway_elevated)`.
- Never `taskkill` Hermes image-wide; never kill the CLI/TUI session you are working in.
- `hermes update` regenerates `gateway-service\Hermes_Gateway.cmd/.vbs` only while a gateway
  task or Startup entry exists (`gateway_windows.is_installed()`). With the logon task
  uninstalled it regenerates nothing, which is what keeps this cleanup durable.

## Retired 2026-11-12

`gateway-keepalive.vbs`, `gateway-keepalive-check.py`, `silent-gateway-default.vbs`,
`Hermes_Gateway.cmd`, `elevate-fix-gateway-tasks.cmd`. Archived on the host at
`%LOCALAPPDATA%\hermes\backups\gateway-cleanup-20261112.tar.gz`.
