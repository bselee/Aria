/**
 * @file    wsl-proxy.js
 * @purpose TCP port forwarder Windows localhost → WSL2 Docker.
 *          PostgREST (5434): prefer healthy wslrelay (Docker publish). Only kill
 *          wslrelay and own the port when WSL eth0 is reachable from Windows.
 *          Never restart Docker containers. Never treat 503 schema-load as dead.
 * @author  BuildASoil / Hermia
 * @updated 2026-07-16 — wslrelay-first for Docker ports; no hostile kill when eth0 unreachable
 * @deps    net, child_process, fs
 */

const net = require("net");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const FALLBACK_OFFSET = 10000;
const PROXY_PORT_FILE = path.join(__dirname, "..", ".env.proxy");

const PORT_MAP = [
  { listen: 5434, target: 5434, name: "PostgREST", http: true },
  { listen: 5433, target: 5433, name: "Postgres", http: false },
  { listen: 5435, target: 5435, name: "MinIO-API", http: false },
  { listen: 5436, target: 5436, name: "MinIO-Console", http: false },
  { listen: 8000, target: 8000, name: "Honcho", http: false },
];

const boundPorts = {};

function resolveWslIp() {
  let attempts = 0;
  const maxAttempts = 30;
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      attempts++;
      try {
        const raw = execSync("wsl -d Ubuntu hostname -I", {
          timeout: 5000,
          encoding: "utf-8",
          shell: "powershell.exe",
        });
        const wslIp = raw.trim().split(/\s+/)[0];
        if (wslIp && /^\d+\.\d+\.\d+\.\d+$/.test(wslIp)) {
          clearInterval(poll);
          console.log(`[wsl-proxy] WSL2 IP: ${wslIp}`);
          resolve(wslIp);
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error("Could not resolve WSL2 IP"));
        }
      } catch {
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error("WSL2 not reachable"));
        } else {
          console.log(`[wsl-proxy] WSL2 not reachable, retrying... (${attempts}/${maxAttempts})`);
        }
      }
    }, 2000);
  });
}

/** HTTP probe on localhost — 200 or 503 (schema loading) = pipe alive. */
function checkLocalHttp(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = "";
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
    });
    socket.on("data", (buf) => {
      data += buf.toString("utf8");
      if (data.includes("\r\n\r\n") || data.length > 32) {
        socket.destroy();
        // Any HTTP response means forwarder works (incl. 503 schema cache)
        resolve(/HTTP\/\d\.\d\s+\d{3}/.test(data) || data.length > 0);
      }
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(data.length > 0);
    });
    socket.connect(port, "127.0.0.1");
  });
}

function checkTcp(ip, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });
}

/** Probe PostgREST inside WSL (bypasses Windows↔eth0 flakiness). */
function checkInsideWslPostgrest() {
  try {
    const out = execSync(
      'wsl -d Ubuntu -u root bash -c "curl -s -o /dev/null -w %{http_code} --max-time 4 http://127.0.0.1:5434/"',
      { timeout: 8000, encoding: "utf-8", shell: "powershell.exe" }
    ).trim();
    const code = parseInt(out, 10);
    return code === 200 || code === 503;
  } catch {
    return false;
  }
}

function killWslRelay() {
  try {
    execSync("taskkill /F /IM wslrelay.exe", {
      timeout: 5000,
      stdio: "ignore",
      shell: "cmd.exe",
    });
    console.log("[wsl-proxy] Killed wslrelay.exe");
  } catch {
    /* not running */
  }
}

function tryBind(port, targetPort, ip, name, isFallback) {
  return new Promise((resolve) => {
    const server = net.createServer((clientSocket) => {
      const upstream = net.connect(targetPort, ip, () => {
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
      const timeout = setTimeout(() => {
        clientSocket.destroy();
        upstream.destroy();
      }, 60000);
      clientSocket.on("close", () => {
        clearTimeout(timeout);
        upstream.destroy();
      });
      upstream.on("close", () => {
        clearTimeout(timeout);
        clientSocket.destroy();
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(null);
      else {
        console.error(`[wsl-proxy] Server error on ${port} (${name}):`, err.message);
        resolve(null);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const tag = isFallback ? " (fallback)" : "";
      console.log(`[wsl-proxy] 127.0.0.1:${port} → ${ip}:${targetPort} (${name}${tag})`);
      resolve(server);
    });
  });
}

async function waitForLocalHttp(port, attempts = 12, delayMs = 2500) {
  for (let i = 0; i < attempts; i++) {
    const ok = await checkLocalHttp(port, 2500);
    if (ok) return true;
    console.log(`[wsl-proxy] localhost:${port} not ready (${i + 1}/${attempts})`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function createProxy(listenPort, targetPort, ip, name, http) {
  if (listenPort === 5434) {
    // 1) Prefer Docker's wslrelay path — wait for real HTTP on localhost
    const localOk = await waitForLocalHttp(5434, 10, 2000);
    if (localOk) {
      console.log("[wsl-proxy] Port 5434 working via Docker/wslrelay — leaving it");
      boundPorts[name] = 5434;
      return null;
    }

    // 2) Is PostgREST alive inside WSL but Windows path broken?
    const insideOk = checkInsideWslPostgrest();
    const ethOk = await checkTcp(ip, 5434, 3000);

    if (insideOk && ethOk) {
      // eth0 reachable — safe to kill wslrelay and own the port
      console.log("[wsl-proxy] PostgREST up in WSL + eth0 reachable — taking over 5434");
      killWslRelay();
      await new Promise((r) => setTimeout(r, 800));
      const server = await tryBind(5434, targetPort, ip, name, false);
      if (server) {
        boundPorts[name] = 5434;
        return server;
      }
    }

    if (insideOk && !ethOk) {
      // Critical: WSL has PostgREST but Windows cannot route to eth0.
      // Do NOT kill wslrelay — it may still recover; wait longer.
      console.warn(
        "[wsl-proxy] PostgREST alive in WSL but Windows→eth0 broken — waiting on wslrelay (not killing)"
      );
      const recovered = await waitForLocalHttp(5434, 15, 3000);
      if (recovered) {
        console.log("[wsl-proxy] wslrelay recovered for 5434");
        boundPorts[name] = 5434;
        return null;
      }
      console.error(
        "[wsl-proxy] 5434 unreachable from Windows. Run scripts\\aria-startup.bat after WSL network settles."
      );
      boundPorts[name] = null;
      return null;
    }

    // 3) Fallback port if we can reach eth0
    if (ethOk) {
      const fallback = listenPort + FALLBACK_OFFSET;
      const server = await tryBind(fallback, targetPort, ip, name, true);
      boundPorts[name] = server ? fallback : null;
      return server;
    }

    boundPorts[name] = null;
    return null;
  }

  // Non-PostgREST ports
  let server = await tryBind(listenPort, targetPort, ip, name, false);
  if (server) {
    boundPorts[name] = listenPort;
    return server;
  }

  const ethOk = await checkTcp(ip, targetPort, 1500);
  if (ethOk || !http) {
    // Assume docker publish works on primary
    boundPorts[name] = listenPort;
    console.log(`[wsl-proxy] Port ${listenPort} (${name}) already bound — skipping`);
    return null;
  }

  const fallback = listenPort + FALLBACK_OFFSET;
  server = await tryBind(fallback, targetPort, ip, name, true);
  boundPorts[name] = server ? fallback : null;
  return server;
}

function writeProxyEnv(ports) {
  const lines = Object.entries(ports)
    .filter(([, port]) => port !== null)
    .map(([name, port]) => `${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}=${port}`);

  const pgrPort = ports["PostgREST"];
  if (pgrPort) {
    lines.push(`PGREST_PORT=${pgrPort}`);
    lines.push(`PGREST_URL=http://localhost:${pgrPort}`);
  }

  fs.writeFileSync(PROXY_PORT_FILE, lines.join("\n") + "\n");
  console.log(`[wsl-proxy] Proxy env written to ${PROXY_PORT_FILE}`);
}

(async () => {
  try {
    const ip = await resolveWslIp();
    const results = await Promise.allSettled(
      PORT_MAP.map(({ listen, target, name, http }) =>
        createProxy(listen, target, ip, name, http)
      )
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length) console.error(`[wsl-proxy] ${failures.length} proxy start failure(s)`);
    writeProxyEnv(boundPorts);
    console.log(
      `[wsl-proxy] configured=${PORT_MAP.length} active=${Object.values(boundPorts).filter(Boolean).length}`
    );
  } catch (err) {
    console.error("[wsl-proxy] Fatal:", err.message);
    process.exit(1);
  }
})();
