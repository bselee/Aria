/**
 * @file    test-calendar-builds.ts
 * @purpose Tests extracting builds from the Production Google Calendars for the next 30 days
 *          Usage: npx tsx src/cli/test-calendar-builds.ts
 * @author  Aria
 * @created 2026-02-24
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { CalendarClient } from '../lib/google/calendar';
import { BuildParser } from '../lib/intelligence/build-parser';

async function run() {
    console.log('🗓️ Testing Calendar Builds Agent Phase 1\n');

    const calendarClient = new CalendarClient();
    const buildParser = new BuildParser();

    const daysOut = 30;

    try {
        console.log(`📡 Fetching events from Soil + MFG calendars for the next ${daysOut} days...`);
        const rawEvents = await calendarClient.getAllUpcomingBuilds(daysOut);

        console.log(`✅ Fetched ${rawEvents.length} total events.\n`);

        if (rawEvents.length === 0) {
            console.log('⚠️ No upcoming events found on the calendar.');
            return;
        }

        console.log(`🤖 Passing ${rawEvents.length} events to the LLM for Build Parsing...`);
        const parsedBuilds = await buildParser.extractBuildPlan(rawEvents);

        console.log(`\n📦 Parsed Builds (${parsedBuilds.length}):`);
        console.table(parsedBuilds);

    } catch (err: any) {
        console.error('\n❌ Test failed:', err.message);
        console.log('\nMake sure you have downloaded the Service Account JSON key and saved it as:');
        console.log('google-credentials.json in the project root folder.');
    }
}

run();
