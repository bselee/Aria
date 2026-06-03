/**
 * @file    ecosystem.config.cjs
 * @purpose PM2 process manager configuration for Aria's long-running services.
 *          Ensures the Telegram bot (with OpsManager cron schedules) and the
 *          Next.js dashboard survive crashes and machine reboots.
 * @author  Hermia
 * @created 2026-02-25
 * @updated 2026-06-03
 *
 * HERMIA(2026-06-03): Restored aria-bot app definition. The 2026-06-02 refactor
 * gutted the config down to dashboard-only — aria-bot is still running
 * (PID 4608) under PM2's in-memory state but is not in the saved config, so
 * the next `pm2 save` or `pm2 resurrect` after a reboot would silently drop it.
 * aria-bot is the entire cron + Telegram + agent surface. Cannot be lost.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs              # Start all services
 *   pm2 start ecosystem.config.cjs --only aria-bot   # Start just the bot
 *   pm2 restart aria-bot                        # Restart the bot
 *   pm2 logs                                    # Tail all logs
 *   pm2 monit                                   # Real-time monitoring dashboard
 *   pm2 save                                    # Save current process list
 *   pm2 startup                                 # Generate OS startup script
 */

const path = require('path');

module.exports = {
    apps: [
        {
            // ─── Aria Telegram Bot + OpsManager (Cron Schedules) ───
            // Primary process. Runs:
            //   - Telegram command handling (text, documents, commands)
            //   - OpsManager cron schedules (37 jobs, see src/cron/jobs/index.ts)
            //   - All autonomy engine agents (purchasing-followup, comms-master, etc.)
            //
            // HERMIA(2026-06-03): SlackWatchdog deleted from start-bot.ts. The
            // aria-slack process is no longer used. The `purchasing-followup`
            // worker + `comms-master` master agents cover Slack request tracking
            // via the orchestrator notifyCronOutcome pathway.
            name: "aria-bot",
            script: path.join(__dirname, "src", "cli", "start-bot.ts"),
            interpreter: "node",
            // DECISION(2026-02-26): --dns-result-order=ipv4first forces IPv4 for all
            // DNS lookups. Node 18+ prefers IPv6 by default, but Supabase (and most
            // cloud services) don't respond on IPv6 → fetch() hangs indefinitely.
            // DECISION(2026-03-09): --max-old-space-size=1024 caps V8 heap at 1GB.
            // PM2's max_memory_restart uses RSS which can diverge from V8 heap on Windows —
            // the previous session reached 4GB before crashing. This flag enforces a hard
            // limit at the Node.js level so PM2 restarts within seconds of the OOM threshold.
            interpreter_args: "--dns-result-order=ipv4first --import tsx --max-old-space-size=1024",
            cwd: __dirname,
            env: {
                // DECISION(2026-02-25): Load .env.local via dotenv inside the scripts.
                // PM2's env_file doesn't work reliably on Windows.
                NODE_ENV: "production",
            },
            watch: false,
            autorestart: true,
            max_restarts: 20,
            min_uptime: "10s",
            restart_delay: 5000,           // 5s between restart attempts
            max_memory_restart: "800M",    // HERMIA: raised from 768M for headroom
            // HERMIA(2026-05-28): exp_backoff starts at 10s, doubles each restart.
            // Prevents rapid-fire restart cascades on persistent failures.
            exp_backoff_restart_delay: 10000,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            error_file: path.join(__dirname, "logs", "aria-bot-error.log"),
            out_file: path.join(__dirname, "logs", "aria-bot-out.log"),
            merge_logs: true,
            // HERMIA(2026-05-28): Log rotation — cap each log at 10MB, keep 5 rotated copies.
            // Prevents the 256MB error log problem from free-tier rate limit spam.
            max_size: "10M",
            retain: 5,
            // Graceful shutdown: give the bot 5s to clean up Telegram polling
            kill_timeout: 5000,
        },
        {
            // ─── Aria Dashboard (Next.js production mode) ───
            //
            // HISTORY: 2026-04-30 first attempt ran `next dev` with --max-old-space-size=12288
            // and 2GB max_memory_restart. The dev server's JIT compile + 12GB heap budget
            // grew unbounded between pm2 RSS samples and tanked Will's machine (Chrome
            // tabs stuck/timing out). Rolled back same day.
            //
            // CURRENT: Production mode (`next build` once, then `next start`). Idle RSS
            // ~150MB, +3MB after warming three pages. --max-old-space-size=1024 caps
            // V8 heap at 1GB; max_memory_restart at 768M restarts well before that.
            name: "aria-dashboard",
            cwd: __dirname,
            script: "node_modules\\next\\dist\\bin\\next",
            args: "start -p 3001",
            env: {
                NODE_ENV: "production",
            },
            // Note: no log rotation caps here (dashboard logs are quiet in prod).
            // Add max_size/retain if they ever grow.
        },
    ],
};
