/**
 * @file start-postgrest.js
 * @purpose PM2 entrypoint for aria-postgrest. Kills orphan postgrest.exe
 *          processes (that would serve stale config), then spawns the real
 *          binary with the current config file.
 * @author Hermia (Aria)
 * @created 2026-07-23
 * @deps child_process, path, ./kill-stale-postgrest
 * @env CWD = project root (set by PM2 ecosystem cwd)
 */

const { spawn } = require('child_process');
const path = require('path');
const { killAllPostgrest } = require('./kill-stale-postgrest');

// Step 1: Remove orphan processes  (async — non-blocking before spawn)
killAllPostgrest();

// Step 2: Launch the real binary
const projectRoot = process.cwd();
const postgrestPath = path.join(projectRoot, 'bin', 'postgrest.exe');
const configPath = path.join(projectRoot, 'postgrest.conf');

const proc = spawn(postgrestPath, [configPath], {
  cwd: projectRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

proc.on('exit', (code, signal) => {
  process.exit(code ?? 1);
});

process.on('SIGTERM', () => {
  proc.kill('SIGTERM');
});
process.on('SIGINT', () => {
  proc.kill('SIGTERM');
});
