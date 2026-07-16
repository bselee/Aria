/**
 * @file    wsl-proxy.js
 * @purpose Port forwarder Windows → WSL2 Docker + WSL-HTTP bridge for PostgREST.
 *          When wslrelay/eth0 fail, PostgREST is still served via `wsl curl`
 *          against localhost:5434 *inside* WSL (always works when container is up).
 * @author  BuildASoil / Hermia
 * @updated 2026-07-16 — WSL HTTP bridge fallback for 5434
 * @deps    net, http, child_process, fs
 */

const net = require("net");
const http = require("http");
const { execSync, spawn } = require("child_process");
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
  const maxAttempts = 15;
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
          // Still continue — bridge doesn't need eth0
          console.warn("[wsl-proxy] Could not resolve WSL IP — bridge-only mode for PostgREST");
          resolve(null);
        }
      } catch {
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          console.warn("[wsl-proxy] WSL hostname failed — bridge-only mode");
          resolve(null);
        } else if (attempts === 1 || attempts % 5 === 0) {
          console.log(`[wsl-proxy] WSL2 not reachable, retrying... (${attempts}/${maxAttempts})`);
        }
      }
    }, 2000);
  });
}

function checkLocalHttp(port, timeoutMs = 2500) {
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

function checkTcp(ip, port, timeoutMs = 2000) {
  if (!ip) return Promise.resolve(false);
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

function checkInsideWslPostgrest() {
  try {
    const out = execSync(
      'wsl -d Ubuntu -u root bash -c "curl -s -o /dev/null -w %{http_code} --max-time 4 http://127.0.0.1:5434/"',
      { timeout: 10000, encoding: "utf-8", shell: "powershell.exe" }
    ).trim();
    const code = parseInt(out, 10);
    return code === 200 || code === 503;
  } catch {
    return false;
  }
}

function tryBindTcp(port, targetPort, ip, name, isFallback) {
  return new Promise((resolve) => {
    if (!ip) {
      resolve(null);
      return;
    }
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
      if (err.code !== "EADDRINUSE") {
        console.error(`[wsl-proxy] Server error on ${port} (${name}):`, err.message);
      }
      resolve(null);
    });
    server.listen(port, "127.0.0.1", () => {
      const tag = isFallback ? " (fallback)" : "";
      console.log(`[wsl-proxy] 127.0.0.1:${port} → ${ip}:${targetPort} (${name}${tag})`);
      resolve(server);
    });
  });
}

/**
 * HTTP reverse proxy via `wsl curl` to PostgREST inside the VM.
 * Works when Docker port publish / eth0 NAT is broken.
 */
function startWslHttpBridge(listenPort = 5434) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = `http://127.0.0.1:5434${req.url || "/"}`;
        const curlArgs = [
          "-d",
          "Ubuntu",
          "-u",
          "root",
          "--",
          "curl",
          "-sS",
          "-i",
          "--max-time",
          "25",
          "-X",
          req.method || "GET",
        ];
        for (const [k, v] of Object.entries(req.headers || {})) {
          const key = k.toLowerCase();
          if (
            key === "host" ||
            key === "connection" ||
            key === "content-length" ||
            key === "transfer-encoding" ||
            key === "accept-encoding"
          ) {
            continue;
          }
          if (Array.isArray(v)) curlArgs.push("-H", `${k}: ${v.join(",")}`);
          else if (v != null) curlArgs.push("-H", `${k}: ${v}`);
        }
        if (body.length > 0) {
          curlArgs.push("--data-binary", "@-");
        }
        curlArgs.push(url);

        const child = spawn("wsl", curlArgs, { windowsHide: true });
        if (body.length > 0) child.stdin.write(body);
        child.stdin.end();

        let out = Buffer.alloc(0);
        let errBuf = Buffer.alloc(0);
        child.stdout.on("data", (d) => {
          out = Buffer.concat([out, d]);
        });
        child.stderr.on("data", (d) => {
          errBuf = Buffer.concat([errBuf, d]);
        });
        child.on("error", (e) => {
          res.statusCode = 502;
          res.end(`WSL bridge spawn error: ${e.message}`);
        });
        child.on("close", (code) => {
          if (!out.length) {
            res.statusCode = 502;
            res.end(
              `WSL bridge empty (exit ${code}): ${errBuf.toString("utf8").slice(0, 200)}`
            );
            return;
          }
          // curl -i may emit multiple headers on redirect; take last block
          const str = out.toString("latin1");
          let splitAt = str.lastIndexOf("\r\n\r\n");
          if (splitAt < 0) splitAt = str.indexOf("\n\n");
          if (splitAt < 0) {
            res.statusCode = 502;
            res.end("WSL bridge: unparseable response");
            return;
          }
          const head = str.slice(0, splitAt);
          const bodyPart = str.slice(splitAt + (str.includes("\r\n\r\n") ? 4 : 2));
          const lines = head.split(/\r?\n/);
          const statusLine = lines[0] || "";
          const m = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
          res.statusCode = m ? parseInt(m[1], 10) : 502;
          for (let i = 1; i < lines.length; i++) {
            const colon = lines[i].indexOf(":");
            if (colon <= 0) continue;
            const hk = lines[i].slice(0, colon).trim();
            const hv = lines[i].slice(colon + 1).trim();
            if (/^(transfer-encoding|connection|content-length)$/i.test(hk)) continue;
            try {
              res.setHeader(hk, hv);
            } catch {
              /* ignore invalid headers */
            }
          }
          res.end(Buffer.from(bodyPart, "latin1"));
        });
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") resolve(null);
      else reject(err);
    });
    server.listen(listenPort, "127.0.0.1", () => {
      console.log(
        `[wsl-proxy] WSL-HTTP bridge 127.0.0.1:${listenPort} → wsl curl http://127.0.0.1:5434 (PostgREST)`
      );
      resolve(server);
    });
  });
}

async function waitForLocalHttp(port, attempts = 4, delayMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    if (await checkLocalHttp(port, 2000)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function createProxy(listenPort, targetPort, ip, name, http) {
  if (listenPort === 5434) {
    // 1) Already working via wslrelay?
    if (await waitForLocalHttp(5434, 3, 1000)) {
      console.log("[wsl-proxy] Port 5434 already working — leaving it");
      boundPorts[name] = 5434;
      return null;
    }

    const insideOk = checkInsideWslPostgrest();

    // Prefer WSL-HTTP bridge — durable when eth0 NAT flaps (common on this host)
    if (insideOk || checkInsideWslPostgrest()) {
      const bridge = await startWslHttpBridge(5434);
      if (bridge) {
        await new Promise((r) => setTimeout(r, 200));
        if (await checkLocalHttp(5434, 8000)) {
          boundPorts[name] = 5434;
          return bridge;
        }
        bridge.close();
        console.warn("[wsl-proxy] WSL bridge bound but probe failed");
      }
    }

    // eth0 TCP as secondary
    const ethOk = ip ? await checkTcp(ip, 5434, 2000) : false;
    if (ethOk) {
      const server = await tryBindTcp(5434, targetPort, ip, name, false);
      if (server) {
        await new Promise((r) => setTimeout(r, 300));
        if (await checkLocalHttp(5434, 2500)) {
          boundPorts[name] = 5434;
          return server;
        }
        server.close();
      }
    }

    console.error("[wsl-proxy] PostgREST unavailable on Windows and inside WSL");
    boundPorts[name] = null;
    return null;
  }

  // Other ports — TCP only
  let server = await tryBindTcp(listenPort, targetPort, ip, name, false);
  if (server) {
    boundPorts[name] = listenPort;
    return server;
  }
  if (ip && (await checkTcp(ip, targetPort, 1000))) {
    boundPorts[name] = listenPort;
    console.log(`[wsl-proxy] Port ${listenPort} (${name}) already bound — skipping`);
    return null;
  }
  const fallback = listenPort + FALLBACK_OFFSET;
  server = await tryBindTcp(fallback, targetPort, ip, name, true);
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
    if (failures.length) {
      console.error(`[wsl-proxy] ${failures.length} proxy failure(s)`, failures[0].reason);
    }
    writeProxyEnv(boundPorts);
    console.log(
      `[wsl-proxy] configured=${PORT_MAP.length} active=${Object.values(boundPorts).filter(Boolean).length}`
    );
  } catch (err) {
    console.error("[wsl-proxy] Fatal:", err.message);
    process.exit(1);
  }
})();
