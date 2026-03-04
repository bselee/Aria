/**
 * @file    test-mfg-calendar.ts
 * @purpose Force-test MFG calendar event creation for today's completed builds
 * @author  Aria
 * @created 2026-03-04
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { CalendarClient, CALENDAR_IDS } from '../lib/google/calendar';
import { FinaleClient } from '../lib/finale/client';
import { BuildParser } from '../lib/intelligence/build-parser';

async function main() {
    console.log('=== Force MFG Calendar Test ===\n');

    // 1. Fetch completed builds using the actual FinaleClient (correct auth)
    const finale = new FinaleClient();
    const since = new Date(Date.now() - 3 * 86400000); // 3 days back
    console.log(`Querying builds completed since: ${since.toISOString()}\n`);

    const completedBuilds = await finale.getRecentlyCompletedBuilds(since);
    console.log(`Found ${completedBuilds.length} completed build(s):\n`);

    if (completedBuilds.length === 0) {
        console.log('No completed builds found. Trying raw GraphQL...\n');

        // Debug: raw query to see what we get without status filter
        const apiBase = 'https://app.finaleinventory.com';
        const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
        const apiKey = process.env.FINALE_API_KEY || '';
        const apiSecret = process.env.FINALE_API_SECRET || '';
        const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
        const sinceStr = since.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const debugQuery = {
            query: `query {
                buildViewConnection(
                    first: 10
                    completeDateActual: { begin: "${sinceStr}", afterInclusive: true }
                    sort: [{ field: "completeDateActual", mode: "desc" }]
                ) {
                    edges {
                        node {
                            buildId
                            status
                            quantityToProduce
                            completeDateActual
                            completeTransactionTimestamp
                            productToProduce { productId }
                        }
                    }
                }
            }`
        };

        console.log(`Auth: Basic ${apiKey.slice(0, 4)}...`);
        console.log(`URL: ${apiBase}/${accountPath}/api/graphql`);
        console.log(`Since: ${sinceStr}\n`);

        const res = await fetch(`${apiBase}/${accountPath}/api/graphql`, {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify(debugQuery),
        });

        console.log(`Response status: ${res.status}`);
        const data = await res.json();

        if (data?.errors) {
            console.error('GraphQL errors:', JSON.stringify(data.errors, null, 2));
        }

        const edges = data?.data?.buildViewConnection?.edges || [];
        console.log(`Raw edges: ${edges.length}`);
        for (const e of edges.slice(0, 10)) {
            console.log(`  #${e.node.buildId} | "${e.node.status}" | ${e.node.productToProduce?.productId || 'N/A'} | qty=${e.node.quantityToProduce} | completeDateActual=${e.node.completeDateActual} | ts=${e.node.completeTransactionTimestamp}`);
        }
        return;
    }

    for (const b of completedBuilds) {
        console.log(`  • ${b.sku} × ${b.quantity} (Build #${b.buildId}) @ ${b.completedAt}`);
    }

    // 2. Get calendar for matching
    const calendar = new CalendarClient();
    const parser = new BuildParser();
    const events = await calendar.getAllUpcomingBuilds(7);
    const parsedBuilds = await parser.extractBuildPlan(events);

    // 3. Create MFG events
    console.log('\n--- Creating MFG calendar events ---\n');
    const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';

    for (const build of completedBuilds) {
        const matched = parsedBuilds.find(p => p.sku === build.sku);
        const completedAt = new Date(build.completedAt);
        const buildDate = completedAt.toISOString().split('T')[0];
        const timeStr = completedAt.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver'
        });

        const finaleUrl = `https://app.finaleinventory.com/${accountPath}/sc2/?build/view/build/${Buffer.from(build.buildUrl || `/${accountPath}/api/workeffort/${build.buildId}`).toString('base64')}`;

        const scheduledQty = matched?.quantity ?? null;
        let title: string;
        if (scheduledQty && scheduledQty !== build.quantity) {
            const diff = build.quantity - scheduledQty;
            const sign = diff > 0 ? '+' : '';
            title = `✅ ${build.sku} ×${build.quantity}/${scheduledQty} (${sign}${diff})`;
        } else {
            title = `✅ ${build.sku} ×${build.quantity}`;
        }

        const descLines: string[] = [];
        descLines.push(`Build Complete · ${timeStr}`);
        if (scheduledQty && scheduledQty !== build.quantity) {
            const pct = Math.round((build.quantity / scheduledQty) * 100);
            descLines.push(`Scheduled: ${scheduledQty} · Actual: ${build.quantity} (${pct}%)`);
        }
        descLines.push(`→ <a href="${finaleUrl}">Build #${build.buildId}</a>`);

        console.log(`Creating: "${title}" on ${buildDate}`);

        try {
            const eventId = await calendar.createEvent(CALENDAR_IDS.MFG, {
                title,
                description: descLines.join('\n'),
                date: buildDate,
            });
            console.log(`  ✅ Created! Event ID: ${eventId}\n`);
        } catch (err: any) {
            console.error(`  ❌ FAILED: ${err.message}`);
            if (err.response?.data) {
                console.error('  Response:', JSON.stringify(err.response.data, null, 2));
            }
            console.log();
        }
    }

    console.log('=== Done ===');
}

main().catch(console.error);
