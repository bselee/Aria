/**
 * @file pg-health-watchdog.js
 * @purpose Lightweight PM2 process that probes PostgreSQL :5432 every 60s.
 *          Replaces the old WSL/local-stack watchdog — no proxy, no Docker,
 *          just a direct TCP health check against native Postgres.
 * @author Hermia (Aria)
 * @created 2026-07-23
 * @deps net, fs
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const PROBE_INTERVAL_MS = 60_000;
const PG_HOST = '127.0.0.1';
const PG_PORT = 5432;
const LOG_FILE = path.join(__dirname, '..', 'data', 'pg-health.log');

let failureCount = 0;
let probeCount = 0;
const MAX_FAILURES_BEFORE_WARN = 3;
const HEARTBEAT_INTERVAL = 15; // log a healthy heartbeat every N successful probes

function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // best-effort logging
  }
  if (level === 'WARN' || level === 'ERROR') {
    console.error(line.trim());
  }
}

function probePostgres() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);

    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(PG_PORT, PG_HOST);
  });
}

async function checkHealth() {
  const alive = await probePostgres();

  if (alive) {
    probeCount++;
    if (failureCount >= MAX_FAILURES_BEFORE_WARN) {
      log('INFO', `PostgreSQL recovered after ${failureCount} failures`);
    }
    failureCount = 0;
    if (probeCount % HEARTBEAT_INTERVAL === 0) {
      const msg = `PG heartbeat OK — ${probeCount} probes, 0 failures`;
      log('INFO', msg);
      console.log(msg);
    }
  } else {
    failureCount++;
    if (failureCount >= MAX_FAILURES_BEFORE_WARN) {
      log('WARN',
        `PostgreSQL unreachable for ${failureCount} consecutive probes ` +
        `(${PG_HOST}:${PG_PORT})`)
      ;
    } else {
      log('DEBUG', `Probe failed (failure #${failureCount})`);
    }
  }
}

log('INFO', 'PG health watchdog started');
checkHealth(); // immediate first probe
setInterval(checkHealth, PROBE_INTERVAL_MS);

// Graceful shutdown
process.on('SIGTERM', () => {
  log('INFO', 'Watchdog stopped (SIGTERM)');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('INFO', 'Watchdog stopped (SIGINT)');
  process.exit(0);
});
