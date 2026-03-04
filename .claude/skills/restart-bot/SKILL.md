---
name: restart-bot
description: |
  Typecheck the project and restart aria-bot via PM2. Use after any code change to start-bot.ts
  or any file it imports. Automatically filters known pre-existing TS errors.
allowed-tools:
  - Bash(npx tsc *)
  - Bash(pm2 *)
---

# Restart Bot (Aria)

Full workflow for safely restarting aria-bot after code changes.

## Steps

### 1. Type-check (filter known pre-existing errors)
```bash
npx tsc --noEmit 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"
```

If this outputs real errors → fix them before restarting.

### 2. Restart
```bash
pm2 restart aria-bot
```

### 3. Verify
```bash
pm2 logs aria-bot --lines 30
```

Look for:
- `Aria bot started` or similar startup confirmation
- No `Error:` or `Cannot find module` lines
- Tool registration confirmations

## When to Use
- After any edit to `src/cli/start-bot.ts`
- After any edit to a file imported by start-bot.ts (lib/intelligence/*, lib/finale/*, etc.)
- After adding a new bot tool

## Notes
- `pm2 restart aria-bot` silently drops all in-memory state:
  - `pendingApprovals` in `reconciler.ts` (24h TTL — lost!)
  - `pendingDropships` in `dropship-store.ts` (48h TTL — lost!)
- Check with Will if there are pending approval requests before restarting in production
