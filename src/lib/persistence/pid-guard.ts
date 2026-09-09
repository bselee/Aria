/**
 * @file    src/lib/persistence/pid-guard.ts
 * @purpose Self-healing zombie-process guard. Claims a PID sentinel at boot and
 *          reaps a genuinely orphaned prior-generation aria-bot so duplicate
 *          node-cron schedulers cannot run side by side.
 *
 * BACKGROUND (2026-07-27 duplicate-cron incident): PM2 on Windows cannot
 * guarantee that SIGTERM results in process death. When the old process hangs
 * on exit, PM2 spawns the replacement anyway and the old one becomes an
 * invisible orphan still firing its own crons. 16 orphans accumulated over 5
 * days; 11 duplicate Monday Briefing emails landed in one minute.
 *
 * REGRESSION (2026-07-27, same day): the first version of this guard SIGKILLed
 * the sentinel PID immediately whenever it was alive. That manufactured a
 * self-sustaining restart loop (118+ restarts at ~1 per 14s): PM2 spawns gen
 * N+1 while gen N is still alive, gen N+1 instantly kills gen N, PM2 reads that
 * as an unexpected child death and restarts again, forever. Live probes 14s
 * apart showed sentinel=28200 while pm2 reported pid 24048 — the guard was
 * killing the very process PM2 was supervising as healthy.
 *
 * THREE INDEPENDENT DEFENSES (any one breaks the loop):
 *   A) GRACE WINDOW  — wait REAP_GRACE_MS for the predecessor to exit on its
 *      own. A normal restart exits well inside the window and never reaches the
 *      kill path; a real orphan (alive for days) always outlasts it.
 *   B) CLEAN-EXIT MARKER — releaseSentinel() logs a clean exit from the exit
 *      cleanup hooks. It must NOT delete the sentinel: doing so raced with the
 *      incoming generation and disarmed orphan detection (see that function).
 *   C) CIRCUIT BREAKER — more than MAX_REAPS_PER_WINDOW reaps inside
 *      REAP_WINDOW_MS disables reaping and logs loudly. Fails safe.
 *   D) AGE GATE — a candidate is only reaped when it is demonstrably OLD
 *      (>= MIN_ORPHAN_AGE_MS). A mid-restart sibling is seconds old, so it is
 *      never killed; a genuine orphan (alive for minutes/days) always passes.
 *      Unknown age is treated as "do not kill" (fail-safe).
 *
 * @author  Hermia
 * @created 2026-07-27
 * @updated 2026-07-27 — grace window + sentinel release + circuit breaker
 * @deps    node:fs, node:path, node:child_process
 * @env     ARIA_BOT_PID_SENTINEL  — override sentinel file path
 *          ARIA_BOT_PM2_NAME      — PM2 process name to cross-check
 *          ARIA_PID_GUARD_DISABLE — "true" skips reaping entirely
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";

/**
 * Absolute path to the PID sentinel.
 *
 * Built with path.join rather than a hardcoded Windows literal: an earlier
 * revision hardcoded a backslash path that lost its escaping, silently
 * degrading to a RELATIVE path and writing the sentinel into the project root
 * as one long mangled filename. The guard then never found a prior PID, so
 * orphan detection was effectively disabled. process.cwd() is the PM2 pm_cwd
 * (the repo root), so logs/aria-bot.pid resolves correctly on every platform.
 */
const SENTINEL_PATH = process.env.ARIA_BOT_PID_SENTINEL
  ?? join(process.cwd(), "logs", "aria-bot.pid");

/** PM2 process name used to detect a live supervised sibling. */
const PM2_PROC_NAME = process.env.ARIA_BOT_PM2_NAME ?? "aria-bot";

/** Grace period for a predecessor to exit on its own before force killing. */
const REAP_GRACE_MS = 15_000;

/** Poll cadence while waiting out the grace window. */
const REAP_POLL_MS = 500;

/** Circuit-breaker thresholds. */
const MAX_REAPS_PER_WINDOW = 3;
const REAP_WINDOW_MS = 5 * 60 * 1000;

/** A genuine orphan is OLD; a mid-restart sibling is seconds old. */
const MIN_ORPHAN_AGE_MS = 60_000;

/** Sidecar file tracking recent reap timestamps for the circuit breaker. */
const REAP_LEDGER_PATH = join(dirname(SENTINEL_PATH), "aria-bot.reaps.json");

/**
 * True if a process with this PID is currently alive. Uses a signal-0 probe,
 * which does not actually deliver a signal.
 *
 * @param pid - OS process id to probe.
 * @returns `true` when the process exists (EPERM counts as alive).
 */
function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * Blocks the calling thread. Deliberately synchronous: this guard runs before
 * any async boot work so no cron scheduler can start while a duplicate lives.
 *
 * @param ms - Milliseconds to block.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * PIDs PM2 currently reports for the configured process name. A PID PM2
 * actively supervises is a live sibling, not an orphan, and is never killed.
 *
 * @returns Supervised PIDs, or `null` when PM2 could not be queried.
 */
function getPm2SupervisedPids(): number[] | null {
  try {
    const raw = execSync("pm2 jlist", {
      encoding: "utf-8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const start = raw.indexOf("[");
    if (start < 0) return null;
    const parsed: unknown = JSON.parse(raw.slice(start));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((p): p is { name?: string; pid?: number } => typeof p === "object" && p !== null)
      .filter((p) => p.name === PM2_PROC_NAME)
      .map((p) => Number(p.pid))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return null;
  }
}

/**
 * Enumerates every live aria-bot process on Windows by matching the PM2
 * fork-wrapper command line: `node --import tsx ... ProcessContainerFork.js`.
 * `--import tsx` is unique to aria-bot in this repo's ecosystem config (every
 * other app runs plain `next` or a `.js` script), so this is a precise
 * fingerprint. Returns [] on any failure — fail-safe.
 *
 * @returns Process IDs of all aria-bot processes, or [] when enumeration fails.
 */
function enumerateAriaBotPids(): number[] {
  if (process.platform !== "win32") return [];
  try {
    const cmd =
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ` +
      `$_.Name -eq 'node.exe' -and $_.CommandLine -like '*--import tsx*' ` +
      `-and $_.CommandLine -like '*ProcessContainerFork*' } | Select-Object -ExpandProperty ProcessId"`;
    const raw = execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Age of a single process in milliseconds, or null when it cannot be
 * determined (process already gone, or PowerShell unavailable).
 *
 * The age gate is the fail-safe that distinguishes a genuine orphan (old)
 * from a mid-restart sibling (seconds old). Null is treated as "do not kill":
 * on an uncertain signal the guard must never reap.
 *
 * @param pid - OS process id to age.
 * @returns age in ms, or null when unknown.
 */
function getPidAgeMs(pid: number): number | null {
  if (process.platform !== "win32" || !pid || pid <= 0) return null;
  try {
    const raw = execSync(
      `powershell -NoProfile -Command "$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $ts = (Get-Date) - $p.StartTime; [int]$ts.TotalSeconds }"`,
      {
        encoding: "utf-8",
        timeout: 10_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const secs = Number(raw.trim());
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    return null;
  } catch {
    return null;
  }
}

/**
 * Reaps every orphaned aria-bot process PM2 is no longer supervising.
 *
 * This is the BACKLOG case the single-PID sentinel cannot handle: a crash loop
 * can orphan several generations faster than the sentinel's circuit breaker
 * allows reaps, and once a newer boot overwrites the sentinel their PIDs are
 * lost forever. Enumeration finds and kills them all in one pass.
 *
 * Fails safe: if PM2 cannot be queried (supervised === null) nothing is killed,
 * because we cannot distinguish a live supervised process from an orphan.
 */
export function reapOrphanedAriaBots(): void {
  if (process.env.ARIA_PID_GUARD_DISABLE === "true") return;

  const supervised = getPm2SupervisedPids();
  if (supervised === null) {
    console.warn("[pid-guard] Could not query PM2 supervised PIDs — skipping orphan sweep (fail-safe).");
    return;
  }

  const candidates = enumerateAriaBotPids();
  for (const pid of candidates) {
    if (pid === process.pid) continue;
    if (supervised.includes(pid)) continue;
    const ageMs = getPidAgeMs(pid);
    if (ageMs === null || ageMs < MIN_ORPHAN_AGE_MS) {
      // Too young (or unknown age) to be a genuine orphan — a mid-restart
      // sibling, not a stale generation. Killing here is what manufactures
      // the reaper-induced restart loop (observed 2026-09-02).
      continue;
    }
    if (reapBreakerTripped()) {
      console.warn(`[pid-guard] Skipping orphan ${pid} — circuit breaker is open.`);
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      console.warn(`[pid-guard] Killed orphaned aria-bot PID ${pid} (not PM2-supervised).`);
    } catch (err: unknown) {
      const msg = (err as Error | undefined)?.message ?? String(err);
      console.warn(`[pid-guard] Failed to kill orphan PID ${pid}: ${msg}`);
    }
  }
}

/**
 * Records a reap attempt and reports whether the circuit breaker has tripped.
 *
 * @returns `true` when reaping must be SUPPRESSED (too many recent reaps).
 */
function reapBreakerTripped(): boolean {
  const now = Date.now();
  let history: number[] = [];
  try {
    if (existsSync(REAP_LEDGER_PATH)) {
      const parsed: unknown = JSON.parse(readFileSync(REAP_LEDGER_PATH, "utf-8"));
      if (Array.isArray(parsed)) {
        history = parsed.filter((n): n is number => typeof n === "number");
      }
    }
  } catch {
    history = [];
  }

  const recent = history.filter((ts) => now - ts < REAP_WINDOW_MS);
  if (recent.length >= MAX_REAPS_PER_WINDOW) {
    console.error(
      `[pid-guard] CIRCUIT BREAKER OPEN — ${recent.length} reaps in the last ` +
      `${Math.round(REAP_WINDOW_MS / 60000)}m. Refusing to kill anything this boot; ` +
      `this pattern indicates a reaper-induced restart loop.`,
    );
    return true;
  }

  recent.push(now);
  try {
    writeFileSync(REAP_LEDGER_PATH, JSON.stringify(recent), "utf-8");
  } catch {
    // Advisory only — must not block boot.
  }
  return false;
}

/**
 * Writes this process's PID into the sentinel file so a later boot can clean up
 * after us if we ever hang on exit.
 */
function claimSentinel(): void {
  try {
    writeFileSync(SENTINEL_PATH, String(process.pid), "utf-8");
    console.log(`[pid-guard] Claimed sentinel — this boot is PID ${process.pid}.`);
  } catch (err: unknown) {
    const msg = (err as Error | undefined)?.message ?? String(err);
    console.warn(`[pid-guard] Failed to write sentinel PID (non-fatal): ${msg}`);
  }
}

/**
 * Reaps a genuinely orphaned prior-generation process, then claims the sentinel
 * for this boot.
 *
 * A candidate PID is force-killed ONLY when all of these hold:
 *   - it is not our own PID;
 *   - it is still alive after REAP_GRACE_MS of waiting;
 *   - PM2 does not currently report it as a supervised process;
 *   - the reap-rate circuit breaker is closed.
 *
 * Best-effort: every failure path is logged and swallowed. This is a safety
 * net, not a load-bearing boot dependency.
 */
export function reapStaleInstanceAndClaimPid(): void {
  try {
    mkdirSync(dirname(SENTINEL_PATH), { recursive: true });
  } catch {
    // directory probably already exists
  }

  if (process.env.ARIA_PID_GUARD_DISABLE === "true") {
    console.warn("[pid-guard] Reaping disabled via ARIA_PID_GUARD_DISABLE — claiming sentinel only.");
    claimSentinel();
    return;
  }

  try {
    if (existsSync(SENTINEL_PATH)) {
      const stalePid = Number(readFileSync(SENTINEL_PATH, "utf-8").trim());

      if (Number.isFinite(stalePid) && stalePid > 0 && stalePid !== process.pid) {
        if (!isPidAlive(stalePid)) {
          console.log(`[pid-guard] Sentinel PID ${stalePid} is not alive — nothing to reap.`);
        } else {
          console.log(
            `[pid-guard] Sentinel PID ${stalePid} is alive. Waiting up to ${REAP_GRACE_MS}ms ` +
            `for it to exit on its own (a normal restart exits well inside this window).`,
          );

          const deadline = Date.now() + REAP_GRACE_MS;
          while (Date.now() < deadline && isPidAlive(stalePid)) {
            sleepSync(REAP_POLL_MS);
          }

          if (!isPidAlive(stalePid)) {
            console.log(
              `[pid-guard] PID ${stalePid} exited during the grace window — normal restart, no kill needed.`,
            );
          } else {
            const supervised = getPm2SupervisedPids();
            if (supervised === null) {
              // PM2 couldn't be queried (daemon busy, restart race, pm2 jlist
              // timeout). We cannot positively confirm this PID is orphaned, so
              // fail safe and DO NOT kill. Killing on "unknown" is exactly what
              // manufactures the reaper-induced restart loop: during a PM2
              // restart the outgoing PID is briefly untracked, and treating
              // "unknown" as "orphan" SIGKILLs a live supervised process, which
              // PM2 then restarts, forever. Observed live 2026-09-02 (restarts
              // 49→55 in ~15 min). The 5-min watchdog sweep + this boot's own
              // enumeration reaper will catch any real orphan once PM2 is
              // queryable again.
              console.warn(
                `[pid-guard] Could not query PM2 supervised PIDs — PID ${stalePid} ` +
                `outlasted the grace window but cannot be confirmed orphaned. Skipping reap (fail-safe).`,
              );
            } else if (supervised.includes(stalePid)) {
              console.warn(
                `[pid-guard] PID ${stalePid} outlasted the grace window BUT PM2 reports it as a ` +
                `supervised "${PM2_PROC_NAME}" process (pm2 pids: ${supervised.join(", ")}). ` +
                `Refusing to kill a live supervised instance.`,
              );
            } else if (reapBreakerTripped()) {
              console.warn(`[pid-guard] Skipping reap of PID ${stalePid} — circuit breaker is open.`);
            } else {
              const ageMs = getPidAgeMs(stalePid);
              if (ageMs === null || ageMs < MIN_ORPHAN_AGE_MS) {
                console.log(
                  `[pid-guard] PID ${stalePid} outlasted the grace window but is ` +
                  `${ageMs === null ? "of unknown age" : `only ${Math.round(ageMs / 1000)}s old`} — ` +
                  `too young to be a genuine orphan. Skipping (age gate).`,
                );
              } else {
                console.warn(
                  `[pid-guard] PID ${stalePid} is STILL alive after ${REAP_GRACE_MS}ms, is ` +
                  `${Math.round(ageMs / 1000)}s old, and is not PM2-supervised — genuine orphan. ` +
                  `Killing it to prevent duplicate cron execution.`,
                );
                try {
                  process.kill(stalePid, "SIGKILL");
                  console.warn(`[pid-guard] Sent SIGKILL to orphaned PID ${stalePid}.`);
                } catch (killErr: unknown) {
                  const msg = (killErr as Error | undefined)?.message ?? String(killErr);
                  console.warn(`[pid-guard] Failed to kill PID ${stalePid}: ${msg}`);
                }
              }
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    const msg = (err as Error | undefined)?.message ?? String(err);
    console.warn(`[pid-guard] Sentinel read failed (non-fatal): ${msg}`);
  }

  // Sweep any leftover orphan backlog the single-PID sentinel can't see.
  reapOrphanedAriaBots();

  claimSentinel();
}

/**
 * Marks a clean exit. Deliberately does NOT delete the sentinel file.
 *
 * An earlier revision unlinked the sentinel here. That introduced a TOCTOU race
 * with the incoming generation: PM2 on Windows starts the replacement before the
 * outgoing process finishes its exit hooks, so the sequence became
 * read(old pid) -> [new boot writes its own pid] -> unlink, which deleted the
 * NEW generation's sentinel and silently disarmed zombie detection entirely.
 * Observed live 2026-07-27: sentinel absent while PID 30628 was healthy.
 *
 * Leaving a stale PID behind costs nothing — the next boot sees a dead PID and
 * logs "not alive, nothing to reap". Defenses A (grace window) and C (circuit
 * breaker) are what actually prevent the reaper-induced restart loop, and both
 * are race-free. Keeping the file present preserves the orphan detection that
 * the original duplicate-cron incident required.
 */
export function releaseSentinel(): void {
  try {
    if (!existsSync(SENTINEL_PATH)) return;
    const raw = readFileSync(SENTINEL_PATH, "utf-8").trim();
    if (Number(raw) === process.pid) {
      console.log(`[pid-guard] Clean exit for PID ${process.pid} — sentinel left in place for next boot.`);
    }
  } catch (err: unknown) {
    const msg = (err as Error | undefined)?.message ?? String(err);
    console.warn(`[pid-guard] releaseSentinel check failed (non-fatal): ${msg}`);
  }
}
