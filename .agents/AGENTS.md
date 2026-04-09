 Here is the complete, ready-to-copy agents.md file with your entire original content preserved + the new OpenCode + OpenRouter best practices section integrated at the top.Copy everything below (including the first line) and replace your current agents.md:markdown

# ARIA — Agent Reference Guide

> **Start here:** Read `docs/SYSTEM.md` first (coordinator + routing table).  
> **Current state:** Read `docs/STATUS.md` for live operational status.

> [!TIP]
> All workflows have `// turbo-all` enabled — terminal commands auto-execute without prompting.

---

## 🚀 OpenCode + OpenRouter Best Practices (ARIA Edition)

**This section is read automatically by OpenCode.** It tells every agent exactly how to behave when running inside Antigravity + OpenCode.

### 1. How to Run ARIA Agents in OpenCode
```powershell
opencode                  # ← best: interactive TUI (recommended)
opencode run "your task"  # quick one-off

Inside the TUI use these slash commands:/plan → create step-by-step plan before any code
/build → execute plan (edits files, runs terminal, tests)
/improve → refine previous output
/models → switch LLM instantly
/debug-fix or /test-fix-loop → use your existing workflows

2. Recommended Models (OpenRouter IDs) — April 2026Use Case
Recommended Model (exact ID)
Why it wins for ARIA
Cost
Context
Default daily driver
anthropic/claude-sonnet-4.6
Best balance of speed + tool use + reliability
Medium
1M
Heavy reasoning / orchestration
anthropic/claude-opus-4.6
Complex planning, multi-agent coordination
Higher
1M
Long-horizon autonomous tasks
z-ai/glm-5.1
8+ hour autonomous coding & self-improvement
Medium
203K
Zero-cost agentic coding
qwen/qwen3.6-plus:free
78.8 SWE-bench, excellent repo-level & front-end
Free
1M
Pure coding / fast edits
qwen/qwen3-coder:free
Current strongest free pure coder
Free
262K
PDF + vision-heavy (pdf-pipeline)
google/gemma-4-31b-it:free or z-ai/glm-5v-turbo
Strong multimodal + document understanding
Free / Medium
256K+

Pro strategy:Start every session with Sonnet 4.6 or Qwen3.6-plus:free.
Switch to Opus 4.6 or GLM-5.1 only for /plan on big refactors or orchestration changes.
Use free models (:free) for crons, tests, PDF processing, and routine tasks.

3. Model Switching & DefaultsIn OpenCode TUI → /models → pick any model above.
To set a permanent default for this project, add to your PowerShell profile:powershell

$env:OPENAI_MODEL = "qwen/qwen3.6-plus:free"   # change as needed

Never let the default fall back to Google Gemini — always force an OpenRouter model.

4. ARIA-Specific Rules for OpenCodeAlways respect the Dependency Graph and Quick Start table below.
When invoking workflows (/github, /migration, /reconcile-vendor-po, etc.) treat them as first-class tools.
For any task involving pdf-pipeline, ap-pipeline, or reorder → prefer models with strong tool-calling (Claude family or GLM-5.1).
Before any code change: run /plan + verification-before-completion.
After any change: trigger test-fix-loop or requesting-code-review.

Quick Start — Which Agents Do I Need?If the task involves…
Read these agents
AP invoices, email, reconciliation
ap-pipeline → pdf-pipeline → finale-ops
Build risk, calendar, BOMs
build-risk → finale-ops
Telegram bot tools, persona
bot-tools
Dashboard UI, API routes, panels
dashboard
Finale API queries/mutations
finale-ops
Pinecone memory, recall
memory-pinecone
Cron jobs, scheduled tasks
ops-manager
PDF OCR, extraction, parsing
pdf-pipeline
Reorder engine, purchasing, draft POs
reorder → finale-ops
Slack monitoring,  reactions
slack-watchdog
Database schema, queries, migrations
supabase
Vendor enrichment, PO correlation
vendor-intelligence

Dependency Graph

ops-manager (orchestrator — all crons)
├──→ ap-pipeline ──→ pdf-pipeline (OCR cascade)
│       ├──→ finale-ops (PO matching, reconciliation writes)
│       ├──→ vendor-intelligence ──→ memory-pinecone
│       └──→ supabase (ap_activity_log, documents)
├──→ build-risk ──→ finale-ops (stock queries)
└──→ vendor-intelligence (PO sync cron)

bot-tools (Telegram — user-facing entry point)
├──→ finale-ops, memory-pinecone, supabase
├──→ build-risk, reorder, ap-pipeline (via tool_calls)
└──→ slack-watchdog (inside same process)

dashboard (Next.js — web UI entry point)
├──→ finale-ops, supabase (via API routes)
└──→ ap-pipeline (invoice approve/dismiss)

reorder ──→ finale-ops (velocity engine, draft PO)
slack-watchdog ──→ memory-pinecone (dedup), supabase (product catalog)

Infrastructure Agents (no internal dependencies)Agent
External Only
finale-ops
Finale REST/GraphQL API
supabase
Supabase PostgreSQL
memory-pinecone
Pinecone vector DB
pdf-pipeline
Gemini, Anthropic, OpenAI, OpenRouter APIs

All Agents (.agents/agents/)Agent
Domain
Depends On
Depended On By
ap-pipeline
Invoice processing pipeline
pdf, finale, vendor, supabase
ops-manager, bot-tools, dashboard
bot-tools
Telegram bot + tool system
finale, memory, supabase, build-risk, reorder, ap
(user-facing entry)
build-risk
Calendar BOM risk analysis
finale
ops-manager, bot-tools, dashboard
dashboard
Next.js web UI + API routes
finale, supabase, ap-pipeline
(user-facing entry)
finale-ops
Finale Inventory API
(external only)
ap, build-risk, reorder, bot, dashboard, vendor
memory-pinecone
Pinecone vector memory
(external only)
bot-tools, slack-watchdog, vendor, ap
ops-manager
Cron scheduler + orchestration
ap, build-risk, vendor
(top-level orchestrator)
pdf-pipeline
PDF OCR + parsing
(external only)
ap-pipeline
reorder
Reorder engine + draft POs
finale
bot-tools, dashboard
slack-watchdog
Slack monitoring (eyes-only)
memory, supabase
(inside aria-bot)
supabase
Database operations
(external only)
nearly all agents
vendor-intelligence
Vendor enrichment + correlation
memory, supabase, finale
ap-pipeline, ops-manager

Workflows (.agents/workflows/)Invoke with /command-name in any agent session.Command
File
Description
/github
github.md
Git commit & push — branching, conventional commits, PR rules, release tagging
/migration
migration.md
SQL migration flow — create, apply, and verify Supabase migrations
/vendor-invoice-archive
vendor-invoice-archive.md
MANDATORY — every new vendor process MUST archive invoices to vendor_invoices
/reconcile-vendor-po
reconcile-vendor-po.md
Reconcile vendor order confirmations against Finale POs
/debug-fix
debug-fix.md
Debug & fix specialist — diagnose and repair a single failing test or lint error
/plan-fix
plan-fix.md
Pre-flight fix planner — read-only failure analysis with ranked fix order
/test-fix-loop
test-fix-loop.md
Test loop agent rules — global rules applied to all test workflow agents
/test-loop
test-loop.md
Self-healing test loop — auto-run, diagnose, fix, re-test until green
/sync-globals
sync-globals.md
Re-sync global workflows from ~/.gemini/antigravity/global_workflows/

Skills (.agents/skills/)Skills are automatically invoked by the agent when relevant. No slash command needed.Skill
When it activates
brainstorming
Before any creative work — features, components, behavior changes
dispatching-parallel-agents
2+ independent tasks that can run without shared state
executing-plans
Executing a written implementation plan with review checkpoints
finishing-a-development-branch
Work is complete, deciding how to integrate (merge, PR, cleanup)
firecrawl
Web scraping, search, crawling, browser automation
receiving-code-review
Processing code review feedback before implementing suggestions
requesting-code-review
Completing tasks, verifying work meets requirements
subagent-driven-development
Executing plans with independent tasks in current session
systematic-debugging
Any bug, test failure, or unexpected behavior
test-driven-development
Before writing implementation code for any feature or bugfix
using-git-worktrees
Starting feature work that needs isolation from current workspace
using-superpowers
Session startup — establishes how to find and use skills
verification-before-completion
Before claiming work is complete — evidence before assertions
writing-plans
Multi-step task with spec/requirements, before touching code
writing-skills
Creating, editing, or verifying skills

InfrastructureItem
Path
Purpose
System coordinator
docs/SYSTEM.md
Read FIRST — routing table + dependency graph
Operational status
docs/STATUS.md
Living state — known issues, recent changes
Deep reference
CLAUDE.md
Full 314-line implementation reference
AP pipeline SOP
docs/ap-pipeline-sop.md
Detailed AP standard operating procedures
Sync script
.agents/scripts/sync-global-workflows.ps1
Re-copies global workflows into project
Global source
~/.gemini/antigravity/global_workflows/
Master copies of shared workflows

Last updated: 2026-04-07

Just paste this entire block into your `agents.md` file and save. OpenCode will now automatically use these OpenRouter best practices on every run.

You're all set! Want me to also create a quick PowerShell one-liner to set your favorite default model right now? Just tell me which model you want as default. 🚀

