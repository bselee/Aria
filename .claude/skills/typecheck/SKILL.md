---
name: typecheck
description: |
  Run TypeScript type-check with correct filters for Aria. Suppresses pre-existing
  errors in finale/client.ts, folder-watcher, and validator. No output = clean.
allowed-tools:
  - Bash(npm run typecheck*)
---

# TypeScript Type Check (Aria)

```bash
npm run typecheck 2>&1 | grep -v "finale/client.ts" | grep "error TS" | grep -v "folder-watcher\|validator"
```

**No output = clean.** Any `error TS` lines are real errors to fix.

After fixing errors, restart: `/restart-bot`
