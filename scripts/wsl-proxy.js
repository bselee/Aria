/**
 * @file    scripts/wsl-proxy.js
 * @purpose Lightweight TCP proxy that forwards Windows localhost ports to
 *          WSL2 Docker container ports. The WSL2 VM IP changes on every
 *          restart, which breaks Docker port forwarding to Windows localhost.
 *          This proxy auto-discovers the WSL2 IP and re-connects when it changes.
 *
 *          Handles the wslrelay.exe conflict: when WSL2's built-in relay binds
 *          a port but fails to forward, this proxy detects the failure and
 *          binds an alternate port, updating a .env.proxy file that the app
 *          can read as a fallback.
 *
 *          Run as a PM2 process:
 *            pm2 start scripts/wsl-proxy.js --name wsl-proxy
 *            pm2 save
 *
 * @author  Hermia
 * @created 2026-06-26
 * @deps    net, child_process, fs
 * @env     none — ports are hardcoded below
 */

const net = require("net");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Ports to proxy: Windows port → WSL2 port
const PORTS = [
  { listen: 5434, target: 5434, name: "PostgREST" },  // Aria DB REST API
  { listen: 5433, target: 5433, name: "Postgres" },   // Aria DB direct
  { listen: 5435, target: 5435, name: "MinIO-API" },  // S3-compatible storage
  { listen: 5436, target: 5436, name: "MinIO-Console" },
  { listen: 8000, target: 8000, name: "Honcho" },     // Honcho memory API
];

// Fallback offset: if primary port is taken, try +10000
// (e.g., 5434 → 15434). The app reads .env.proxy for the actual port.
const FALLBACK_OFFSET = 10000;

let wslIP = null;
const servers = [];
// Track which ports we successfully bound
const boundPorts = {};

/**
 * Discover the WSL2 VM IP address.
 * Tries multiple strategies because distro name / default can vary.
 *
 * HERMIA(2026-07-10): Must use execFileSync (argv array) + windowsHide.
 * execSync("wsl ...") routes through cmd.exe on Windows and pops a console
 * every 30s — that was stealing keyboard focus constantly.
 *
 * HERMIA(2026-07-13): Fall back to bare `wsl hostname -I` when -d Ubuntu fails
 * or returns empty. Also accept first IPv4 only.
 */
function discoverWSLIP() {
  const attempts = [
    ["-d", "Ubuntu", "-e", "hostname", "-I"],
    ["-e", "hostname", "-I"],
    ["hostname", "-I"],
  ];
  for (const args of attempts) {
    try {
      const output = execFileSync("wsl.exe", args, {
        encoding: "utf-8",
        timeout: 10000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const ip = output.split(/\s+/).find((part) => /^\d+\.\d+\.\d+\.\d+$/.test(part));
      if (ip) return ip;
    } catch {
      // try next strategy
    }
  }
  return null;
}

/**
 * Check if a port is actually reachable on localhost.
 * wslrelay.exe sometimes binds a port but doesn't forward connections.
 * For PostgREST (5434), also require an HTTP response when possible.
 */
function checkPortReachable(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on("connect", () => {
      // For PostgREST, probe HTTP GET / to catch half-dead relays
      if (port === 5434) {
        socket.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
        let gotData = false;
        socket.on("data", () => {
          gotData = true;
          socket.destroy();
          resolve(true);
        });
        setTimeout(() => {
          socket.destroy();
          resolve(gotData);
        }, 1500);
        return;
      }
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
 * If the primary port is in use (by wslrelay), try the fallback port.
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
 * The app can source this if the primary ports don't work.
 */
function writeProxyEnv() {
  const lines = ["# Auto-generated by wsl-proxy.js — do not edit"];
  for (const { name, listen } of PORTS) {
    const port = boundPorts[name];
    if (port && port !== listen) {
      lines.push(`# ${name}: primary ${listen} unavailable, using ${port}`);
    }
  }
  const envPath = path.join(__dirname, "..", ".env.proxy");
  try {
    fs.writeFileSync(envPath, lines.join("\n") + "\n");
  } catch {
    // Non-critical
  }
}

/**
 * Start all proxy servers. If WSL IP changes, tear down and recreate.
 */
async function startProxies(ip) {
  // Tear down existing servers
  for (const s of servers) {
    try { s.close(); } catch {}
  }
  servers.length = 0;

  console.log(`[wsl-proxy] WSL2 IP: ${ip}`);
  for (const { listen, target, name } of PORTS) {
    const s = await createProxy(listen, target, ip, name);
    if (s) servers.push(s);
  }
  writeProxyEnv();
}

/**
 * Main loop: discover IP every 30s, restart proxies if IP changed.
 * Also checks if previously-skipped ports (handled by wslrelay) are still
 * working — if wslrelay dies, we take over.
 */
function main() {
  console.log("[wsl-proxy] Starting WSL2 port proxy...");

  let lastIP = null;

  const checkLoop = async () => {
    const ip = discoverWSLIP();
    if (!ip) {
      console.log("[wsl-proxy] WSL2 not reachable, retrying...");
      return;
    }
    if (ip !== lastIP) {
      console.log(`[wsl-proxy] WSL2 IP changed: ${lastIP || "(none)"} → ${ip}`);
      await startProxies(ip);
      lastIP = ip;
    } else {
      // Same IP — check if any wslrelay-handled ports went dead
      for (const { listen, target, name } of PORTS) {
        if (boundPorts[name] === listen && servers.length > 0) {
          // We skipped this port (wslrelay was handling it). Check if it's still alive.
          const reachable = await checkPortReachable(listen);
          if (!reachable) {
            console.log(`[wsl-proxy] Port ${listen} (${name}) went dead — taking over`);
            const s = await createProxy(listen, target, ip, name);
            if (s) {
              servers.push(s);
              writeProxyEnv();
            }
          }
        }
      }
    }
  };

  setInterval(checkLoop, 30000);

  // Initial discovery
  checkLoop();
}

main();
