/**
 * @file kill-stale-postgrest.js
 * @purpose Kill ALL existing postgrest.exe processes before spawning a fresh
 *          one. Since the PM2-managed process is a Node.js wrapper (not
 *          postgrest.exe itself), no postgrest.exe should survive a restart.
 * @author Hermia (Aria)
 * @created 2026-07-23
 * @deps child_process
 */

const { execFileSync } = require('child_process');

function killAllPostgrest() {
  try {
    const stdout = execFileSync('wmic', [
      'process', 'where', "name='postgrest.exe'", 'get', 'processid',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });

    const lines = stdout.trim().split('\n').slice(1);
    let killed = 0;

    for (const line of lines) {
      const pid = parseInt(line.trim(), 10);
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
          killed++;
        } catch {
          // Already gone — fine
        }
      }
    }

    if (killed > 0) {
      console.warn(`[kill-stale] Killed ${killed} stale postgrest.exe process(es)`);
    }
  } catch (err) {
    // wmic may fail silently; non-fatal
    if (err.message && !err.message.includes('No Instance')) {
      console.warn(`[kill-stale] Could not scan: ${err.message}`);
    }
  }
}

module.exports = { killAllPostgrest };

if (require.main === module) {
  killAllPostgrest();
}
