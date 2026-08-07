# Startup Efficiency Audit + Honcho/Obsidian Restoration Plan

**Date:** 2026-08-06
**Host:** DESKTOP-P2IVTVA — Windows 10 Pro 19045, 32 GB RAM, 466 GB C: (202 GB free)
**Boot:** 07:58:58 MDT. PM2 daemon up 07:59:46, all 4 apps online by 07:59:47 (~1s).
**Author:** Hermia
**Status:** PLAN ONLY — no changes executed. Awaiting Bill's approval.

---

## 0. Correction to my first-pass report

Three claims I made earlier were wrong or overstated. Recording them so the record is clean:

| First-pass claim | Reality |
|---|---|
| "Desktop log is 90% emoji spam" | **14%** (3,186 of 21,560 lines). Overstated. |
| "Trim/rotate desktop.log to reclaim disk" | Log hygiene is **fine** — 25 MB total, `pm2-logrotate` active (10M/retain 3). Non-issue. |
| "`aria-launcher.py` ghost reference" — framed as the notable find | True but trivial. I **missed the registry Run keys entirely** on first pass — a far bigger startup vector (17 entries). |

Root process error: I reported before enumerating all startup vectors. Registry Run keys, `StartupApproved` enable-state, and the `<Hidden>` XML attribute on scheduled tasks were all unexamined.

---

## 1. The real headline: Honcho has been dead ~23 days and Obsidian knowledge capture died with it

This is not a startup-cosmetics issue. It is silent, ongoing knowledge loss.

### Evidence chain

| Fact | Evidence |
|---|---|
| Honcho is down | `curl localhost:8000/health` → **HTTP 000** (exit 7) |
| Root cause | `wsl --list --verbose` → `Ubuntu  **Stopped**  2` — the VM hosting Honcho's Docker stack is not running |
| Obsidian vault frozen | Newest real content: `Decisions/2026-07-14-*.md`, `Vendors/*2026-07-14 Sync.md`. **Nothing since 2026-07-14.** |
| Only the failure log updates | `Aria/Honcho-Sync-Log.md` (mtime 2026-08-06 06:05) — appends "Honcho offline" **every single day** |
| Sync job is double-broken | `honcho-obsidian-sync` also fails with `skill not found, skipping — Skill 'devops/honcho-obsidian-sync' not found` — **21 occurrences** across errors.log{,.1,.2}, first seen 2026-07-14 |
| Alerts go nowhere | `honcho-health-watchdog` (every 30 min, `deliver=all`) → `WARNING cron.scheduler: Job 'b2707c163038': no delivery target resolved for deliver=all` |

### Why the skill "isn't found" — profile mismatch

The skill exists, but in the wrong profile:

```
MISSING: ~/AppData/Local/hermes/skills/devops/honcho-obsidian-sync          <- default gateway looks HERE
EXISTS:  ~/AppData/Local/hermes/profiles/hermia/skills/devops/honcho-obsidian-sync
```

All 24 cron jobs run on the **default** profile (verified: default=24 jobs, hermia/aria-ap/aria-research=0). The default gateway cannot resolve a skill that only lives under `profiles/hermia/`.

This is the exact pitfall my own `hermes-cron-ownership` skill documents:
> "Scripts only under `profiles/hermia/scripts/` fail under default gateway — copy to default `scripts/`."

The rule was written for scripts; **skills have the same failure mode and the skill doesn't say so.** → patch that skill (task 5.4).

### Memory provider divergence

| Profile | `memory.provider` |
|---|---|
| default (Desktop + all cron) | `builtin` |
| hermia | `honcho` |

So: Desktop chats persist to builtin memory and are safe. But the hermia profile is configured to write memory to a service that has been down for 23 days. `honcho: {}` is empty in both configs.

**Open question for Bill:** is hermia still used interactively? If yes, its memory writes have been failing silently.

### Why self-healing didn't fire

`honcho-wsl-watchdog` runs every 10 min, `no_agent: true`, script `honcho-wsl-watchdog.py`. The script *is* correctly present at the default path (`~/AppData/Local/hermes/scripts/honcho-wsl-watchdog.py`, byte-identical to the hermia copy), and its docstring says it wakes WSL and runs `docker compose up -d`.

So the watchdog exists and should be self-healing. It is **not** working. Unknown why — this is the #1 thing to determine, not guess. Candidates to test:
- `wsl true` (used by the script) may not cold-start a `Stopped` VM the way `wsl -d Ubuntu echo alive` does
- 8 GB WSL memory cap vs "7+ containers" may be OOM-killing the stack
- Docker daemon post-start hang (documented in `aria-infrastructure-recovery`)
- Script may be erroring before the heal step and exiting silently (`no_agent` + empty stdout = **silent by design**)

Also note `.wslconfig` sets `vmIdleTimeout=-1`, which the skill notes is **ignored** under memory pressure.

### Stale infra reference

The skill documents `wsl-proxy.js` as a PM2 process forwarding Windows→WSL ports. It does not exist:
- `scripts/wsl-proxy.js` → not found
- `ecosystem.config.json` → 0 matches for `wsl-proxy`

AGENTS.md also still lists `wsl-proxy` as a PM2 process. Both are stale — the data plane moved to native Postgres (`postgresql-x64-16` Running, PostgREST :5434 → 200). **If Honcho still needs port forwarding to reach WSL, that forwarder is simply gone** — which alone could explain permanent unreachability. Must be resolved before declaring Honcho "fixed."

---

## 2. The `deliver=all` blackhole — affects all 24 cron jobs, not just Honcho

```
WARNING gateway.run: No env user allowlists configured. Messaging platforms default to
pairing/allowlist policies and will deny unknown senders unless you configure platform
allowlists (e.g., TELEGRAM_ALLOWED_USERS=your_id) ...
```
Seen 2026-08-03 → 2026-08-06 (17 occurrences). Combined with `no delivery target resolved for deliver=all`, this means **cron alerts are generated and silently discarded.**

That is why a 23-day outage never reached Bill. **This is the most important fix in the document** — without it, every future watchdog is decorative. Fixing Honcho while leaving delivery broken guarantees the next silent outage.

---

## 3. Startup window inventory

Subagent enumerated every visible top-level window post-boot. **Verdict: only 3 entry points produce perceptible windows.** No `conhost`/`cmd` windows are visible now — boot flashes are transient.

### Smoking gun: no user scheduled task sets `<Hidden>true</Hidden>`

All 6 logon-triggered user tasks omit it. A task whose action is `cmd.exe` or `powershell.exe` without both `-WindowStyle Hidden` **and** `Hidden=true` flashes a console.

| Entry point | Mechanism | Window behavior |
|---|---|---|
| `hermes-desktop-launch.vbs` | Startup folder | **Persistent** (intended — the Desktop app) |
| `MicrosoftEdgeAutoLaunch_...` | HKCU Run, `msedge.exe --win-session-start` | **Persistent — 12 msedge processes. Prime suspect for Bill's complaint. Nothing to do with Aria/Hermes.** |
| `AriaPm2Resurrect` | Task, `cmd.exe /c node ...pm2.ps1 resurrect` | **Flashes console + FAILS (Last Result: 1)** — `pm2.ps1` is not a valid node target |
| `wsl-honcho-autostart.vbs` | Startup folder | Style-0, but `wsl.exe` can surface a transient window; fire-and-forget, no exit check |
| `Hermes_Gateway` | Task → `.cmd` running `python.exe` directly | `.cmd` + no `Hidden` → flash risk |
| `Hermes_Gateway_hermia` | Task → `.cmd` → hands off to `silent-gateway-hermia.vbs` | Correctly silent (good pattern to copy) |
| `PM2_Resurrect` | Task → `wscript` VBS | Silent |
| PM2 (HKCU Run) | `wscript silent-pm2-resurrect.vbs` | Silent |
| ScanSnap ×5, Brother ×3, DYMO ×3, Greenshot, ShareX, Wispr Flow, 1Password, OneDrive, SecurityHealth, RTHDVCPL | Registry Run | Tray/background |

### Triple-redundant PM2 resurrect

Three independent triggers race at logon:
1. `PM2_Resurrect` task → VBS (silent, exit 0) ✅
2. `PM2` HKCU Run → near-identical VBS (silent) ✅
3. `AriaPm2Resurrect` task → **broken + flashes** ❌

Harmless in effect (PM2 daemon is idempotent; log confirms one clean daemon, no restart storm) but 2 of 3 are pure waste and one is user-visible. The two VBS copies differ trivially: the Run-key version calls bare `node.exe` (PATH-dependent), the task version hardcodes `C:\Program Files\nodejs\node.exe` (more robust).

### Resource note

**Wispr Flow: 10 processes, ~1.4 GB RAM** — largest single consumer. Not a window problem; worth a separate look. RAM overall is healthy (21.4 GB free of 30.6 GB).

---

## 4. Other findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| 4.1 | `Tracking Validation Autopilot` pinned to dead model | `model: deepseek/deepseek-chat-v3-0324` via `provider: xai-oauth` → HTTP 404 "model does not exist". Every 30 min = **~48 failed calls/day** | Medium |
| 4.2 | xAI credits exhausted | `personal-team-blocked:spending-limit`. `honcho-obsidian-sync` pins `grok-4.5`/`xai-oauth` — would fail even with Honcho up | Medium |
| 4.3 | Auxiliary lane on a PAID model | Warns OpenRouter fallback `anthropic/claude-sonnet-5` "is not a :free SKU and may incur real spend" — contradicts Bill's free>paid preference | Medium |
| 4.4 | Gateway unclean exit | `Previous gateway life (pid=14816) exited UNCLEANLY (no exit path ran — SIGKILL/OOM/VM death)` | Low (likely shutdown) |
| 4.5 | Ghost `aria-launcher.py` | VBS checks a nonexistent file every boot | Cosmetic |
| 4.6 | Stale AGENTS.md | Lists `wsl-proxy` PM2 process; doesn't exist | Doc debt |
| 4.7 | PM2 version drift | in-memory 6.0.14 vs local 7.0.3 | Low — **do NOT `pm2 update` during business hours** |
| 4.8 | cua-driver outdated | 0.13.1 vs 0.17.0 | Low |

---

## 5. Proposed plan

### Phase 1 — Restore Honcho→Obsidian (Bill's priority)

Sequenced to *diagnose before healing*. Nothing here is destructive.

- **1.1** Cold-start WSL: `wsl -d Ubuntu echo alive` (use `-d`, **never** `-e` — `-e` hangs on systemd per `aria-infrastructure-recovery`)
- **1.2** Verify containers: `wsl -d Ubuntu -e bash -lc "cd /root/honcho && docker compose ps"` (expect 4)
- **1.3** Probe: `MSYS_NO_PATHCONV=1 curl -s --max-time 10 http://localhost:8000/health` → `{"status":"ok"}`
- **1.4** **If the container is up but localhost:8000 still fails → the missing `wsl-proxy` is the culprit.** Decide: restore a forwarder, or `netsh portproxy`, or move Honcho off WSL entirely.
- **1.5** Run the watchdog manually and **capture its output** to learn why it never self-healed: `python "$LOCALAPPDATA/hermes/scripts/honcho-wsl-watchdog.py"`. Fix the actual defect. Do not assume.
- **1.6** Copy the skill to the default profile so the sync job resolves:
  `profiles/hermia/skills/devops/honcho-obsidian-sync` → `skills/devops/honcho-obsidian-sync`
- **1.7** Repoint `honcho-obsidian-sync` off dead `grok-4.5`/`xai-oauth` onto a working provider
- **1.8** Trigger `cronjob action='run'` and confirm the vault gets **real content** — not another "offline" line. Success = new files under `Decisions/`/`Vendors/`, mtime today.
- **1.9** Decide hermia's `memory.provider: honcho` — repoint to `builtin` or accept dependency once healthy.

**Verification gate:** Phase 1 is complete only when a fresh non-"offline" vault entry exists. Log lines are not proof.

### Phase 2 — Fix alert delivery (do NOT skip; this is why the outage was invisible)

- **2.1** Determine intended target (Telegram chat id most likely) and configure the allowlist
- **2.2** Re-run `honcho-health-watchdog`, confirm a message actually **arrives**
- **2.3** Audit the other 23 jobs for the same `deliver` blackhole
- **2.4** Per `aria-alert-gate`, respect business-hours gating so this doesn't become 3 AM noise

### Phase 3 — Startup consolidation (zero-risk first)

- **3.1** Delete `AriaPm2Resurrect` (broken + only console flash of the Aria stack). Net: 3 resurrect paths → 2
- **3.2** Optionally drop the `PM2` HKCU Run key → single canonical resurrect via task
- **3.3** Add `<Hidden>true</Hidden>` to `Hermes_Gateway`; or convert to the `silent-gateway-hermia.vbs` handoff pattern already proven on the hermia task
- **3.4** Remove the ghost `aria-launcher.py` block from `hermes-desktop-launch.vbs`
- **3.5** Harden `wsl-honcho-autostart.vbs`: check exit code, log outcome; consider folding into the watchdog so there's one WSL-bring-up owner instead of two
- **3.6** **Ask Bill about Edge autostart** — likely his biggest visible annoyance, unrelated to Aria. Do not touch unilaterally.
- **3.7** Report on Wispr Flow's 10 processes / 1.4 GB; no action without approval

### Phase 4 — Model & cost hygiene

- **4.1** Fix `Tracking Validation Autopilot` model alias (kills ~48 failed calls/day)
- **4.2** Sweep all 24 jobs for dead `xai-oauth` pins now that credits are exhausted
- **4.3** Set `auxiliary.free_only: true` to honor free>paid

### Phase 5 — Documentation / Kaizen

- **5.1** Update AGENTS.md: remove `wsl-proxy`; document actual PM2 set (`aria-bot`, `aria-dashboard`, `aria-postgrest`, `aria-pg-health`, `pm2-logrotate`)
- **5.2** Patch `honcho-obsidian-sync` skill: strike stale `wsl-proxy.js`, add the profile-placement requirement
- **5.3** Patch `aria-infrastructure-recovery`: note WSL/Docker still hosts **Honcho** even though the Aria data plane went native
- **5.4** Patch `hermes-cron-ownership`: **skills** (not just scripts) must live in the default profile — add "skill not found, skipping" as a diagnostic signature
- **5.5** New skill `honcho-obsidian-restoration` once the real root cause is proven

---

## 6. Ordering rationale

Phase 2 (delivery) is arguably more urgent than Phase 1 (Honcho). A repaired Honcho with broken alerting will fail silently again. Recommend **2.1 landing alongside Phase 1**, not after.

Phase 3.1 and 3.4 are zero-risk and can land immediately.

## 7. Explicitly NOT doing without approval

- No `pm2 update` (version drift 6.0.14→7.0.3) during business hours
- No `taskkill` of any Hermes/PM2/Next.js process — HARD RULE
- No touching Edge/Wispr/ScanSnap/Brother/DYMO startup entries
- No deleting anything from the vault or `Downloads/` (archive-first policy)
