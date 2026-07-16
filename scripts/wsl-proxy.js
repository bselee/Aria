/**
 * @file    wsl-proxy.js
 * @purpose TCP port forwarder from Windows localhost → WSL2 Docker containers.
 *          Forwards all configured ports automatically. When the primary port
 *          is already bound by wslrelay (Docker's built-in forwarder), checks
 *          if it's working. If not, falls back to port + 10000.
 *
 *          For PostgREST (5434), the check is more patient: retries once
 *          after 5s because PostgREST can take ~10s to start responding
 *          after a container restart.
 *
 * @author  BuildASoil
 * @created 2026-??-??
 * @updated 2026-07-16 — Hermia: retry logic for PostgREST startup delay
 */

const net = require("net");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ── CONFIG ──────────────────────────────────────────
const FALLBACK_OFFSET = 10000;
const PROXY_PORT_FILE = path.join(__dirname, "..", ".env.proxy");

// Map { WSL listen port → Docker target port (same by default) }
const PORT_MAP = [
  { listen: 5434, target: 5434, name: "PostgREST" },  // Aria DB REST API
  { listen: 5433, target: 5433, name: "Postgres" },   // Aria DB direct
  { listen: 5435, target: 5435, name: "MinIO-API" },  // S3-compatible storage
  { listen: 5436, target: 5436, name: "MinIO-Console" },
  { listen: 8000, target: 8000, name: "Honcho" },
];

// Global bound ports map: name → port (or null if fallback failed)
const boundPorts = {};

// ── HELPERS ──────────────────────────────────────────

/**
 * Resolve the WSL2 VM's IP address by repeatedly querying `wsl hostname -I`.
 * Retries up to 30 times (60 seconds) because WSL2 may still be booting.
 */
function resolveWslIp() {
  let attempts = 0;
  const interval = 2000;
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
        const lines = raw.trim().split(/\s+/);
        const wslIp = lines[0];

        if (wslIp && /^\d+\.\d+\.\d+\.\d+$/.test(wslIp)) {
          clearInterval(poll);
          console.log(`[wsl-proxy] WSL2 IP: ${wslIp}`);
          resolve(wslIp);
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error("Could not resolve WSL2 IP after max attempts"));
        } else {
          console.log(`[wsl-proxy] WSL2 not reachable, retrying... (${attempts}/${maxAttempts})`);
        }
      } catch (e) {
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error("WSL2 not reachable after max attempts"));
        } else {
          console.log(`[wsl-proxy] WSL2 not reachable, retrying... (${attempts}/${maxAttempts})`);
        }
      }
    }, interval);
  });
}

/**
 * Check if a port is actually reachable on localhost.
 * wslrelay.exe sometimes binds a port but doesn't forward connections.
 *
 * For PostgREST (5434): after a container restart, PostgREST can take ~10s
 * to start responding (schema cache reload). We retry once after 5s and
 * wait up to 8s total before giving up.
 */
function checkPortReachable(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on("connect", () => {
      if (port === 5434) {
        // PostgREST: probe HTTP GET / with retry on timeout
        socket.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
        let gotData = false;
        let retried = false;
        socket.on("data", () => {
          gotData = true;
          socket.destroy();
          resolve(true);
        });
        const timer = () => {
          socket.destroy();
          if (!gotData && !retried) {
            retried = true;
            // Wait 5s, then retry with a fresh socket
            setTimeout(() => {
              const s2 = new net.Socket();
              s2.setTimeout(2000);
              s2.on("connect", () => {
                s2.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
                s2.on("data", () => {
                  s2.destroy();
                  resolve(true);
                });
                setTimeout(() => {
                  s2.destroy();
                  resolve(false);
                }, 5000);
              });
              s2.on("error", () => {
                s2.destroy();
                resolve(false);
              });
              s2.on("timeout", () => {
                s2.destroy();
                resolve(false);
              });
              s2.connect(port, "127.0.0.1");
            }, 5000);
          } else {
            resolve(gotData);
          }
        };
        setTimeout(timer, 3000);
        return;
      }

      // For all other ports: just check TCP connectivity
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
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Create a TCP proxy server that forwards connections to the WSL2 IP.
 * If the primary port is in use (by wslrelay), check if it works.
 * If not, try a fallback port.
 */
function createProxy(listenPort, targetPort, ip, name) {
  const tryBind = (port, isFallback) => {
    return new Promise((resolve) => {
      const server = net.createServer((clientSocket) => {
        const upstream = net.connect(targetPort, ip, () => {
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });

        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());

        let timeout = setTimeout(() => {
          clientSocket.destroy();
          upstream.destroy();
        }, 30000);

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
        if (err.code === "EADDRINUSE") {
          resolve(null);
        } else {
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
  };

  return (async () => {
    // Try primary port first
    let server = await tryBind(listenPort, false);
    if (server) {
      boundPorts[name] = listenPort;
      return server;
    }

    // Primary port is taken (likely wslrelay). Check if it's actually working.
    const reachable = await checkPortReachable(listenPort);
    if (reachable) {
      console.log(`[wsl-proxy] Port ${listenPort} (${name}) already bound and working — skipping`);
      boundPorts[name] = listenPort;
      return null; // Don't create a server, wslrelay handles it
    }

    // wslrelay bound the port but it's not forwarding. Use fallback port.
    const fallbackPort = listenPort + FALLBACK_OFFSET;
    console.log(`[wsl-proxy] Port ${listenPort} (${name}) bound but dead — using fallback ${fallbackPort}`);
    server = await tryBind(fallbackPort, true);
    if (server) {
      boundPorts[name] = fallbackPort;
    } else {
      console.error(`[wsl-proxy] Could not bind ${listenPort} or ${fallbackPort} for ${name}`);
      boundPorts[name] = null;
    }
    return server;
  })();
}

/**
 * Write a .env.proxy file with the actual bound ports.
 * The app reads this to know which port to connect to.
 */
function writeProxyEnv(boundPorts) {
  const lines = Object.entries(boundPorts)
    .filter(([_, port]) => port !== null)
    .map(([name, port]) => `${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}=${port}`);

  // Also write a var for PostgREST_url
  const pgrPort = boundPorts["PostgREST"];
  if (pgrPort) {
    lines.push(`PGREST_PORT=${pgrPort}`);
    lines.push(`PGREST_URL=http://localhost:${pgrPort}`);
  }

  fs.writeFileSync(PROXY_PORT_FILE, lines.join("\n") + "\n");
  console.log(`[wsl-proxy] Proxy env written to ${PROXY_PORT_FILE}`);
}

// ── MAIN ─────────────────────────────────────────────

(async () => {
  try {
    const ip = await resolveWslIp();

    // Start all proxies in parallel
    const results = await Promise.allSettled(
      PORT_MAP.map(({ listen, target, name }) => createProxy(listen, target, ip, name))
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.error(`[wsl-proxy] ${failures.length} proxy(s) failed to start`);
    }

    writeProxyEnv(boundPorts);

    // Keep alive — PM2 handles restart on crash
    console.log(`[wsl-proxy] ${PORT_MAP.length} proxies configured, ${Object.values(boundPorts).filter(Boolean).length} active`);
  } catch (err) {
    console.error("[wsl-proxy] Fatal error:", err.message);
    process.exit(1);
  }
})();
