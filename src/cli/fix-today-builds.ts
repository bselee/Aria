/**
 * @file    fix-today-builds.ts
 * @purpose One-time: clean duplicate annotations from today's events and add status emoji to titles
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { CalendarClient, CALENDAR_IDS } from '../lib/google/calendar';
import { FinaleClient } from '../lib/finale/client';
import { BuildParser } from '../lib/intelligence/build-parser';

async function main() {
    console.log('=== Fixing Today\'s Build Events ===\n');

    const calendar = new CalendarClient();
    const finale = new FinaleClient();
    const parser = new BuildParser();

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const completed = await finale.getRecentlyCompletedBuilds(since);
    console.log(`${completed.length} completed build(s) today\n`);

    const events = await calendar.getAllUpcomingBuilds(60);
    const parsedBuilds = await parser.extractBuildPlan(events);

    for (const build of completed) {
        const completedAt = new Date(build.completedAt);
        const timeStr = completedAt.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
            timeZone: 'America/Denver',
        });

        const matched = parsedBuilds.find(p =>
            p.sku === build.sku &&
            p.eventId !== null &&
            Math.abs(new Date(p.buildDate).getTime() - completedAt.getTime()) < 2 * 86400000
        );

        if (!matched?.eventId || !matched.calendarId) {
            console.log(`  ⏭️ ${build.sku} — no calendar match, skipping`);
            continue;
        }

        // Fetch current event data
        const existing = await calendar.getEventRaw(matched.calendarId, matched.eventId);
        if (!existing) {
            console.log(`  ⏭️ ${build.sku} — could not read event, skipping`);
            continue;
        }

        const scheduledQty = matched.quantity;
        const icon = (scheduledQty && build.quantity < scheduledQty) ? '🟡' : '✅';

        // Build the correct title (strip any existing emoji prefix, then prepend icon)
        let cleanTitle = existing.summary
            .replace(/^[✅🟡🔴]\s*/, ''); // strip existing icon if present
        const newTitle = `${icon} ${cleanTitle}`;

        // Build clean description: remove duplicate "Completed:" lines, keep one
        const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
        const buildApiPath = build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`;
        const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/view/build/${Buffer.from(buildApiPath).toString('base64')}`;

        let completionNote: string;
        if (scheduledQty && scheduledQty !== build.quantity) {
            const pct = Math.round((build.quantity / scheduledQty) * 100);
            completionNote = `${icon} Completed: ${timeStr} — ${build.quantity.toLocaleString()} of ${scheduledQty.toLocaleString()} scheduled (${pct}%)`;
        } else {
            completionNote = `${icon} Completed: ${timeStr} (${build.quantity.toLocaleString()} units)`;
        }
        completionNote += `\n→ <a href="${finaleUrl}">Build #${build.buildId}</a>`;

        // Strip ALL existing completion annotations from description, then add one clean one
        const descLines = (existing.description || '').split('\n');
        const cleanLines = descLines.filter(line =>
            !line.includes('Completed:') &&
            !line.includes('Build #') &&
            !line.startsWith('→')
        );
        const newDesc = [...cleanLines.filter(l => l.trim()), completionNote].join('\n');

        console.log(`  ${icon} ${build.sku}: "${newTitle}"`);
        console.log(`     desc: ${completionNote.replace('\n', ' | ')}`);

        await calendar.updateEventTitleAndDescription(
            matched.calendarId,
            matched.eventId,
            newTitle,
            newDesc
        );
        console.log(`     ✅ Updated\n`);
    }

    console.log('=== Done ===');
}

main().catch(console.error);
