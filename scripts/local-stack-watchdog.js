/**
 * @file    scripts/local-stack-watchdog.js
 * @purpose Keep Aria local data plane up: WSL Docker compose + PostgREST probe.
 *          On 503 (schema cache reload), restarts only postgrest after db healthy.
 * @author  Hermia
 * @created 2026-07-13
 * @deps    child_process, http
 * @env     none required
 *
 * Usage:
 *   node scripts/local-stack-watchdog.js           # one-shot ensure
 *   node scripts/local-stack-watchdog.js --loop    # every 60s
 *   pm2 start ecosystem.config.cjs --only local-stack
 */

const { execFileSync } = require("child_process");
const http = require("http");

const COMPOSE_DIR =
  "/mnt/c/Users/BuildASoil/Documents/Projects/aria/docker/aria-db";
const LOOP = process.argv.includes("--loop");
const INTERVAL_MS = 60_000;

function wsl(args, timeout = 60000) {
  return execFileSync("wsl.exe", args, {
    encoding: "utf-8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function composeUp() {
  try {
    const out = wsl([
      "-e",
      "bash",
      "-lc",
      `cd ${COMPOSE_DIR} && docker compose up -d 2>&1`,
    ]);
    return out.trim().split("\n").slice(-6).join(" | ");
  } catch (err) {
    return `compose error: ${err.message}`;
  }
}

function restartPostgrest() {
  try {
    const out = wsl([
      "-e",
      "bash",
      "-lc",
      `cd ${COMPOSE_DIR} && ` +
        `for i in 1 2 3 4 5 6 7 8 9 10; do ` +
        `st=$(docker inspect -f '{{.State.Health.Status}}' aria-db 2>/dev/null || echo none); ` +
        `[ "$st" = healthy ] && break; sleep 2; done; ` +
        `docker restart aria-postgrest 2>&1; sleep 3; ` +
        `docker logs aria-postgrest --tail 3 2>&1`,
    ]);
    return out.trim().split("\n").slice(-5).join(" | ");
  } catch (err) {
    return `restart error: ${err.message}`;
  }
}

/**
 * Probe PostgREST HTTP root.
 * Returns { code, bodySnippet }
 */
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
          resolve({ code: res.statusCode || 0, body: body.slice(0, 80) }),
        );
      },
    );
    req.on("error", () => resolve({ code: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, body: "" });
    });
  });
}

function isHealthy(code) {
  return code === 200 || code === 401;
}

async function waitHealthy(maxProbes = 20) {
  for (let i = 0; i < maxProbes; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await probePostgrest();
    if (isHealthy(p.code)) {
      console.log(
        `[local-stack] PostgREST recovered (${p.code}) after ${i + 1} probes`,
      );
      return true;
    }
  }
  return false;
}

async function tick() {
  const p = await probePostgrest();
  if (isHealthy(p.code)) {
    if (!LOOP) console.log(`[local-stack] PostgREST ok (${p.code})`);
    return true;
  }

  if (p.code === 503) {
    console.log(
      `[local-stack] PostgREST 503 (schema cache) — restart postgrest after db healthy`,
    );
    const msg = restartPostgrest();
    console.log(`[local-stack] ${msg}`);
    if (await waitHealthy(15)) return true;
  }

  console.log(
    `[local-stack] PostgREST ${p.code || "down"} — ensuring compose...`,
  );
  const msg = composeUp();
  console.log(`[local-stack] ${msg}`);

  // After compose, prefer a targeted postgrest restart once db is up
  const restartMsg = restartPostgrest();
  console.log(`[local-stack] ${restartMsg}`);

  if (await waitHealthy(20)) return true;
  console.warn("[local-stack] PostgREST still not healthy after recovery");
  return false;
}

async function main() {
  if (LOOP) {
    console.log("[local-stack] Watchdog loop every 60s");
    await tick();
    setInterval(() => {
      tick().catch((e) =>
        console.warn("[local-stack] tick error:", e.message),
      );
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
