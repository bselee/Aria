/**
 * One-shot manual run of the PO follow-up watcher. Mirrors what the cron
 * fires at 7:45 AM Mon-Fri. Pass --dry-run to see who would get nudged
 * without actually sending email or writing to Supabase.
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { runPOFollowupWatcher } from '@/lib/purchasing/po-followup-watcher';

const dryRun = process.argv.includes('--dry-run');

(async () => {
    console.log(`[po-followup] starting${dryRun ? ' (DRY RUN)' : ''}...`);
    const outcomes = await runPOFollowupWatcher({ dryRun });
    const counts = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.action] = (acc[o.action] ?? 0) + 1;
        return acc;
    }, {});
    console.log(`[po-followup] outcomes:`, counts);
    for (const o of outcomes) {
        console.log(`  - PO #${o.poNumber} → ${o.action}${o.reason ? ` (${o.reason})` : ''}`);
    }
    process.exit(0);
})().catch(err => {
    console.error('[po-followup] failed:', err);
    process.exit(1);
});
