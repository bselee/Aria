/**
 * @file    diagnose-ap-stuck.ts
 * @purpose Quick diagnostic script to surface stuck AP inbox items and recent activity.
 *          Run manually when investigating forwarding/processing failures.
 *
 * @usage   node --import tsx src/scripts/diagnose-ap-stuck.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import { createClient } from '@/lib/db';

const client = createClient();

async function main() {
    console.log('=== STEP 1: Stuck Items in ap_inbox_queue ===\n');
    const { data: stuckItems, error: err1 } = await client
        .from('ap_inbox_queue')
        .select('id, created_at, email_from, email_subject, status, source_inbox, extracted_json')
        .in('status', ['ERROR_FORWARDING', 'ERROR_PROCESSING'])
        .order('created_at', { ascending: false });

    if (err1) {
        console.error('Error querying stuck items:', err1);
        return;
    }

    if (!stuckItems || stuckItems.length === 0) {
        console.log('No stuck items found.');
    } else {
        console.log(`Found ${stuckItems.length} stuck item(s):\n`);
        for (const item of stuckItems) {
            console.log(`ID: ${item.id}`);
            console.log(`  Created: ${item.created_at}`);
            console.log(`  From: ${item.email_from}`);
            console.log(`  Subject: ${item.email_subject}`);
            console.log(`  Status: ${item.status}`);
            console.log(`  Source Inbox: ${item.source_inbox}`);
            console.log(`  Extracted JSON: ${JSON.stringify(item.extracted_json, null, 2)}`);
            console.log('');
        }
    }

    console.log('=== STEP 2: Recent Activity Log (48h) ===\n');
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: activityLog, error: err2 } = await client
        .from('ap_activity_log')
        .select('id, created_at, email_from, email_subject, intent, action_taken, metadata')
        .gte('created_at', fortyEightHoursAgo)
        .order('created_at', { ascending: false })
        .limit(30);

    if (err2) {
        console.error('Error querying activity log:', err2);
        return;
    }

    if (!activityLog || activityLog.length === 0) {
        console.log('No recent activity log entries.');
    } else {
        console.log(`Found ${activityLog.length} recent entries:\n`);
        for (const entry of activityLog) {
            console.log(`ID: ${entry.id} | ${entry.created_at}`);
            console.log(`  From: ${entry.email_from}`);
            console.log(`  Subject: ${entry.email_subject}`);
            console.log(`  Intent: ${entry.intent}`);
            console.log(`  Action: ${entry.action_taken}`);
            console.log(`  Metadata: ${JSON.stringify(entry.metadata)}`);
            console.log('');
        }
    }
}

main().catch(console.error);