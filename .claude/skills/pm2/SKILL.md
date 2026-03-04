---
name: pm2
description: |
  PM2 process management for Aria's two background services (aria-bot, aria-slack).
  Use to check status, view logs, restart services, or debug startup failures.
allowed-tools:
  - Bash(pm2 *)
---

# PM2 Process Management (Aria)

Aria runs two PM2-managed processes defined in `ecosystem.config.cjs`.

## Processes
| Name | Entry | Purpose |
|------|-------|---------|
| `aria-bot` | `src/cli/start-bot.ts` | Telegram bot (primary) |
| `aria-slack` | `src/cli/start-slack.ts` | Slack watchdog (secondary) |

## Common Commands

### Status
```bash
pm2 list              # All processes with status, CPU, memory, restarts
pm2 monit             # Real-time dashboard
```

### Logs
```bash
pm2 logs              # Tail all logs
pm2 logs aria-bot     # Bot logs only
pm2 logs aria-slack   # Slack watchdog logs only
pm2 logs aria-bot --lines 50   # Last 50 lines
pm2 logs --err        # Error logs only
```

### Restart / Stop
```bash
pm2 restart aria-bot          # Restart bot (drops in-memory state!)
pm2 restart aria-slack        # Restart Slack watchdog
pm2 stop aria-bot             # Stop without removing
pm2 start ecosystem.config.cjs --only aria-bot   # Start from config
```

### Start Both
```bash
pm2 start ecosystem.config.cjs   # Start all processes
```

### Persist Across Reboots
```bash
pm2 save              # Save current process list
pm2 startup           # Generate OS startup script
```

## ⚠️ Restart Warning
`pm2 restart aria-bot` silently drops:
- `pendingApprovals` in `reconciler.ts` (24h TTL — Telegram approval requests)
- `pendingDropships` in `dropship-store.ts` (48h TTL — unmatched invoices)

Check with Will before restarting if approvals are pending.

## Debugging Startup Failures
```bash
pm2 logs aria-bot --lines 100
# Look for:
# - "Cannot find module" → missing dependency or wrong path
# - "SyntaxError" or "TypeError" → code error (run typecheck first)
# - "EADDRINUSE" → port conflict
# - Env var errors → .env.local not loading
```

## Environment Variables
PM2 does NOT use `env_file`. Each script loads `.env.local` internally via:
```typescript
dotenv.config({ path: '.env.local' })
```
