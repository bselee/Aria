/**
 * One-shot cleanup: delete the bad drafts that went to bill.selee@ instead of
 * the vendor, and reset tracking_requested_at on those POs so the next
 * watcher run produces correct drafts.
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { getAuthenticatedClient } from '@/lib/gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';
import { createClient } from '@/lib/db';

(async () => {
    const auth = await getAuthenticatedClient('default');
    const gmail = GmailApi({ version: 'v1', auth });
    const db = createClient();
    if (!db) { console.error('no supabase'); process.exit(1); }

    // List recent drafts
    const drafts = await gmail.users.drafts.list({ userId: 'me', maxResults: 50 });
    const items = drafts.data.drafts ?? [];
    console.log(`Inspecting ${items.length} drafts...`);

    const affectedPOs = new Set<string>();
    let deleted = 0;

    for (const d of items) {
        if (!d.id) continue;
        try {
            const got = await gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata', metadataHeaders: ['To', 'Subject'] });
            const headers = got.data.message?.payload?.headers ?? [];
            const to = headers.find((h: any) => h.name === 'To')?.value ?? '';
            const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '';

            // Only target our follow-up drafts. They begin with "Re: ... PO # ..."
            // and the bad ones were addressed back to bill.selee.
            if (!/PO\s*#?\s*\d+/i.test(subject)) continue;
            if (!/bill\.selee@buildasoil\.com/i.test(to)) continue;

            const poMatch = subject.match(/PO\s*#?\s*(\d+)/i);
            if (poMatch) affectedPOs.add(poMatch[1]);

            console.log(`  deleting bad draft → To:${to} | Subject:${subject.slice(0, 80)}`);
            await gmail.users.drafts.delete({ userId: 'me', id: d.id });
            deleted += 1;
        } catch (err: any) {
            console.warn('  draft inspect/delete failed:', err?.message ?? err);
        }
    }

    if (affectedPOs.size > 0) {
        const list = Array.from(affectedPOs);
        const orPattern = list.map(n => `po_number.eq.${n},po_number.eq.PO-${n}`).join(',');
        const { error } = await supabase
            .from('purchase_orders')
            .update({ tracking_requested_at: null, updated_at: new Date().toISOString() })
            .or(orPattern);
        if (error) console.error('reset failed:', error.message);
        else console.log(`Reset tracking_requested_at on ${list.length} PO(s): ${list.join(', ')}`);
    }

    console.log(`Done. Deleted ${deleted} bad drafts.`);
    process.exit(0);
})().catch(err => { console.error('cleanup failed:', err); process.exit(1); });
