---
description: Github Commit and Push Workflow
---
// turbo-all

# ANTIGRAVITY — GLOBAL GITHUB COMMIT & PUSH WORKFLOW
# Universal rules for every developer and AI agent working in this codebase.
# Last Updated: 2026-02-20

---

## 1. BRANCH STRATEGY

```
main          → production only. Protected. No direct pushes. Ever.
staging       → pre-prod. Auto-deploys to staging environment on merge.
dev           → integration branch. All features land here first.
feature/*     → new functionality  (branch from dev)
fix/*         → bug fixes          (branch from dev)
hotfix/*      → critical prod fix  (branch from main, merge to main + dev)
chore/*       → deps, config, non-functional changes
docs/*        → documentation only
```

**Rules:**
- Always branch from `dev` unless it's a hotfix.
- Branch names use kebab-case: `feature/reorder-threshold-alerts`
- Delete feature branches after merge. Keep the tree clean.
- Never commit directly to `dev`, `staging`, or `main`.

---

## 2. COMMIT MESSAGE FORMAT (CONVENTIONAL COMMITS)

```
type(scope): short imperative description  ← max 72 chars

- Optional detail bullet
- BREAKING CHANGE: what breaks + migration path
- Refs: #issue-number
```

**Valid types:**

| Type       | When to use                                      |
|------------|--------------------------------------------------|
| `feat`     | New feature or capability                        |
| `fix`      | Bug fix                                          |
| `docs`     | Documentation only                               |
| `style`    | Formatting, no logic change                      |
| `refactor` | Code change with no feature or fix               |
| `test`     | Adding or updating tests                         |
| `chore`    | Build process, deps, config                      |
| `perf`     | Performance improvement                          |
| `ci`       | CI/CD pipeline changes                           |
| `revert`   | Reverts a previous commit                        |
| `migrate`  | Database or service migration                    |

**Examples:**
```
feat(purchasing): add reorder threshold alert to PO dashboard

- Displays inline warning when on-hand qty falls below par level
- Threshold values read from inventory_config per SKU
- Refs: #142

fix(auth): redirect to /login on expired session instead of throwing 500

test(inventory): add edge case coverage for zero-quantity BOM explosion

migrate(supabase): add vendor_lead_times column to skus table

chore(deps): upgrade supabase-js to v2.39.0
```

**Anti-patterns — never write these:**
```
❌ fix stuff
❌ WIP
❌ updates
❌ asdf
❌ final final v2
❌ misc changes
```

---

## 3. ATOMIC COMMIT RULES

Each commit = one logical change, independently understandable and revertable.

If your commit message contains "and" between two unrelated things, split it.

```
✅ feat(ui): add skeleton loader to PO list
✅ fix(ui): correct spacing on PO list header

❌ feat(ui): add skeleton loader and fix header spacing and update colors
```

**Commit often. Push thoughtfully.**
Small commits while working locally are fine. Clean up with interactive rebase
before opening a PR if needed: `git rebase -i origin/dev`

---

## 4. PRE-COMMIT CHECKLIST (RUN BEFORE EVERY PUSH)

These run automatically via Husky. Understand what they check.

```bash
✓ Lint passes          — ESLint, zero warnings promoted to errors
✓ Type check passes    — tsc --noEmit, strict mode, zero untyped any
✓ Tests pass           — all unit tests green
✓ No console.log       — not in production code paths
✓ No .env files staged — never commit secrets
✓ Commit message lint  — commitlint enforces Conventional Commits format
```

**Setup (one time per repo clone):**
```bash
npm install
npm run prepare        # installs Husky hooks
```

**Override in emergencies only:**
```bash
git commit --no-verify -m "hotfix(auth): emergency patch for session expiry"
# You must document WHY you bypassed hooks in the PR description.
```

---

## 5. DAILY PUSH WORKFLOW (STEP BY STEP)

```bash
# 1. Start from an updated dev branch
git checkout dev
git pull origin dev

# 2. Create your feature branch
git checkout -b feature/your-feature-name

# 3. Work. Commit atomically as you go.
git add -p                    # stage hunks, not whole files blindly
git commit -m "feat(scope): description"

# 4. Keep your branch current with dev (rebase, not merge)
git fetch origin
git rebase origin/dev

# 5. Before pushing, verify everything locally
npm run lint
npm run typecheck
npm run test

# 6. Push your branch
git push origin feature/your-feature-name

# 7. Open a PR to dev (not main, not staging)
# Fill out the PR template completely.
```

---

## 6. PULL REQUEST REQUIREMENTS

Every PR must have all of the following before requesting review:

```
Title:    type(scope): description  ← matches commit format
Branch:   feature/* → dev  (or hotfix/* → main)

Description must include:
  [ ] What changed and why
  [ ] How to test it manually
  [ ] Screenshots or screen recording for UI changes
  [ ] Migration notes if DB or service state changed
  [ ] Rollback steps for any destructive or risky change
  [ ] Link to ticket(s)

Checklist:
  [ ] Self-reviewed the full diff line by line
  [ ] All CI checks passing
  [ ] No unresolved comments from previous reviews
  [ ] .env.example updated if new env vars added
  [ ] README updated if setup or behavior changed
  [ ] Tests added or updated
```

**PR Size Guidelines:**
- Aim for PRs reviewable in under 20 minutes.
- If a PR exceeds ~400 lines changed, consider splitting it.
- Draft PRs are encouraged for early feedback on direction.

---

## 7. MERGE STRATEGY

| From → To          | Strategy         | Why                                    |
|--------------------|------------------|----------------------------------------|
| `feature/*` → dev  | Squash & merge   | Clean dev history, one logical commit  |
| `fix/*` → dev      | Squash & merge   | Same                                   |
| `dev` → staging    | Merge commit     | Preserves integration history          |
| `staging` → main   | Merge commit     | Full audit trail to production         |
| `hotfix/*` → main  | Squash & merge   | Minimal blast radius                   |
| `hotfix/*` → dev   | Cherry-pick      | Backport the fix without merge noise   |

**After merge:** delete the source branch immediately.

---

## 8. RELEASE TAGGING

Tag every production deploy on `main` using semver.

```bash
# After staging → main merge
git checkout main
git pull origin main
git tag -a v1.2.3 -m "Release v1.2.3 — add reorder alerts, fix session expiry"
git push origin v1.2.3
```

**Semver rules:**
```
v1.0.0  → Major: breaking changes, significant rewrites
v1.1.0  → Minor: new features, backwards compatible
v1.1.1  → Patch: bug fixes, no new behavior
```

Update `CHANGELOG.md` with every release tag. Format:
```md
## [1.2.3] — 2026-02-20

### Added
- Reorder threshold alert banner on PO dashboard (#142)

### Fixed
- Session expiry now redirects to /login instead of 500 (#156)

### Migration
- Run: `npm run migrate` — adds `reorder_threshold` to skus table
```

---

## 9. CI/CD GATE OVERVIEW

```
Push to any branch
      │
      ▼
┌─────────────────┐
│  CI: PR Checks  │  lint + typecheck + tests + build
└────────┬────────┘
         │ must be green to merge
         ▼
    Merge to dev
         │
         ▼
┌────────────────────┐
│  Auto: Staging     │  deploy to staging + run migrations
│  Deploy            │  smoke tests run against staging URL
└────────┬───────────┘
         │
         ▼
    PR: staging → main
         │
         ▼
┌────────────────────┐
│  Gate: Manual      │  human approval required (Will)
│  Approval          │  dry-run migration shown in PR
└────────┬───────────┘
         │ approved
         ▼
┌────────────────────┐
│  Auto: Production  │  deploy + migrate + verify
│  Deploy            │  Slack notification on success/failure
└────────────────────┘
```

No code reaches production without: green CI + staging validation + manual approval.

---

## 10. HOTFIX PROCEDURE

For critical production bugs only. Do not abuse this path.

```bash
# 1. Branch from main (not dev)
git checkout main
git pull origin main
git checkout -b hotfix/fix-session-expiry-500

# 2. Make the minimal fix. One commit.
git add -p
git commit -m "fix(auth): redirect to /login on expired session token"

# 3. Push and open PR directly to main
git push origin hotfix/fix-session-expiry-500
# PR → main, not dev. Document the emergency in PR description.

# 4. After merge to main: tag the release
git checkout main && git pull
git tag -a v1.1.1 -m "Hotfix v1.1.1 — session expiry redirect"
git push origin v1.1.1

# 5. Backport to dev
git checkout dev
git cherry-pick <commit-sha>
git push origin dev

# 6. Post-mortem in the PR or a follow-up ticket
# What broke, why, how it was fixed, how to prevent recurrence.
```

---

## 11. WHAT NEVER GOES IN GIT

```
.env
.env.local
.env.production
.env.staging
*.pem / *.key
node_modules/
.next/
dist/
*.log
migration_ledger.*.json   ← local dev state only
```

If a secret is ever accidentally committed:
1. Rotate the credential immediately — treat it as compromised.
2. Remove from history: `git filter-repo --path secret-file --invert-paths`
3. Force push: `git push origin --force --all`
4. Notify the team.
Removing from history is not enough on its own — always rotate first.

---

## 12. AGENT-SPECIFIC GIT RULES

When an AI agent is performing git operations in this repo:

```
- Never push directly to main, staging, or dev.
- Always create a feature/* or fix/* branch for changes.
- Commit messages must follow Conventional Commits format.
- Never use --no-verify unless explicitly instructed by a human.
- Do not amend commits that have already been pushed.
- After completing a task, output the branch name, commit SHA,
  and a summary of what changed so the human can open the PR.
- Never run git push --force except on your own feature branches,
  and only after confirming no one else is working on that branch.
- If a migration file was created, call that out explicitly in the summary.
```

---

```
END OF GITHUB WORKFLOW
This file lives at the repo root or /docs/GITHUB_WORKFLOW.md.
Reference it in your agent rules and onboarding docs.
```