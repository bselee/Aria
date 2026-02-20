/**
 * @file    populate-memories.ts
 * @purpose Backfills Pinecone and Supabase with PO data from the last 2 weeks.
 * @author  Antigravity
 * @created 2026-02-20
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { google } from 'googleapis';
import { getAuthenticatedClient } from '../lib/gmail/auth';
import { processEmailAttachments } from '../lib/gmail/attachment-handler';
import { createClient } from '../lib/supabase';
import { indexOperationalContext } from '../lib/intelligence/pinecone';

async function main() {
    console.log("🧠 Starting PO Memory Backfill (Last 2 Weeks)...");

    try {
        const auth = await getAuthenticatedClient("default");
        const gmail = google.gmail({ version: "v1", auth });
        const supabase = createClient();

        // 1. Calculate date 14 days ago
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const dateQuery = twoWeeksAgo.toISOString().split('T')[0].replace(/-/g, '/');

        console.log(`🔎 Searching for POs since ${dateQuery}...`);

        // 2. Search Gmail
        const { data: search } = await gmail.users.messages.list({
            userId: "me",
            q: `label:PO after:${dateQuery}`,
            maxResults: 100
        });

        if (!search.messages?.length) {
            console.log("📭 No messages found in PO label for this timeframe.");
            return;
        }

        console.log(`📥 Found ${search.messages.length} messages. Processing attachments...`);

        // 3. Process each message
        for (const m of search.messages) {
            try {
                const { data: msg } = await gmail.users.messages.get({
                    userId: "me",
                    id: m.id!,
                    format: "metadata"
                });

                const subject = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || "No Subject";
                const from = msg.payload?.headers?.find(h => h.name === 'From')?.value || "Unknown";
                const date = msg.payload?.headers?.find(h => h.name === 'Date')?.value || "";

                console.log(`📄 Processing: ${subject}`);

                // Index thread metadata
                const sentAt = parseInt(msg.internalDate!);
                await indexOperationalContext(
                    `po-thread-${m.id}`,
                    `PO Thread: ${subject} from ${from}. Date: ${new Date(sentAt).toLocaleString()}`,
                    { source: "gmail_backfill", subject, from, date }
                );

                const results = await processEmailAttachments("default", m.id!, {
                    from,
                    subject,
                    date
                });

                console.log(`   ✅ Processed ${results.length} documents from this email.`);
            } catch (err: any) {
                console.error(`   ❌ Failed to process message ${m.id}:`, err.message);
            }
        }

        console.log("✨ Backfill complete!");
    } catch (err: any) {
        console.error("💥 Backfill failed:", err.message);
    }
}

main();
