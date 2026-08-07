# Capable Overwatch (Heal-First) Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
> **Mode:** Plan only until Bill says execute.
> **Refs:** memory audit `20260807_074122_435f69` · recovery `@session:default/20260806_080232_531ba4` · vault boards `@session:default/20260806_124122_8eaedf`

**Goal:** Turn Aria/Hermes monitoring from “detect → vault warning → hope Bill looks” into **detect → heal → verify → ledger**. Bill only sees residual items that truly need a human.

**Architecture:** One script-only **Overwatch bus** owns the loop. Probes write structured findings. Healers run known safe recoveries with verify-after-fix. The vault becomes an **action ledger** (healed vs open), not an alert inbox. LLM oversight stays, but only for residuals after N failed heals — silent when empty.

**Tech Stack:** Python no_agent crons under `%LOCALAPPDATA%/hermes/scripts/`, WSL Docker Honcho, PostgREST `:5434`, Aria CLI (`trigger-build-risk.ts`, `run-ap-pipeline.ts`), Obsidian vault notes, Hermes default-profile cron only.

**North star (Bill):** capable overwatch, not alerts · auto-fix when safe · escalate only money/vendor/OAuth/3× heal failure · silent background · no popups · vault = triage not truth until gold-tested.

---

## Why the current stack is “awesome but not finished”

| What works today | Why it still fails Bill’s bar |
|---|---|
| `honcho-wsl-watchdog` heals WSL/DNS/liveness | Does not restart deriver after re-adding `FLUSH`; does not heal **capture stall** |
| `honcho_memory_freshness` in health board | Detect-only — 4-day warning, zero heal |
| `honcho-pg-backup.py` size-gates dumps | Done (2026-08-07) — keep |
| Vault ops boards (Active-POs / Receivings / AP-Match) | Good triage; not self-heal |
| `precision-guardrails.py` | **DISABLED**; wrong `SCRIPTS` path; mostly escalate/defer; build-risk “fix” refuses to trigger |
| `aria-oversight` LLM | Often re-describes the same stale build-risk; no durable heal state |
| Health board “ISSUE(S) NEED ATTENTION” | Trains Bill to ignore — permanent red for weekday-only/cron-owned items |

**Live example right now:** `BUILD-RISK STALE` (last snapshot `2026-08-05`) while healer exists:
`node --env-file=.env.local --import tsx src/cli/trigger-build-risk.ts`
— but nothing runs it.

---

## Target loop

```
┌─────────────┐    structured     ┌──────────────┐
│  Probes     │ ───────────────► │  state.json  │
│ (watchdogs) │    findings      │  (bus)       │
└─────────────┘                  └──────┬───────┘
                                        │
                                        ▼
                               ┌─────────────────┐
                               │  Overwatch      │
                               │  classify+heal  │
                               └────────┬────────┘
                        heal OK │       │ still broken
                                ▼       ▼
                         ledger:HEALED   retry≤N → escalate class
                                │              │
                                ▼              ▼
                         vault quiet     vault OPEN (human-only)
                         + heal log      oversight LLM only if needed
```

**Exit codes for overwatch script:**
- `0` — healthy OR all issues auto-healed this tick (silent)
- `1` — open human-actionable residual remains
- Never spam Bill; vault `Last run` still proves the job is alive

---

## Failure catalog → healer (only implement these)

| Finding key | Detect | Auto-heal | Verify | Human only if |
|---|---|---|---|---|
| `honcho.liveness` | `/health` fail | existing ladder: anchor → compose up → down/up | health 200 | 3 consecutive full-ladder fails |
| `honcho.flush_missing` | `.env` lacks `DERIVER_FLUSH_ENABLED=true` | append line + `docker compose up -d deriver` | container setting True | still false after restart |
| `honcho.docs_stall` | messages fresh, documents max(created_at) ≥36h older while pending>0 or messages grew | restart deriver; re-assert flush | documents advances or pending drains | still stalled next 2 ticks |
| `honcho.msgs_stall` | no new messages ≥4d AND Hermes desktop sessions existed in window | cannot force mid-session plugin reload; write heal note “new Desktop session required after honcho.json change”; optional: bounce gateway **only if** no active user session | messages climb after new session | Bill must open a new chat (rare) |
| `honcho.backup_hollow` | dump &lt;1MiB | already fail-closed in `honcho-pg-backup.py` | size≥1MiB | health down at 03:00 two nights in a row |
| `purchasing.build_risk_stale` | no snapshot ≥30h on **weekday** after 09:00 Denver | run `trigger-build-risk.ts` | snapshot `generated_at` today | CLI fails 2× |
| `purchasing.qty_calib_stale` | same gate | if CLI exists, run it; else mark `defer_to_aria_bot` once | row fresh | no CLI + bot cron dead |
| `purchasing.calendar_stale` | SQLite max(updated_at) &gt;10h | restart/signal aria-bot po-sync **or** run known calendar sync CLI if present | sync time moves | 2× miss |
| `ap.stuck` | existing AP watchdog | `run-ap-pipeline.ts` (idempotent) | stuck count↓ | still stuck after 2 runs |
| `gateway.down` | gateway-health | existing gateway keepalive path only if safe | health OK | needs Bill (port zombie) |
| `aria_bot.down` | aria-bot-alive | `pm2 restart aria-bot` (if pm2 online) | pid up | pm2 missing |

**Never auto:** payments, Bill.com forward decisions, PO approve, price override, OAuth browser login, vendor relationship language.

---

## File map (create / modify)

| Path | Action |
|---|---|
| `%LOCALAPPDATA%/hermes/scripts/overwatch_lib.py` | **Create** — shared state bus, Denver time helpers, weekday gate, run_cmd, ledger types |
| `%LOCALAPPDATA%/hermes/scripts/aria-overwatch.py` | **Create** — main heal-first runner (no_agent cron) |
| `%LOCALAPPDATA%/hermes/scripts/honcho-wsl-watchdog.py` | **Modify** — after flush self-heal, restart deriver; add optional capture-stall heal hooks callable from overwatch |
| `%LOCALAPPDATA%/hermes/scripts/purchasing-watchdog.py` | **Modify** — weekday/after-09:00 gate for build-risk; write structured finding to bus (don’t only print) |
| `%LOCALAPPDATA%/hermes/scripts/aria-health-to-vault.py` | **Modify** — sections: Auto-healed (24h) / Open human / Healthy; stop painting healed items red |
| `%LOCALAPPDATA%/hermes/scripts/precision-guardrails.py` | **Retire** — keep file as thin wrapper calling `aria-overwatch.py` OR disable permanently once overwatch proves out |
| `%LOCALAPPDATA%/hermes/scripts/.overwatch-state.json` | **Runtime** — bus + consecutive failure counts + last heal results |
| `%LOCALAPPDATA%/hermes/scripts/tests/test_overwatch_lib.py` | **Create** — pure unit tests (weekday gate, classify, failure counter) |
| Vault `Aria/ARIA-HEALTH-DASHBOARD.md` | **Shape change** via health script |
| Vault `Aria/Overwatch-Ledger.md` | **Create** via overwatch (always-current; problems first) |
| `cron/jobs.json` (default profile only) | Enable `aria-overwatch` every 15m; keep probes; retune oversight |
| Skill `honcho-obsidian-sync` | Patch: document overwatch ownership |
| Skill `watchdog-calibration` | Patch: heal-first rule + build-risk trigger path |
| `/root/honcho/.env` durability | Windows-side desired-config assert file (see Task 4) |

Cron ownership: **default gateway only** (`hermes-cron-ownership`). No second ticker on hermia profile.

---

### Task 1: Overwatch state bus library

**Objective:** Shared structured findings + consecutive-failure counters so healers are idempotent and silent when healthy.

**Files:**
- Create: `C:/Users/BuildASoil/AppData/Local/hermes/scripts/overwatch_lib.py`
- Create: `C:/Users/BuildASoil/AppData/Local/hermes/scripts/tests/test_overwatch_lib.py`

**Step 1: Write failing tests**

```python
# tests/test_overwatch_lib.py
from datetime import datetime
from zoneinfo import ZoneInfo
from overwatch_lib import is_build_risk_expected, bump_failure, reset_failure, classify

DENVER = ZoneInfo("America/Denver")

def test_build_risk_not_expected_weekend():
    sat = datetime(2026, 8, 1, 10, 0, tzinfo=DENVER)  # Saturday
    assert is_build_risk_expected(sat) is False

def test_build_risk_expected_weekday_after_9():
    fri = datetime(2026, 8, 7, 10, 0, tzinfo=DENVER)
    assert is_build_risk_expected(fri) is True

def test_build_risk_grace_before_9():
    fri = datetime(2026, 8, 7, 8, 30, tzinfo=DENVER)
    assert is_build_risk_expected(fri) is False

def test_failure_counter_escalates_at_3():
    st = {}
    assert bump_failure(st, "purchasing.build_risk_stale") == 1
    assert bump_failure(st, "purchasing.build_risk_stale") == 2
    assert bump_failure(st, "purchasing.build_risk_stale") == 3
    assert classify(st, "purchasing.build_risk_stale") == "escalate"
    reset_failure(st, "purchasing.build_risk_stale")
    assert classify(st, "purchasing.build_risk_stale") == "heal"
```

**Step 2: Run tests — expect FAIL (module missing)**

```bash
cd "$LOCALAPPDATA/hermes/scripts" && python -m pytest tests/test_overwatch_lib.py -v
```

**Step 3: Implement `overwatch_lib.py` (minimal)**

- `STATE_PATH = scripts/.overwatch-state.json`
- `load_state()` / `save_state()` atomic write
- `is_build_risk_expected(now)` — Mon–Fri and local hour ≥ 9 America/Denver
- `Finding(key, severity, detail, evidence)`
- `bump_failure` / `reset_failure` / `classify` → `heal|escalate|silent`
- `run_cmd(argv, cwd=None, timeout=180)` with `CREATE_NO_WINDOW`
- `append_heal_log(state, key, ok, detail)` keep last 50

**Step 4: Tests pass**

**Step 5: Do not commit Hermes scripts to Aria git unless Bill wants a mirror under `aria/scripts/ops/` — default is Hermes-local only.**

---

### Task 2: `aria-overwatch.py` heal-first runner

**Objective:** Single no_agent entrypoint that reads probes (or re-runs cheap checks), heals, verifies, writes ledger, exits 0 when nothing human remains.

**Files:**
- Create: `C:/Users/BuildASoil/AppData/Local/hermes/scripts/aria-overwatch.py`
- Create: `C:/Users/BuildASoil/Documents/Obsidian Vault/Aria/Overwatch-Ledger.md` (written each run)

**Core structure:**

```python
HEALERS = {
  "honcho.liveness": heal_honcho_liveness,          # subprocess honcho-wsl-watchdog.py
  "honcho.flush_missing": heal_honcho_flush,        # assert env + restart deriver
  "honcho.docs_stall": heal_honcho_deriver,         # restart deriver
  "purchasing.build_risk_stale": heal_build_risk,   # trigger-build-risk.ts
  "ap.stuck": heal_ap_stuck,                        # run-ap-pipeline.ts
  "aria_bot.down": heal_aria_bot,                   # pm2 restart aria-bot
}
```

**`heal_build_risk` exact command:**

```bash
cd "C:/Users/BuildASoil/Documents/Projects/aria" && \
node --env-file=.env.local --import tsx src/cli/trigger-build-risk.ts
```

Verify:

```text
GET http://localhost:5434/build_risk_snapshots?select=generated_at&order=generated_at.desc&limit=1
→ generated_at date == today Denver
```

**Ledger note shape (overwrite each run):**

```markdown
# Overwatch Ledger
**Last run:** ...
## Open (human)
- none | or bullets with why auto-heal failed N times
## Healed last 24h
- 07:42 build_risk_stale → triggered snapshot OK (generated_at=...)
## Quiet
- honcho capture, AP, gateway, ...
```

**Stdout policy:** print nothing on full success; on open residuals print one line summary (for cron log). Exit 0 if open list empty.

**Manual verify:**

```bash
python "$LOCALAPPDATA/hermes/scripts/aria-overwatch.py"; echo exit:$?
# With current stale build-risk, expect heal attempt + exit 0 after success
curl -s "http://localhost:5434/build_risk_snapshots?select=generated_at&order=generated_at.desc&limit=1"
```

---

### Task 3: Wire probes to the bus (stop print-only)

**Objective:** Watchdogs remain independent detectors but always upsert findings into `.overwatch-state.json`.

**Files:**
- Modify: `purchasing-watchdog.py`
- Modify: `ap-pipeline-watchdog.py` (if present)
- Modify: `aria-bot-alive.py`, `gateway-health-check.py` lightly OR let overwatch re-probe (prefer re-probe inside overwatch for fewer moving parts — **YAGNI choice below**)

**YAGNI decision:** v1 overwatch **re-runs** the cheap checks itself (build-risk query, honcho health+freshness, pm2 jlist, AP stuck query). Leave existing watchdogs as-is for defense in depth. Only change `purchasing-watchdog.py` to add **weekday+hour gate** so health board stops false weekend/morning red.

**purchasing-watchdog gate:**

```python
from overwatch_lib import is_build_risk_expected
from datetime import datetime
from zoneinfo import ZoneInfo
now_local = datetime.now(ZoneInfo("America/Denver"))
if len(build_risk) == 0 and is_build_risk_expected(now_local):
    issues.append("BUILD-RISK STALE: ...")
# else: silent — not expected yet
```

**Verify:**

```bash
# Friday 10am simulation already unit-tested
python "$LOCALAPPDATA/hermes/scripts/purchasing-watchdog.py"; echo $?
```

---

### Task 4: Honcho capture closed-loop (not just liveness)

**Objective:** When memory stops deriving or flush drifts, heal without Bill.

**Files:**
- Modify: `honcho-wsl-watchdog.py` `assert_flush_enabled()` path
- Create: `C:/Users/BuildASoil/AppData/Local/hermes/config/honcho-desired.env` (Windows-side desired flags)
- Optional WSL: ensure `/root/honcho/.env` contains required lines every tick

**Desired file content:**

```
DERIVER_FLUSH_ENABLED=true
```

**Heal steps when flush missing:**
1. Append to `/root/honcho/.env` if absent (existing)
2. **NEW:** `docker compose up -d deriver` (or `restart deriver`)
3. Verify:  
   `docker exec honcho-deriver-1 python -c "from src.config import settings; print(settings.DERIVER.FLUSH_ENABLED)"` → `True`

**Heal steps when `docs_stall`:**
1. Ensure flush true
2. Restart deriver
3. Sleep 20s
4. Re-query `max(created_at) from documents` and `pending` count
5. Success if pending↓ or documents timestamp moved

**Induce test (do once during implementation):**

```bash
# strip flag → watchdog must restore + deriver True
wsl -d Ubuntu -u root -- bash -lc "sed -i '/DERIVER_FLUSH_ENABLED/d' /root/honcho/.env"
python "$LOCALAPPDATA/hermes/scripts/honcho-wsl-watchdog.py"
# expect CONFIG DRIFT healed + deriver restarted; second run clean UP
```

---

### Task 5: Vault health board = ledger consumer (not alarm panel)

**Objective:** Bill glances and sees “system handled X” vs “only Y needs you.”

**Files:**
- Modify: `aria-health-to-vault.py`

**Section order:**
1. Last run (staleness = job death signal — keep)
2. **Open (human)** — only keys with classify=escalate
3. **Healed last 24h** — from overwatch state (collapsed)
4. **Healthy** table (compact)

Remove permanent red for issues overwatch already cleared this tick.

**Copy change:** replace “alert surface” blurb with:

> Overwatch heals known faults automatically. This note is the residual ledger. If Last run is not today, overwatch itself stopped.

**Verify:** run health script after a successful overwatch heal — build-risk must not appear under Open.

---

### Task 6: Cron wiring (default profile only)

**Objective:** Schedule heal loop; silence noisy LLM when nothing human remains.

**Jobs:**

| Job | Schedule | Mode | Notes |
|---|---|---|---|
| `aria-overwatch` | `*/15 * * * *` | `no_agent` + `script=aria-overwatch.py` | **New primary** |
| `honcho-wsl-watchdog` | `*/10 * * * *` | keep | liveness/anchor still independent |
| `aria-health-to-vault` | `0 7,13,19 * * *` + optional after overwatch | keep | ledger render |
| `honcho-pg-backup` | `0 3 * * *` | keep script-only | already size-gated |
| `precision-guardrails` | — | **disable** | superseded |
| `aria-oversight` | `8,38 * * * *` | keep LLM but | prompt: read Overwatch-Ledger Open section only; if empty output exactly `[SILENT]`; never restate healed items; no web toolset |

**Oversight prompt shrink (critical):**

```
Read C:/Users/BuildASoil/Documents/Obsidian Vault/Aria/Overwatch-Ledger.md
If ## Open (human) is empty or "none" → respond exactly: [SILENT]
Else → one line per open item, prefer auto-delegate via known CLI if still untried;
BILL: only for OAuth / money / vendor / 3× failed heal.
Do not mention healed or healthy systems.
```

**Ownership check:**

```bash
python -c "..."  # hermes-cron-ownership audit — specialist profiles 0 jobs
```

---

### Task 7: Gold-path verification matrix (prove heal, don’t claim)

Run in order after implementation:

| # | Induce | Expect |
|---|---|---|
| 1 | Kill WSL anchors | watchdog restores 0→2; health 200 |
| 2 | Delete `DERIVER_FLUSH_ENABLED` line | restored + deriver True within 1 overwatch tick |
| 3 | Stale build-risk (already true) | overwatch runs trigger-build-risk; snapshot today; exit 0 |
| 4 | Hollow backup attempt while API stopped | backup exits nonzero; no 20-byte file kept |
| 5 | API write probe message | messages+1; documents advance or pending→0 |
| 6 | Oversight with empty Open | `[SILENT]` only |
| 7 | Quiet 24h | vault Last run still fresh; no Bill pings |

Record results in vault `Decisions/2026-08-07-Capable-Overwatch.md`.

---

### Task 8: Docs + skill patches

**Objective:** Next session starts at today’s standard.

- Patch `honcho-obsidian-sync` — overwatch owns heal; vault is residual ledger
- Patch `watchdog-calibration` — build-risk heal command; weekend gate mandatory
- Update vault `Aria/Memory-Architecture.md` one paragraph pointing at Overwatch-Ledger
- Optional: Aria mirror doc `docs/operational-guides/capable-overwatch.md` if Bill wants repo-visible ops doc

---

## Implementation order (ship value early)

1. Task 1 library + tests  
2. Task 2 overwatch with **only** `heal_build_risk` + `heal_honcho_liveness` (wrap existing watchdog)  
3. Task 6 cron enable overwatch  
4. Task 3 weekday gate on purchasing-watchdog  
5. Task 4 flush+deriver closed loop  
6. Task 5 vault ledger UX  
7. Task 7 induce matrix  
8. Task 8 docs  
9. Disable precision-guardrails permanently after 48h clean  

**Do not** build Telegram/Slack push in this plan. Bill chose vault + heal over alerts. Push is a later optional channel for escalate-class only.

---

## Risks & tradeoffs

| Risk | Mitigation |
|---|---|
| Healer runs expensive build-risk too often | Max 1 successful trigger / 6h; failure backoff 30m; weekday gate |
| `pm2 restart` during Bill active work | Only if bot dead; CREATE_NO_WINDOW; no GUI |
| Double-fire with Aria OpsManager build-risk cron | Healer is backup when snapshot stale — idempotent snapshot write OK |
| Overwatch bugs hide real issues | Probes still independent; ledger keeps heal history; exit 1 on escalate |
| LLM oversight fights healers | Prompt locked to Open section; `[SILENT]` when empty |
| WSL commands hang | timeouts on every wsl/docker call; never block &gt;3m |

---

## Out of scope (explicit YAGNI)

- New chat platforms / Telegram enablement  
- Replacing Honcho or moving off WSL  
- Dataview plugin / vendor cheat sheets (separate product work)  
- Auto OAuth / auto Bill.com  
- Multi-agent swarm for every blip  

---

## Success criteria

1. Build-risk can go stale and return to green **without Bill**.  
2. Flush flag deletion self-heals including **deriver restart**, proven by induce.  
3. Health/Overwatch notes show **healed** vs **open**, not permanent red.  
4. Oversight produces `[SILENT]` on a healthy morning.  
5. No hollow backups ever retained.  
6. Memory capture probe still green after 48h normal use.  

---

## Open questions for Bill (only if blocking)

1. **Build-risk healer:** OK to run `trigger-build-risk.ts` from overwatch on weekdays when stale? (Recommended: **yes** — this is the whole point.)  
2. **Gateway bounce** on rare `msgs_stall` after config change: allow automatic Desktop/gateway restart, or always human? (Recommended: **human** — avoid killing active chat.)  
3. Execute this plan now with subagent-driven-development, or phase 1 only (overwatch + build-risk heal) today?

---

## Handoff

Plan saved. Ready to execute with subagent-driven-development (fresh subagent per task, spec review then quality review) — or run Tasks 1–3 myself in this session for fastest path to “stale build-risk disappears by itself.”
