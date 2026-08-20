# Aria Full Assessment — Consolidated Fix Plan

Date: 2026-08-20 · Branch: `aria/3way-match-gate-fix` · Coordinator: Hermia

## Baseline (measured)
- Dirty tree: **75 entries** (47 modified, 17 deleted, ~25 untracked `scripts/_tmp_*` scratch).
- Branch vs main: 45 commits, 125 files, +18,882 / −4,030.
- Tests: 243 files, **2390 passed / 10 skipped / 2 todo**, but **1 deterministic failure** (cron import hook timeout).
- Installed Next **15.5.12** (docs said 14 — fixed AGENTS.md).

## Fix order (owner / effort)

### Phase 0 — Green the test gate
1. **Cron registration import timeout.** `src/cron/jobs/index.ts:25` top-level `import { OpsManager }` pulls the whole OpsManager→Gmail→embedding→telegram graph at import (118s). Make handler deps dynamic; the `await import()` pattern already exists inside handlers (`index.ts:42,68`). Owner: **coder** · S/M.

### Phase 1 — Voice & process correctness (cheap, high-leverage)
2. **Strip emojis from outbound templates.** cron `index.ts:265,702,1326,1398,1530`; `comms-service.ts:62,85,132,155`; `persona.ts` TELEGRAM_CONFIG. Owner: **coder** · S.
3. **Repair `persona.ts`.** `owner Will → Bill`; drop "sent to Claude"; rewrite welcome to Bill voice. Owner: **coder** · S.
4. **Name drift sweep (docs).** "Will" → "Bill" in `CLAUDE.md` (lines 7,170,184,212,296,297,408,410) + confirm `persona.ts`. Owner: **Hermia** · S.
5. **Doc drift.** AGENTS Next 14→15 (done); `CLAUDE.md:148` dead slack ref (done); `@supabase/supabase-js` still in deps despite cloud removal. Owner: **Hermia** · S.
6. **Dead refs.** Only real leftover: `src/cron/jobs/index.ts:988` (comment citing `lib/slack/followup-sop.ts`). Coder's `sku-aliases.ts:4,9` + `start-bot.ts:509` refs were phantom — verified no `slack` match in those files. Owner: **coder** · S.
7. **Mechanical voice gate.** Lint/test rule that fails on emoji/AI-isms in outbound template strings. Owner: **reviewer → coder** · M.
8. **Codify draft→review→send SOP** so the gate has teeth beyond memory. Owner: **reviewer** · S.

### Phase 2 — Type safety + structure (staged, L)
9. **`strict: false` on app build path** (`tsconfig.json:17`), while CLI/check are strict. ~1,957 `: any` in non-test src. Stage via `tsconfig.check.json` include list. Owner: **coder** · L.
10. **God-files.** `finale/purchasing.ts` (3,598), `finale/reconciler.ts` (3,281), `intelligence/ap-agent.ts` (2,428), `finale/receivings.ts` (1,741), `ap-local-forwarder.ts` (1,674), `cron/jobs/index.ts` (1,631). Extraction targets. Owner: **coder** · L (defer to after green).

### Phase 3 — Branch hygiene
11. **Scope creep.** Land or split `aria/3way-match-gate-fix`; delete `scripts/_tmp_*` + `scripts/sticker-*.py` scratch. Owner: **Hermia** · S/M.

### Phase 4 — Final gate (last, mutates :3001)
12. **`next build` + pm2 restart + live verify** + panel health + `?bust=1` data integrity. Owner: **dashboard** · M.

## File ownership (collision guard)
`src/cron/jobs/index.ts` is touched by #1, #2, #6 → **coder owns that file for all three**. I touch only docs/plans + branch hygiene. Reviewer owns SOP + the gate-rule spec (hands code to coder).

## Tooling gaps (from "coding nirvana")
- `eslint` runs ~5min with no `--cache`, no parallelism, flat `FlatCompat`. Add `--cache` + `lint-staged` + a pre-commit hook.
- `typecheck` OOMs (>8GB heap) — `next build` skips type-checking (`ignoreBuildErrors: true`). Treat build as the type gate; bump heap or split compile if we want real type-check on the app path.
- No CI.
