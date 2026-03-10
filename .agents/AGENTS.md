# ARIA — Agent Reference Guide

Quick reference for all workflows, skills, and agents available in this project.

> [!TIP]
> All workflows have `// turbo-all` enabled — terminal commands auto-execute without prompting.

---

## Workflows (`.agents/workflows/`)

Invoke with `/command-name` in any agent session.

| Command | File | Description |
|---|---|---|
| `/github` | `github.md` | Git commit & push — branching, conventional commits, PR rules, release tagging |
| `/migration` | `migration.md` | SQL migration flow — create, apply, and verify Supabase migrations |
| `/debug-fix` | `debug-fix.md` | Debug & fix specialist — diagnose and repair a single failing test or lint error |
| `/plan-fix` | `plan-fix.md` | Pre-flight fix planner — read-only failure analysis with ranked fix order |
| `/test-fix-loop` | `test-fix-loop.md` | Test loop agent rules — global rules applied to all test workflow agents |
| `/test-loop` | `test-loop.md` | Self-healing test loop — auto-run, diagnose, fix, re-test until green |
| `/sync-globals` | `sync-globals.md` | Re-sync global workflows from `~/.gemini/antigravity/global_workflows/` |

---

## Skills (`.agents/skills/`)

Skills are automatically invoked by the agent when relevant. No slash command needed.

| Skill | When it activates |
|---|---|
| `brainstorming` | Before any creative work — features, components, behavior changes |
| `dispatching-parallel-agents` | 2+ independent tasks that can run without shared state |
| `executing-plans` | Executing a written implementation plan with review checkpoints |
| `finishing-a-development-branch` | Work is complete, deciding how to integrate (merge, PR, cleanup) |
| `firecrawl` | Web scraping, search, crawling, browser automation |
| `receiving-code-review` | Processing code review feedback before implementing suggestions |
| `requesting-code-review` | Completing tasks, verifying work meets requirements |
| `subagent-driven-development` | Executing plans with independent tasks in current session |
| `systematic-debugging` | Any bug, test failure, or unexpected behavior |
| `test-driven-development` | Before writing implementation code for any feature or bugfix |
| `using-git-worktrees` | Starting feature work that needs isolation from current workspace |
| `using-superpowers` | Session startup — establishes how to find and use skills |
| `verification-before-completion` | Before claiming work is complete — evidence before assertions |
| `writing-plans` | Multi-step task with spec/requirements, before touching code |
| `writing-skills` | Creating, editing, or verifying skills |

---

## Agents (`.agents/agents/`)

Domain-specific agent personas with specialized knowledge and responsibilities.

| Agent | Domain |
|---|---|
| `ap-pipeline` | Accounts payable pipeline operations |
| `bot-tools` | Bot tooling and integrations |
| `build-risk` | Build risk assessment and mitigation |
| `dashboard` | Dashboard UI and data visualization |
| `finale-ops` | Finale Inventory API operations |
| `memory-pinecone` | Pinecone vector memory management |
| `ops-manager` | Operations management and orchestration |
| `pdf-pipeline` | PDF processing pipeline |
| `reorder` | Inventory reorder logic and purchasing |
| `slack-watchdog` | Slack monitoring and alerting |
| `supabase` | Supabase database operations |
| `vendor-intelligence` | Vendor data analysis and intelligence |

---

## Infrastructure

| Item | Path | Purpose |
|---|---|---|
| Sync script | `.agents/scripts/sync-global-workflows.ps1` | Re-copies global workflows into project |
| Global source | `~/.gemini/antigravity/global_workflows/` | Master copies of shared workflows |

---

*Last updated: 2026-03-10*
