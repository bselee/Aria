/**
 * Query Supabase for unreplied POs (sent but not acknowledged) and
 * extract vendor info from Gmail email threads for the first batch of 8.
 *
 * Usage:
 *   cd <project-root>
 *   node --import tsx src/cli/query-unreplied-pos.ts
 *
 * @deps    @/lib/db, @/lib/gmail/auth, @googleapis/gmail
 */
import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { createClient } from '@/lib/db';
import { getAuthenticatedClient } from '@/lib/gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';

interface PO {
  po_number: string;
  vendor_name: string | null;
  po_sent_verified_at: string | null;
  vendor_acknowledged_at: string | null;
  vendor_noncomm_at: string | null;
  total: number | null;
  total_amount: number | null;
  line_items: any[] | null;
  lifecycle_stage: string | null;
}

interface VendorInfo {
  poNumber: string;
  vendorName: string | null;
  vendorEmail: string | null;
  gmailSubject: string | null;
  gmailThreadId: string | null;
  gmailDate: string | null;
  gmailFound: boolean;
  domainHints: string[];
}

/** Extract email addresses from a string like "Name <email@domain.com>" */
function extractEmails(text: string): string[] {
  return (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/gi) ?? []).filter(
    e => !/buildasoil\.com/i.test(e)
  );
}

/** Extract domain from an email address */
function domainFromEmail(email: string): string {
  const parts = email.split('@');
  return parts.length > 1 ? parts[1].toLowerCase() : '';
}

/** Search Gmail for a PO thread to extract vendor info */
async function searchPOThread(gmail: any, poNumber: string): Promise<VendorInfo> {
  const digits = poNumber.replace(/^PO-?/i, '');
  const result: VendorInfo = {
    poNumber,
    vendorName: null,
    vendorEmail: null,
    gmailSubject: null,
    gmailThreadId: null,
    gmailDate: null,
    gmailFound: false,
    domainHints: [],
  };

  try {
    // Search for messages containing this PO number
    const search = await gmail.users.messages.list({
      userId: 'me',
      q: `(subject:"PO #${digits}" OR subject:"PO ${digits}" OR subject:"P.O. ${digits}" OR "${digits}") newer_than:120d`,
      maxResults: 15,
    });

    const msgs = search.data?.messages ?? [];
    if (msgs.length === 0) return result;

    // Get full thread details for the first message
    const firstMsg = msgs[0];
    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: firstMsg.threadId,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'To', 'Date', 'Message-ID'],
    });

    result.gmailThreadId = firstMsg.threadId ?? null;

    const allMessages = thread.data.messages ?? [];

    // Find the outbound PO message (Sent by us) — this has the vendor in To or BCC
    // Or inbound messages from vendor replying
    for (const msg of allMessages) {
      const headers = msg.payload?.headers ?? [];
      const from = headers.find((h: any) => h.name === 'From')?.value ?? '';
      const to = headers.find((h: any) => h.name === 'To')?.value ?? '';
      const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '';
      const date = headers.find((h: any) => h.name === 'Date')?.value ?? '';
      const labels = msg.labelIds ?? [];

      const isOutbound = labels.includes('SENT');
      const isFinaleSend = /noreply@mail\.finaleinventory\.com/i.test(from);
      const fromVendor = !isOutbound && !isFinaleSend && !/buildasoil\.com/i.test(from);

      if (isOutbound || isFinaleSend) {
        // This is our message — extract To (vendor email)
        if (!result.gmailSubject) result.gmailSubject = subject;
        if (!result.gmailDate) result.gmailDate = date;

        const toEmails = extractEmails(to);
        const vendorEmails = toEmails.filter(e => !/buildasoil\.com/i.test(e));
        if (vendorEmails.length > 0) {
          result.vendorEmail = vendorEmails[0];
          result.domainHints.push(domainFromEmail(vendorEmails[0]));
        }
      }

      if (fromVendor) {
        // Inbound from vendor — extract vendor email
        if (!result.gmailSubject) result.gmailSubject = subject;
        if (!result.gmailDate) result.gmailDate = date;

        const fromEmails = extractEmails(from);
        if (fromEmails.length > 0) {
          result.vendorEmail = result.vendorEmail ?? fromEmails[0];
          result.domainHints.push(domainFromEmail(fromEmails[0]));
        }
      }

      // Always capture the subject from the first message
      if (!result.gmailSubject && subject) {
        result.gmailSubject = subject;
      }
    }

    // Deduplicate domain hints
    result.domainHints = [...new Set(result.domainHints)];
    result.gmailFound = true;

  } catch (err: any) {
    console.error(`  [!] Gmail error for PO ${poNumber}: ${err?.message ?? err}`);
  }

  return result;
}

(async () => {
  const db = createClient();
  if (!db) {
    console.error('❌ Supabase client not available — check env vars');
    process.exit(1);
  }

  // Step 1: Query unreplied POs (sent but not acknowledged, not noncommittal)
  console.log('🔍 Querying Supabase for unreplied POs...\n');
  const { data: pos, error } = await db
    .from('purchase_orders')
    .select(
      'po_number, vendor_name, po_sent_verified_at, vendor_acknowledged_at, ' +
      'vendor_noncomm_at, total, total_amount, line_items, lifecycle_stage'
    )
    .not('po_sent_verified_at', 'is', null)
    .is('vendor_acknowledged_at', null)
    .is('vendor_noncomm_at', null)
    .order('po_sent_verified_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('❌ Supabase query failed:', error.message);
    process.exit(1);
  }

  if (!pos || pos.length === 0) {
    console.log('✅ No unreplied POs found.');
    process.exit(0);
  }

  console.log(`📊 Found ${pos.length} unreplied POs (sent, not acknowledged, not noncomm)\n`);

  // Take first 8
  const batch = (pos as PO[]).slice(0, 8);
  console.log(`📋 Batch of ${batch.length} POs:\n`);

  batch.forEach(po => {
    const days = po.po_sent_verified_at
      ? Math.floor((Date.now() - new Date(po.po_sent_verified_at).getTime()) / 86_400_000)
      : '?';
    console.log(`  PO #${po.po_number}  |  vendor: ${po.vendor_name ?? 'N/A'}  |  sent ${days}d ago  |  stage: ${po.lifecycle_stage ?? 'N/A'}`);
  });

  console.log('\n---\n🔎 Searching Gmail threads for vendor info...\n');

  // Step 2: Authenticate Gmail
  const auth = await getAuthenticatedClient('default');
  const gmail = GmailApi({ version: 'v1', auth });

  const results: VendorInfo[] = [];

  for (let i = 0; i < batch.length; i++) {
    const po = batch[i];
    console.log(`[${i + 1}/${batch.length}] PO #${po.po_number}...`);
    const info = await searchPOThread(gmail, po.po_number);
    info.vendorName = po.vendor_name; // carry over from DB
    results.push(info);

    if (info.gmailFound) {
      console.log(`  ✅ Thread: ${info.gmailSubject?.slice(0, 100) ?? 'N/A'}`);
      console.log(`     Vendor email: ${info.vendorEmail ?? 'not found'}`);
      console.log(`     Domains: ${info.domainHints.join(', ') || 'none'}`);
      console.log(`     Date: ${info.gmailDate ?? 'N/A'}`);
      console.log(`     Thread ID: ${info.gmailThreadId}`);
    } else {
      console.log(`  ❌ No Gmail thread found for PO #${po.po_number}`);
    }
    console.log();
  }

  // Summary
  console.log('═══════════════════════════════════════════');
  console.log('📋 VENDOR INFO SUMMARY (First 8 Unreplied POs)');
  console.log('═══════════════════════════════════════════\n');

  const found = results.filter(r => r.gmailFound);
  const notFound = results.filter(r => !r.gmailFound);

  results.forEach(r => {
    const status = r.gmailFound ? '✅' : '❌';
    console.log(`  ${status} PO #${r.poNumber}  |  vendor: ${r.vendorName ?? 'N/A'}`);
    if (r.gmailFound) {
      console.log(`     Email: ${r.vendorEmail ?? 'unknown'}  |  Subject: ${r.gmailSubject?.slice(0, 80) ?? 'N/A'}`);
      console.log(`     Domains: ${r.domainHints.join(', ') || 'none'}`);
    }
    console.log();
  });

  console.log(`📊 Summary: ${found.length} threads found, ${notFound.length} not found out of ${batch.length} POs`);

  process.exit(0);
})().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});