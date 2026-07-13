/**
 * @file    ecosystem.config.cjs
 * @purpose PM2 process manager configuration for Aria's long-running services.
 * @author  Hermia
 * @created 2026-02-25
 * @updated 2026-07-13 — local-stack watchdog, correct wsl-proxy path
 *
 * HERMIA(2026-07-10): windowsHide:true on all apps to stop cmd.exe focus steal.
 * HERMIA(2026-07-13): local-stack keeps Docker/PostgREST up; wsl-proxy path fixed.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --only aria-bot
 *   pm2 save
 */

const path = require("path");

module.exports = {
    apps: [
        {
            name: "aria-bot",
            script: path.join(__dirname, "src", "cli", "start-bot.ts"),
            interpreter: "node",
            interpreter_args:
                "--dns-result-order=ipv4first --import tsx --max-old-space-size=2048",
            cwd: __dirname,
            env: {
                NODE_ENV: "production",
            },
            watch: false,
            autorestart: true,
            max_restarts: 20,
            min_uptime: "10s",
            restart_delay: 5000,
            max_memory_restart: "1800M",
            exp_backoff_restart_delay: 10000,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            error_file: path.join(__dirname, "logs", "aria-bot-error.log"),
            out_file: path.join(__dirname, "logs", "aria-bot-out.log"),
            merge_logs: true,
            max_size: "10M",
            retain: 5,
            kill_timeout: 15000,
            windowsHide: true,
        },
        {
            name: "aria-dashboard",
            cwd: __dirname,
            script: "node_modules\\next\\dist\\bin\\next",
            args: "start -p 3001",
            env: {
                NODE_ENV: "production",
            },
            restart_delay: 5000,
            min_uptime: "30s",
            exp_backoff_restart_delay: 10000,
            max_restarts: 20,
            kill_timeout: 15000,
            windowsHide: true,
        },
        {
            name: "wsl-proxy",
            cwd: __dirname,
            script: path.join(__dirname, "scripts", "wsl-proxy.js"),
            interpreter: "node",
            watch: false,
            autorestart: true,
            max_restarts: 20,
            restart_delay: 5000,
            windowsHide: true,
        },
        {
            name: "local-stack",
            cwd: __dirname,
            script: path.join(__dirname, "scripts", "local-stack-watchdog.js"),
            args: "--loop",
            interpreter: "node",
            watch: false,
            autorestart: true,
            max_restarts: 20,
            restart_delay: 10000,
            windowsHide: true,
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            error_file: path.join(__dirname, "logs", "local-stack-error.log"),
            out_file: path.join(__dirname, "logs", "local-stack-out.log"),
            merge_logs: true,
        },
    ],
};
