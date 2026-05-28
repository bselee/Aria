# Aria Project Context for Hermes Agent

## Overview
Aria is a personal AI agent framework that orchestrates purchasing, AP automation, and business operations. Hermes Agent is integrated as the cognition layer via ACP (Agent Communication Protocol).

## Architecture
- **Main Repo**: `C:\Users\BuildASoil\Documents\Projects\aria`
- **Next.js 14** application with TypeScript
- **PM2 Processes**: 
  - `aria-bot` - Telegram bot, cron jobs, autonomous workflows
  - `aria-dashboard` - Next.js dashboard on port 3001
- **Database**: Supabase (PostgreSQL)
- **Cron**: 37 scheduled jobs in `src/cron/jobs/index.ts`

## Key Directories
- `src/cli/` - Telegram bot handlers, CLI commands
- `src/cron/` - Scheduled job definitions and execution
- `src/lib/intelligence/` - AP processing, email routing, vendor escalation
- `src/lib/purchasing/` - PO management, vendor coordination
- `src/lib/ordering/` - Browser-based vendor cart filling (Uline, Axiom)
- `src/lib/tracking/` - Shipment monitoring, delivery prompts
- `src/lib/scraping/` - Playwright browser automation
- `src/components/dashboard/` - Next.js dashboard panels

## Development Commands
```bash
# Bot process
pm2 restart aria-bot
pm2 logs aria-bot

# Dashboard
npm run build
pm2 restart aria-dashboard

# Database migrations
cd supabase/migrations
# Apply new migrations to Supabase

# Environment
source .env.local
```

## Important Context
- **Hermes Agent Integration**: ACP server configured, working directory set to this project
- **Telegram Commands**: `/order`, `/apsummary`, `/vendor`, `/tracking`, etc.
- **Autonomous Workflows**: PO escalation, delivery exceptions, vendor coordination run automatically
- **Browser Automation**: Playwright-based cart filling for Uline/Axiom (headful mode for visibility)

## Common Tasks
1. Add new cron job: Edit `src/cron/jobs/index.ts`, add `defineJob(...)` block
2. Add Telegram command: Edit `src/cli/commands/hermia.ts`, add to `hermiaCommands` array
3. Add dashboard panel: Create component in `src/components/dashboard/`, register in panel registry
4. Query database: Use Supabase client in TypeScript, migrations in `supabase/migrations/`

## Testing
```bash
npm test              # Jest tests
node --env-file=.env.local src/cli/run-bot.js  # Run bot locally
```

## Key Files
- `src/cron/jobs/index.ts` - All scheduled job definitions
- `src/cli/commands/hermia.ts` - Telegram command registry
- `src/lib/intelligence/telegram-notify.ts` - Telegram notification helpers
- `src/lib/ordering/` - Browser-based ordering system
- `supabase/migrations/` - Database schema migrations
