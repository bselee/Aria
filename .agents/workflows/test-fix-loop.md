---
description: Test loop agent rules — global rules for the self-healing test workflow
---
// turbo-all

# Test Loop Agent Rules
# Applied globally to all agents in this workflow

## Stack Context
- Framework: Next.js 14 (App Router)
- Database: Supabase (PostgreSQL + RLS)
- ORM: Direct Supabase client + generated types
- State: Zustand / React Query
- Tests: Vitest + React Testing Library
- Deploy: Vercel (preview + production)
- Inventory: Finale Inventory REST API
- Repo: antigravity / MuRP

## Branching Rules
- NEVER commit to `main` directly
- NEVER commit to `production` directly
- Auto-fixes go to: `fix/auto-loop-<YYYY-MM-DD>` branch
- If branch exists, append `-<N>` suffix

## Code Quality Rules
- TypeScript strict mode is ON — do not disable it
- No `@ts-ignore` without a comment explaining why
- No `as any` unless truly unavoidable — add `// TODO: fix type` if used
- ESLint errors must be fixed, not suppressed with `eslint-disable`
- All Supabase queries must handle the `error` return value

## Supabase-Specific Rules
- Never modify migration files — flag `REQUIRES_MIGRATION` instead
- RLS policies are intentional — don't work around them in code
- Generated types in `src/lib/supabase/database.types.ts` are source of truth
- If types are stale, instruct user to run: `npx supabase gen types typescript --local > src/lib/supabase/database.types.ts`

## Finale API Rules
- Never call Finale API in unit tests — use mocks in `src/__mocks__/finale.ts`
- Rate limit: 10 req/sec — always check for rate limit errors in integration tests
- REST filtering on orders is broken upstream — do not add tests relying on it

## Test Rules
- Never delete a test to make the suite pass
- Never change test expectations without a comment explaining why
- If a test is genuinely wrong, mark it: `// TEST BUG: <explanation>` and fix it
- Flaky tests get a `// FLAKY: <reason>` comment and a retry wrapper, not deletion

## Escalation Triggers
Always escalate to human (never auto-fix) when:
- Business logic is ambiguous (e.g., which velocity window to use)
- A Supabase migration is required
- An environment variable is missing
- The fix would change API response shapes consumed by external systems
- Confidence in the fix is LOW
- The same error appears in 3+ consecutive iterations (likely a deeper issue)

## Commit Message Format (when user approves)
```
fix(auto): <short description>

- <change 1>
- <change 2>

Auto-fixed by /test-loop in <N> iterations.
Failures resolved: <N>
Files changed: <N>
```
