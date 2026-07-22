/**
 * @file    wsl-proxy.js
 * @purpose Simple TCP port forwarder Windows → WSL2 Docker.
 *          Binds localhost ports and proxies to WSL2 IP on matching ports.
 *          Health loop detects WSL IP changes and rebinds.
 *          NO wsl.exe spawn per request — plain TCP only.
 * @author  BuildASoil / Hermia
 * @updated 2026-07-22 — removed WSL-HTTP bridge (was crashing WSL via wsl.exe flood)
 * @deps    net, child_process, fs
 */

const net = require("net");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROXY_PORT_FILE = path.join(__dirname, "..", ".env.proxy");
const WSL_IP_CACHE_FILE = path.join(__dirname, "..", ".wsl-ip-cache");
const HEALTH_INTERVAL_MS = 30_000;
const IP_REFRESH_MS = 120_000;

const SILENT = { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };

function wslArgs(args, timeout = 10000) {
  return execFileSync("wsl.exe", args, { encoding: "utf-8", timeout, ...SILENT });
}

const PORT_MAP = [
  { listen: 5433, target: 5433, name: "Postgres" },
  { listen: 5435, target: 5435, name: "MinIO-API" },
  { listen: 5436, target: 5436, name: "MinIO-Console" },
  { listen: 8000, target: 8000, name: "Honcho" },
];

/** @type {Map<string, net.Server>} */
const servers = new Map();
const boundPorts = {};
let wslIp = null;
let healthTimer = null;

function resolveWslIp() {
  let attempts = 0;
  const maxAttempts = 15;
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      attempts++;
      try {
        const raw = wslArgs(["-d", "Ubuntu", "hostname", "-I"], 5000);
        const ip = raw.trim().split(/\s+/)[0];
        if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          clearInterval(poll);
          console.log(`[wsl-proxy] WSL2 IP: ${ip}`);
          resolve(ip);
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
          console.warn("[wsl-proxy] Could not resolve WSL IP");
          resolve(null);
        }
      } catch {
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          console.warn("[wsl-proxy] WSL hostname failed");
          resolve(null);
        }
      }
    }, 2000);
  });
}

function checkTcp(ip, port, timeoutMs = 2000) {
  if (!ip) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, ip);
  });
}

function createTcpProxy(listenPort, targetPort, ip, name) {
  return new Promise((resolve) => {
    if (!ip) { resolve(null); return; }
    const server = net.createServer((clientSocket) => {
      const upstream = net.connect(targetPort, ip, () => {
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
      const timeout = setTimeout(() => {
        clientSocket.destroy();
        upstream.destroy();
      }, 120_000);
      clientSocket.on("close", () => { clearTimeout(timeout); upstream.destroy(); });
      upstream.on("close", () => { clearTimeout(timeout); clientSocket.destroy(); });
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`[wsl-proxy] Port ${listenPort} (${name}) already in use — skipping`);
      } else {
        console.error(`[wsl-proxy] Server error on ${listenPort} (${name}):`, err.message);
      }
      resolve(null);
    });
    server.listen(listenPort, "127.0.0.1", () => {
      console.log(`[wsl-proxy] 127.0.0.1:${listenPort} → ${ip}:${targetPort} (${name})`);
      resolve(server);
    });
  });
}

async function bindAll(ip) {
  for (const { listen, target, name } of PORT_MAP) {
    // Close old server if exists
    const old = servers.get(name);
    if (old) {
      try { old.close(); } catch {}
      servers.delete(name);
    }
    const server = await createTcpProxy(listen, target, ip, name);
    if (server) {
      servers.set(name, server);
      boundPorts[name] = listen;
    } else {
      boundPorts[name] = null;
    }
  }
}

function writeProxyEnv(ports) {
  const lines = Object.entries(ports)
    .filter(([, port]) => port !== null)
    .map(([name, port]) => `${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}=${port}`);
  fs.writeFileSync(PROXY_PORT_FILE, lines.join("\n") + "\n");
  console.log(`[wsl-proxy] Proxy env written to ${PROXY_PORT_FILE}`);
}

async function healthCheck() {
  let allHealthy = true;
  for (const { listen, target, name } of PORT_MAP) {
    // Check if our server is still listening
    const srv = servers.get(name);
    if (!srv || !srv.listening) {
      allHealthy = false;
      continue;
    }
    // Also verify target is reachable
    if (!(await checkTcp(wslIp, target, 2000))) {
      console.warn(`[wsl-proxy] Health: ${name} target ${wslIp}:${target} unreachable`);
      allHealthy = false;
    }
  }
  if (!allHealthy) {
    console.warn("[wsl-proxy] Health check failed — rebinding all ports...");
    await bindAll(wslIp);
    writeProxyEnv(boundPorts);
  }
}

function startHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    try { await healthCheck(); } catch (err) {
      console.warn("[wsl-proxy] Health loop error:", err.message || err);
    }
  }, HEALTH_INTERVAL_MS);
}

(async () => {
  try {
    // Fast path: use cached IP from last successful run, verify in background
    let cachedIp = null;
    try {
      cachedIp = fs.readFileSync(WSL_IP_CACHE_FILE, "utf8").trim();
      if (cachedIp && /^\d+\.\d+\.\d+\.\d+$/.test(cachedIp)) {
        console.log(`[wsl-proxy] Using cached WSL IP: ${cachedIp}`);
        wslIp = cachedIp;
        // Bind immediately with cached IP so ports are available
        await bindAll(wslIp);
        writeProxyEnv(boundPorts);
        const active = Object.values(boundPorts).filter(Boolean).length;
        console.log(`[wsl-proxy] configured=${PORT_MAP.length} active=${active} (cached IP)`);
      }
    } catch { /* no cache file */ }

    // Always resolve fresh IP (may update if changed)
    const freshIp = await resolveWslIp();
    if (freshIp) {
      if (freshIp !== wslIp) {
        console.log(`[wsl-proxy] Fresh IP differs from cached — rebinding`);
        wslIp = freshIp;
        await bindAll(wslIp);
        writeProxyEnv(boundPorts);
      }
      // Persist for next startup
      try { fs.writeFileSync(WSL_IP_CACHE_FILE, freshIp); } catch {}
    }

    if (!wslIp) {
      console.error("[wsl-proxy] Cannot resolve WSL IP — exiting");
      process.exit(1);
    }

    const active = Object.values(boundPorts).filter(Boolean).length;
    console.log(`[wsl-proxy] configured=${PORT_MAP.length} active=${active}`);

    startHealthLoop();

    // Refresh WSL IP periodically (changes after WSL restart)
    setInterval(async () => {
      try {
        const raw = wslArgs(["-d", "Ubuntu", "hostname", "-I"], 5000);
        const next = raw.trim().split(/\s+/)[0];
        if (next && /^\d+\.\d+\.\d+\.\d+$/.test(next) && next !== wslIp) {
          console.log(`[wsl-proxy] WSL IP changed ${wslIp} → ${next}`);
          wslIp = next;
          await bindAll(wslIp);
          writeProxyEnv(boundPorts);
          try { fs.writeFileSync(WSL_IP_CACHE_FILE, next); } catch {}
        }
      } catch { /* WSL down — health loop handles */ }
    }, IP_REFRESH_MS);

  } catch (err) {
    console.error("[wsl-proxy] Fatal:", err.message);
    process.exit(1);
  }
})();
