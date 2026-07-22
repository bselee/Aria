/**
 * @file    scripts/local-stack-watchdog.js
 * @purpose Keep Aria local data plane up: wake WSL, ensure Docker containers,
 *          probe PostgREST, auto-recover from WSL crashes ("Catastrophic failure").
 *          NEVER restart PostgREST on HTTP 503 (schema cache is self-healing).
 * @author  Hermia
 * @created 2026-07-13
 * @updated 2026-07-22 — WSL crash recovery, removed proxy restart anti-pattern
 * @updated 2026-07-22 — removed phantom inside-WSL PostgREST probe (PostgREST is
 *                       native Windows now, not inside WSL), fixed pg_isready role,
 *                       added wake cooldown to prevent restart loop
 * @deps    child_process, http
 *
 * Usage:
 *   node scripts/local-stack-watchdog.js           # one-shot ensure
 *   node scripts/local-stack-watchdog.js --loop    # every 60s
 *   pm2 start ecosystem.config.json --only aria-local-stack
 */

const { execFileSync } = require("child_process");
const http = require("http");
const path = require("path");

const PROJECT = "C:/Users/BuildASoil/Documents/Projects/aria";
const LOOP = process.argv.includes("--loop");
const INTERVAL_MS = 60_000;
const WAKE_COOLDOWN_MS = 60_000; // don't restart containers more than once per minute

let lastWakeTime = 0;

function log(msg) {
  console.log(`[local-stack] ${msg}`);
}

let wslCrashCount = 0;
const MAX_WSL_CRASHES = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 30 * 60_000; // 30 minutes
const CIRCUIT_BREAKER_MAX_CRASHES = 5;
const wslCrashTimestamps = [];

/** Run a wsl.exe command with auto-recovery on "Catastrophic failure". */
function wslSafe(bashLc, timeout = 60000) {
  try {
    return execFileSync(
      "wsl.exe",
      ["-d", "Ubuntu", "-u", "root", "--", "bash", "-lc", bashLc],
      { encoding: "utf-8", timeout, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    const msg = err.stderr || err.message || "";
    if (/catastrophic/i.test(msg) || /E_UNEXPECTED/i.test(msg)) {
      // Circuit breaker: if WSL crashes >5 times in 30 min, stop recovering
      const now = Date.now();
      wslCrashTimestamps.push(now);
      while (wslCrashTimestamps.length > 0 && now - wslCrashTimestamps[0] > CIRCUIT_BREAKER_WINDOW_MS) {
        wslCrashTimestamps.shift();
      }
      if (wslCrashTimestamps.length > CIRCUIT_BREAKER_MAX_CRASHES) {
        log(`WSL CIRCUIT BREAKER OPEN — ${wslCrashTimestamps.length} crashes in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS/60000)}min. Stopping recovery.`);
        return null;
      }

      wslCrashCount++;
      log(`WSL crashed (count ${wslCrashCount}/${MAX_WSL_CRASHES}) — shutting down...`);
      try {
        execFileSync("wsl.exe", ["--shutdown"], { timeout: 15000, windowsHide: true });
      } catch { /* shutdown can fail if already dead */ }
      if (wslCrashCount >= MAX_WSL_CRASHES) {
        log("WSL crash limit reached — will retry next tick");
        wslCrashCount = 0;
      }
      return null;
    }
    throw err;
  }
}

function wsl(bashLc, timeout = 60000) {
  return wslSafe(bashLc, timeout);
}

/**
 * Check if WSL is alive (can execute simple commands).
 * Returns false if WSL is crashed or unresponsive — in that case
 * we should NOT try to run docker commands or wake.
 */
function wslAlive() {
  try {
    const out = wsl("echo alive", 8000);
    if (out == null) return false;
    return out.trim().includes("alive");
  } catch {
    return false;
  }
}

/**
 * Check if Docker containers are running inside WSL.
 * Returns true if aria-db is running (the critical container).
 * Returns null if WSL itself is unresponsive (can't determine).
 */
function containersRunning() {
  if (!wslAlive()) {
    log("WSL unresponsive — skipping container check");
    return null;
  }
  try {
    const out = wsl("docker ps --format '{{.Names}}' 2>/dev/null || echo ''", 15000);
    if (out == null) return null;
    return out.includes("aria-db");
  } catch {
    return null;
  }
}

/**
 * Wake WSL and start Docker containers if they're not running.
 * Uses pg_isready (no -U flag — tests if the server accepts connections,
 * regardless of role) to wait for Postgres readiness.
 * Does NOT probe PostgREST inside WSL — PostgREST runs natively on Windows.
 */
function wakeWslAndDocker() {
  try {
    const out = wsl(
      [
        "echo awake;",
        "service docker start >/dev/null 2>&1 || true;",
        "docker start aria-db >/dev/null 2>&1 || true;",
        "for i in 1 2 3 4 5 6 7 8 9 10; do",
        "  docker exec aria-db pg_isready >/dev/null 2>&1 && break;",
        "  sleep 2;",
        "done;",
        "docker start aria-minio >/dev/null 2>&1 || true;",
        "echo containers_ok",
      ].join(" "),
      90000
    );
    if (out == null) return "wsl crashed — will retry next tick";
    return out.trim();
  } catch (err) {
    return `wake error: ${err.message}`;
  }
}

/** Probe PostgREST HTTP root from Windows. */
function probePostgrest() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: 5434,
        path: "/",
        timeout: 4000,
        headers: { Accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          if (body.length < 120) body += c.toString();
        });
        res.on("end", () =>
          resolve({ code: res.statusCode || 0, body: body.slice(0, 80) })
        );
      }
    );
    req.on("error", () => resolve({ code: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, body: "" });
    });
  });
}

function isReachable(code) {
  // 503 = schema cache reload — container is up; do NOT restart
  return code === 200 || code === 401 || code === 503;
}

async function waitWindowsHealthy(maxProbes = 20) {
  for (let i = 0; i < maxProbes; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await probePostgrest();
    if (isReachable(p.code)) {
      log(`Windows PostgREST ok (${p.code}) after ${i + 1} probes`);
      return true;
    }
  }
  return false;
}

async function tick() {
  const p = await probePostgrest();
  if (isReachable(p.code)) {
    // Healthy — nothing to do
    return true;
  }

  // PostgREST is down from Windows. Two possible causes:
  // 1. WSL/Docker containers are down → wake them
  // 2. WSL IP changed → wsl-proxy's own health loop handles rebinding

  // Check if containers are actually down before waking
  const containers = containersRunning();

  if (containers === null) {
    // WSL unresponsive — can't determine container state.
    // Don't wake (would fail anyway). Let WSL crash recovery handle it.
    log("Can't determine container state (WSL unresponsive) — waiting");
    return false;
  }

  if (containers) {
    // Containers are running but Windows can't reach PostgREST.
    // This could be a proxy issue (IP change) — let proxy's health loop handle it.
    log(`Windows PostgREST ${p.code || "down"} but containers are running — waiting for proxy self-heal`);
    return false;
  }

  // Containers are down — need to wake them
  const now = Date.now();
  const sinceLastWake = now - lastWakeTime;

  if (sinceLastWake < WAKE_COOLDOWN_MS) {
    log(`Skipping wake — last attempt was ${Math.round(sinceLastWake / 1000)}s ago (cooldown: ${WAKE_COOLDOWN_MS / 1000}s)`);
    return false;
  }

  log(`Windows PostgREST ${p.code || "down"}, containers down — waking WSL/Docker...`);
  lastWakeTime = now;
  const wake = wakeWslAndDocker();
  log(`wake: ${wake}`);

  // Wait for Windows PostgREST to become reachable
  // (PostgREST runs natively on Windows, not inside WSL — no inside-WSL probe needed)
  if (await waitWindowsHealthy(20)) {
    log("Windows PostgREST recovered after wake");
    return true;
  }

  log("PostgREST still not reachable from Windows after wake");
  return false;
}

async function main() {
  if (LOOP) {
    log("Watchdog loop every 60s (503 = wait, never docker-restart; wake cooldown 60s)");
    await tick();
    setInterval(() => {
      tick().catch((e) => log(`tick error: ${e.message}`));
    }, INTERVAL_MS);
  } else {
    const ok = await tick();
    process.exit(ok ? 0 : 1);
  }
}

main().catch((err) => {
  console.error("[local-stack] fatal:", err.message);
  process.exit(1);
});
