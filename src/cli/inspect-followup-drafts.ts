/**
 * Inspect current Gmail drafts that look like follow-up pokes Aria created.
 * Prints: To, Subject, draftId, plus the vendor's most recent inbound reply
 * to bill.selee (if any) so we can see what the detector missed.
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { getAuthenticatedClient } from '@/lib/gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';

(async () => {
    const auth = await getAuthenticatedClient('default');
    const gmail = GmailApi({ version: 'v1', auth });

    const drafts = await gmail.users.drafts.list({ userId: 'me', maxResults: 30 });
    const items = drafts.data.drafts ?? [];

    for (const d of items) {
        if (!d.id) continue;
        const got = await gmail.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata', metadataHeaders: ['To', 'Subject'] });
        const headers = got.data.message?.payload?.headers ?? [];
        const to = headers.find((h: any) => h.name === 'To')?.value ?? '';
        const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '';

        // Show ALL drafts

        const poMatch = subject.match(/PO\s*#?\s*(\d+)/i);
        const poNum = poMatch?.[1] ?? '???';
        const domain = (to.match(/@([\w-]+\.[\w.-]+)/)?.[1] ?? '').toLowerCase();

        console.log(`\n── PO ${poNum} → ${to} ─────────────`);
        console.log(`   Subject: ${subject.slice(0, 90)}`);
        console.log(`   DraftId: ${d.id}`);

        if (domain) {
            const inbound = await gmail.users.messages.list({
                userId: 'me',
                q: `from:@${domain} newer_than:30d`,
                maxResults: 10,
            });
            const msgs = inbound.data?.messages ?? [];
            console.log(`   Recent inbound from @${domain}: ${msgs.length}`);
            for (const m of msgs.slice(0, 5)) {
                try {
                    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
                    const hs = msg.data.payload?.headers ?? [];
                    const f = hs.find((h: any) => h.name === 'From')?.value ?? '';
                    const s = hs.find((h: any) => h.name === 'Subject')?.value ?? '';
                    const dt = hs.find((h: any) => h.name === 'Date')?.value ?? '';
                    const containsPO = poNum !== '???' && new RegExp(`\\b${poNum}\\b`).test(s);
                    console.log(`     - ${f} | ${dt.slice(0, 20)} ${containsPO ? '[has PO#]' : ''}`);
                    console.log(`       ${s.slice(0, 80)}`);
                } catch { /* skip */ }
            }
        }
    }
    process.exit(0);
})().catch(err => { console.error('inspect failed:', err); process.exit(1); });
