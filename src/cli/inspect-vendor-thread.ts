/**
 * Inspect inbox messages from a specific vendor domain or related to a PO#
 * to see what the detector should be catching.
 *
 * Usage:
 *   node --import tsx src/cli/inspect-vendor-thread.ts jabbspe.com
 *   node --import tsx src/cli/inspect-vendor-thread.ts 124800
 *   node --import tsx src/cli/inspect-vendor-thread.ts rootwise
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { getAuthenticatedClient } from '@/lib/gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';

(async () => {
    const arg = process.argv[2];
    if (!arg) { console.error('Usage: inspect-vendor-thread.ts <domain | PO# | keyword>'); process.exit(1); }

    const auth = await getAuthenticatedClient('default');
    const gmail = GmailApi({ version: 'v1', auth });

    const isPONum = /^\d{5,}$/.test(arg);
    const isDomain = arg.includes('.');
    const q = isPONum
        ? `${arg} newer_than:60d`
        : isDomain
            ? `from:@${arg} newer_than:60d`
            : `${arg} newer_than:60d`;

    console.log(`Query: ${q}\n`);
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 30 });
    const msgs = list.data?.messages ?? [];
    console.log(`${msgs.length} messages\n`);

    for (const m of msgs) {
        try {
            const got = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] });
            const hs = got.data.payload?.headers ?? [];
            const f = hs.find((h: any) => h.name === 'From')?.value ?? '';
            const t = hs.find((h: any) => h.name === 'To')?.value ?? '';
            const s = hs.find((h: any) => h.name === 'Subject')?.value ?? '';
            const dt = hs.find((h: any) => h.name === 'Date')?.value ?? '';
            const labels = got.data.labelIds ?? [];
            const dir = labels.includes('SENT') ? '→' : '←';
            console.log(`${dir} ${dt.slice(0, 25)} ${f}`);
            console.log(`   ${s.slice(0, 100)}`);
            console.log(`   labels: ${labels.join(',')}`);
            console.log();
        } catch { /* skip */ }
    }
    process.exit(0);
})().catch(err => { console.error('inspect failed:', err); process.exit(1); });
