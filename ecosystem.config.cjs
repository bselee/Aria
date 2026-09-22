// aria-bot — Telegram bot + cron runner (src/cli/start-bot.ts).
// Mirrors the aria-bot entry in ecosystem.config.json. The watchdog's
// Restart-AriaBot cold-start path reads THIS file, so it must point at the
// real bot script, not `next start -p 3000` (which is aria-dashboard's job).
module.exports = {
  apps: [{
    name: 'aria-bot',
    script: 'src/cli/start-bot.ts',
    interpreter: 'node',
    node_args: '--import tsx',
    cwd: 'C:/Users/BuildASoil/Documents/Projects/aria',
    windowsHide: true,
    max_restarts: 5,
    restart_delay: 30000,
    min_uptime: '10s'
  }]
};
