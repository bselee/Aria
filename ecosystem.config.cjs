/**
 * @file    ecosystem.config.cjs
 * @purpose PM2 process manager configuration for Aria's long-running services.
 *          Ensures both the Telegram bot (with OpsManager cron schedules) and
 *          the Slack Watchdog survive crashes and machine reboots.
 * @author  Antigravity
 * @created 2026-02-25
 * @updated 2026-02-25
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs          # Start all services
 *   pm2 start ecosystem.config.cjs --only aria-bot   # Start just the bot
 *   pm2 start ecosystem.config.cjs --only aria-slack  # Start just the watchdog
 *   pm2 logs                                 # Tail all logs
 *   pm2 monit                                # Real-time monitoring dashboard
 *   pm2 save                                 # Save current process list
 *   pm2 startup                              # Generate OS startup script
 */

const path = require('path');

module.exports = {
    apps: [
        {
            // ─── Aria Telegram Bot + OpsManager (Cron Schedules) ───
            // This is the primary process. It runs:
            //   - Telegram command handling (text, documents, commands)
            //   - OpsManager cron schedules:
            //       • 8:00 AM MT daily PO summary (Telegram + Slack)
            //       • 8:01 AM MT Friday weekly summary (Telegram + Slack)
            //       • Hourly advertisement cleanup
            //       • Every 30 min PO conversation sync
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
        //
        // BEFORE FIRST START or after pulling code: run `npm run build` (with
        // NODE_OPTIONS='--max-old-space-size=12288' — build itself is heavy).
        // pm2 reload aria-dashboard picks up the rebuilt .next/.
        {
            name: "aria-dashboard",
            script: path.join(__dirname, "node_modules", "next", "dist", "bin", "next"),
            args: ["start", "-p", "3001"],
            interpreter: "node",
            interpreter_args: "--dns-result-order=ipv4first --max-old-space-size=1024",
            cwd: __dirname,
            env: {
                NODE_ENV: "production",
                NODE_OPTIONS: "--dns-result-order=ipv4first --max-old-space-size=1024",
            },
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: "30s",
            restart_delay: 5000,
            max_memory_restart: "1200M",
            exp_backoff_restart_delay: 5000,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            error_file: path.join(__dirname, "logs", "aria-dashboard-error.log"),
            out_file: path.join(__dirname, "logs", "aria-dashboard-out.log"),
            merge_logs: true,
            kill_timeout: 5000,
        },
        // DECISION(2026-02-26): aria-slack is now DISABLED as a separate process.
        // The Slack Watchdog runs inside aria-bot so that /requests can access
        // live pending request data without IPC or shared DB.
        // To re-enable standalone mode, uncomment below and remove watchdog from start-bot.ts.
        /*
        {
            // ─── Aria Slack Watchdog (Silent Monitor) ───
            // Polls Will's Slack channels every 60s for product requests.
            // Detects order requests → fuzzy matches to catalog → reports via Telegram.
            name: "aria-slack",
            script: path.join(__dirname, "src", "cli", "start-slack.ts"),
            interpreter: "node",
            interpreter_args: "--import tsx",
            cwd: __dirname,
            env: {
                NODE_ENV: "production",
            },
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: "10s",
            restart_delay: 5000,
            max_memory_restart: "256M",
            exp_backoff_restart_delay: 5000,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            error_file: path.join(__dirname, "logs", "aria-slack-error.log"),
            out_file: path.join(__dirname, "logs", "aria-slack-out.log"),
            merge_logs: true,
            kill_timeout: 3000,
        },
        */
    ],
};
