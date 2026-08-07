# Honcho / Docker / WSL — Corrected Diagnosis + Native Migration Assessment

**Date:** 2026-08-06
**Author:** Hermia
**Status:** Vault RESTORED (proven). Honcho stability NOT fixed. Native migration assessed, not started.

---

## 1. What actually got fixed today (verified, not claimed)

| Item | Proof |
|---|---|
| WSL cold-started | `wsl -d Ubuntu echo alive` → `alive`; state `Stopped` → `Running` |
| Docker DNS repaired | `compose down --remove-orphans` (removed `honcho_default` network) + `up -d` → `honcho-api-1 Healthy` |
| Honcho reachable from Windows | `curl localhost:8000/health` → `{"status":"ok"}` HTTP **200** (no `wsl-proxy` needed — WSL2 localhost relay works) |
| Misplaced skill fixed | Copied `profiles/hermia/skills/devops/honcho-obsidian-sync` → `skills/devops/honcho-obsidian-sync`. Cron now shows `skill: devops/honcho-obsidian-sync` (was `skill not found` 21× since 07-14) |
| Dead model pins cleared | `honcho-obsidian-sync`, `Tracking Validation Autopilot`, `warm-purchasing-cache`: `xai-oauth` (credit-blocked) → `openrouter`/`deepseek-v4-flash`. Remaining `xai-oauth` pins: **NONE**. Backup: `jobs.json.bak-20260806` |
| **Vault genuinely restored** | 3 new files, first real content since **2026-07-14**: `Vendors/Pricing-Negotiations-2026-08-06.md` (1844 B), `Decisions/AP-Reconciliation-Status-2026-08-06.md` (3052 B), `Aria/Procure-to-Pay-Architecture-2026-08-06.md` (2257 B). 35 conclusions across 2 queries. Real content (e.g. $300/yd → $0.36/lb negotiation, 3 drafted email options, `reconcileInvoiceToPO` history) |

---

## 2. My diagnosis was wrong TWICE — corrected

| Claim | Why wrong | Actual |
|---|---|---|
| "dockerd is crash-looping" | Read short uptimes (7-31s) as crashes | Logs show `"graceful shutdown"` + `"Daemon shutdown complete"` + `Deactivated successfully`. **Clean stops, not crashes.** |
| "Something is killing the WSL VM" | Assumed VM teardown | **VM uptime is continuous:** `/proc/uptime` 4097→4136→4174→4214→4240s across 5 probes. The VM never restarted. |

**Correct diagnosis:** WSL2 drops to **idle** (`wsl --list --running` flaps 0/1 while `/proc/uptime` climbs). systemd stops `docker.service` on idle; `docker.socket` socket-activates it on the next access. Each of my probes restarted the daemon, which is why uptime always looked tiny.

`.wslconfig` sets `vmIdleTimeout=-1`, which is **being ignored** — the skill already notes this.

### Why 23 days of watchdog never healed it
`honcho-wsl-watchdog.py` runs **every 10 min** and calls `docker compose up -d`. But:
1. Teardown recurs on a **~25-60s** cycle — a 10-min watchdog cannot hold it open.
2. `compose up -d` does **not** rebuild the Docker network, so it can't clear the `failed to resolve host 'database'` DNS fault. Only `compose down` + `up` does (what worked today).
3. `no_agent: true` + empty stdout = **silent by design**, so every failure was invisible.

The watchdog is structurally incapable of fixing this class of fault. That is the bug, not the schedule.

---

## 3. Bill's question: should Honcho run native on Windows?

Instinct is sound — the July migration took the Aria data plane native successfully. But Honcho is **4 services**, not 1:

| Service | Image | Native on Windows? | Assessment |
|---|---|---|---|
| `database` | `pgvector/pgvector:pg15` | ⚠️ Partial | PG16 installed + `postgresql-x64-16` Running. **But `share/extension/` has ZERO vector files — pgvector NOT installed.** Honcho hard-fails at startup without it (`embedding_validator.py`). Installable (needs a PG16-matched pgvector build). |
| `redis` | `redis:8.2` | ❌ **Blocker** | No official Redis Windows build. Options: Memurai (paid), WSL-native `redis-server` (still WSL), unofficial ports. |
| `api` | custom Dockerfile | ⚠️ Maybe | FastAPI/uvicorn + `/app/.venv`, uv-managed. From-source install possible; deps are Docker-pinned. |
| `deriver` | custom Dockerfile | ⚠️ Maybe | Same codebase, background worker. |

**Honest read:** full native migration is a genuine project, and lands you on unofficial/paid Redis. Aria's migration worked because Postgres has a first-class Windows build. Honcho doesn't have that shape. **Not recommended as today's fix.**

### Recommended: Hybrid (option 3)
Point Honcho's `DB_CONNECTION_URI` at the **native PG16** already running (add pgvector), keep only `redis`+`api`+`deriver` in Docker. Removes the heaviest container, shrinks crash surface, keeps one DB engine.

**Blocker to resolve first:** pgvector on PG16. Also `psql` non-interactive auth failed — need `PGPASSWORD`/`.pgpass` before scripting anything against native PG.

---

## 4. NEW FINDING — stale retired-architecture containers still resurrecting

`docker ps -a` shows, alongside Honcho:
```
aria-postgrest    Up 1 second
aria-db           Up 1 second (health: starting)
aria-minio        Exited (0) 13 days ago
aria-minio-init   Exited (1) 13 days ago
```
`aria-db` + `aria-postgrest` are from the **retired** WSL/Docker data plane. Native PG16 + PostgREST :5434 (HTTP 200) is the live path. These are ghosts with `restart: unless-stopped`, competing for the same WSL resources.

`scripts/watchdog.ps1:204` still actively resurrects them:
```powershell
docker start aria-db ... docker start aria-postgrest aria-minio
```
and lines 207/224 reference `aria-wsl-proxy` / `aria-local-stack` — **PM2 apps that no longer exist**. `scripts/aria-startup.bat:6` also runs `wsl --shutdown` (manual-only; `AriaWatchdog` Next Run = N/A, so not the current teardown cause).

**This is real cleanup debt from an incomplete migration.**

---

## 5. Bill's catch: memory provider

Bill: *"A but memory was not set..."* — correct, and it moved during the session:

| Profile | 08:45 | 09:05 |
|---|---|---|
| default | `builtin` | **`honcho`** + `flush_min_turns: 6` |
| hermia | `honcho` | `honcho` |

Both profiles now target Honcho, and **neither config has a populated `honcho:` block** (`honcho: {}` in hermia; **no `honcho:` key at all** in default). Needs verification that the provider resolves a real endpoint rather than silently no-op'ing.

**Also critical:** the sync log reports *"No new conclusions since July 10."* So **ingestion stopped too** — not just export. Restoring the export path does not restore memory *capture*. Must confirm writes land before declaring this wired.

---

## 6. Remaining work

**P0 — make Honcho stay up**
- Hold WSL open properly (vmIdleTimeout is ignored): a real anchor process, scheduled keepalive < 60s cadence, or `wsl.exe` service-style pin
- Rewrite `honcho-wsl-watchdog.py`: escalate to `compose down` + `up` when DNS resolution fails (current `up -d` can't fix it); print output so failures aren't silent

**P0 — verify memory actually writes**
- Populate/validate `honcho:` config on both profiles; confirm new conclusions appear after July 10

**P1 — alert delivery blackhole (unchanged, still broken)**
- `honcho-health-watchdog` `deliver=all` → `no delivery target resolved`; `No env user allowlists configured`. This is why a 23-day outage was invisible. Affects all 24 jobs.

**P1 — migration cleanup**
- Remove `aria-db`/`aria-postgrest`/`aria-minio*` ghosts; fix `watchdog.ps1` (drop `aria-wsl-proxy`, `aria-local-stack`, aria-db resurrection); update AGENTS.md (still lists `wsl-proxy`)

**P2 — startup consolidation (from earlier plan, unstarted)**
- Delete broken `AriaPm2Resurrect` (flashes console, fails every boot); silence `Hermes_Gateway` task; remove ghost `aria-launcher.py`; ask Bill re Edge autostart (12 procs) + Wispr Flow (10 procs, 1.4 GB)

**P2 — skill patches**
- `hermes-cron-ownership`: skills (not just scripts) must live in default profile; add `skill not found, skipping` signature
- `honcho-obsidian-sync`: remove stale `wsl-proxy.js`; document `compose down` requirement for DNS faults
- `aria-infrastructure-recovery`: WSL/Docker still hosts **Honcho** post-migration; correct idle-teardown vs crash-loop
