/**
 * @file    test-build-annotations.ts
 * @purpose Dry-run today's build completions to preview calendar annotations
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { CalendarClient, CALENDAR_IDS } from '../lib/google/calendar';
import { FinaleClient } from '../lib/finale/client';
import { BuildParser } from '../lib/intelligence/build-parser';

async function main() {
    console.log('=== Today\'s Build Completions — Annotation Preview ===\n');

    const finale = new FinaleClient();
    const since = new Date();
    since.setHours(0, 0, 0, 0); // midnight today

    const completed = await finale.getRecentlyCompletedBuilds(since);
    console.log(`Found ${completed.length} completed build(s) today:\n`);

    if (completed.length === 0) {
        console.log('No completed builds found today.');
        return;
    }

    // Fetch calendar events for matching
    const calendar = new CalendarClient();
    const parser = new BuildParser();
    const events = await calendar.getAllUpcomingBuilds(60);
    const parsedBuilds = await parser.extractBuildPlan(events);

    for (const build of completed) {
        const completedAt = new Date(build.completedAt);
        const timeStr = completedAt.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
            timeZone: 'America/Denver',
        });

        // Match to calendar event
        const matched = parsedBuilds.find(p =>
            p.sku === build.sku &&
            p.eventId !== null &&
            Math.abs(new Date(p.buildDate).getTime() - completedAt.getTime()) < 2 * 86400000
        );

        // Build URL
        const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
        const buildApiPath = build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`;
        const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/view/build/${Buffer.from(buildApiPath).toString('base64')}`;

        // Build annotation
        const scheduledQty = matched?.quantity;
        let completionNote: string;
        if (scheduledQty && scheduledQty !== build.quantity) {
            const pct = Math.round((build.quantity / scheduledQty) * 100);
            const icon = build.quantity < scheduledQty ? '🟡' : '✅';
            completionNote = `${icon} Completed: ${timeStr} — ${build.quantity.toLocaleString()} of ${scheduledQty.toLocaleString()} scheduled (${pct}%)`;
        } else {
            completionNote = `✅ Completed: ${timeStr} (${build.quantity.toLocaleString()} units)`;
        }
        completionNote += `\n→ Build #${build.buildId} ${finaleUrl}`;

        console.log(`  ${build.sku} × ${build.quantity} (Build #${build.buildId})`);
        console.log(`    Matched calendar event: ${matched ? `"${matched.sku}" on ${matched.buildDate} (scheduled: ${matched.quantity})` : 'NONE'}`);
        console.log(`    Annotation: ${completionNote}`);
        console.log(`    Finale URL: ${finaleUrl}`);
        console.log();
    }

    // Ask before applying
    const applyArg = process.argv.includes('--apply');
    if (!applyArg) {
        console.log('--- DRY RUN — pass --apply to write annotations to calendar ---');
        return;
    }

    console.log('\n--- APPLYING annotations to calendar ---\n');
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
            console.log(`  ⏭️ ${build.sku} — no matching calendar event, skipping`);
            continue;
        }

        const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
        const buildApiPath = build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`;
        const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/view/build/${Buffer.from(buildApiPath).toString('base64')}`;

        const scheduledQty = matched.quantity;
        let completionNote: string;
        if (scheduledQty && scheduledQty !== build.quantity) {
            const pct = Math.round((build.quantity / scheduledQty) * 100);
            const icon = build.quantity < scheduledQty ? '🟡' : '✅';
            completionNote = `${icon} Completed: ${timeStr} — ${build.quantity.toLocaleString()} of ${scheduledQty.toLocaleString()} scheduled (${pct}%)`;
        } else {
            completionNote = `✅ Completed: ${timeStr} (${build.quantity.toLocaleString()} units)`;
        }
        completionNote += `\n→ <a href="${finaleUrl}">Build #${build.buildId}</a>`;

        await calendar.appendToEventDescription(matched.calendarId, matched.eventId, completionNote);
        console.log(`  ✅ ${build.sku} — annotated on "${matched.sku}" event`);
    }

    console.log('\n=== Done ===');
}

main().catch(console.error);
