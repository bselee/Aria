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
            interpreter_args: "--dns-result-order=ipv4first --import tsx",
            cwd: __dirname,
            env: {
                // DECISION(2026-02-25): Load .env.local via dotenv inside the scripts.
                // PM2's env_file doesn't work reliably on Windows.
                NODE_ENV: "production",
            },
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: "10s",
            restart_delay: 5000,           // 5s between restart attempts
            max_memory_restart: "512M",    // Restart if memory exceeds 512MB
            // DECISION(2026-02-25): exp_backoff_restart_delay prevents rapid-fire
            // restarts if there's a persistent error (e.g. expired API key).
            // Delay doubles each restart: 5s → 10s → 20s → 40s → ... up to 5min.
            exp_backoff_restart_delay: 5000,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            error_file: path.join(__dirname, "logs", "aria-bot-error.log"),
            out_file: path.join(__dirname, "logs", "aria-bot-out.log"),
            merge_logs: true,
            // Graceful shutdown: give the bot 5s to clean up Telegram polling
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
