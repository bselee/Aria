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
main          → the only branch. All commits go here directly.
```

**Rules:**
- Commit directly to `main`. No feature branches, no PRs.
- Use Conventional Commit messages on every commit.
- Push after every logical change.
- If you need to experiment, use `git stash` — not a branch.

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

---

## 4. COMMIT & PUSH WORKFLOW (STEP BY STEP)

```bash
# 1. Stage your changes
git add -A

# 2. Commit with a conventional commit message
git commit -m "type(scope): description"

# 3. Push to main
git push origin main
```

That's it. No branches, no PRs, no ceremony.

---

## 5. WHAT NEVER GOES IN GIT

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

---

## 6. AGENT-SPECIFIC GIT RULES

When an AI agent is performing git operations in this repo:

```
- Commit directly to main. No feature branches.
- Always push to main after committing.
- Commit messages must follow Conventional Commits format.
- Do not amend commits that have already been pushed.
- After completing a task, output the commit SHA and a summary of what changed.
- If a migration file was created, call that out explicitly in the summary.
```

---

```
END OF GITHUB WORKFLOW
```