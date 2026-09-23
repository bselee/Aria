/**
 * @file    inbox-screen.ts
 * @purpose Drain bill.selee@ : ingest unread mail, classify, archive ads.
 *          This is the screen that used to run only inside ap-polling at
 *          8/12/17. It does not touch Finale, Bill.com, or ap@.
 *
 *          The morning pass must clear everything that landed before 8am.
 *          One 20-row ACK batch is not enough, so this loops until the
 *          default queue has no unprocessed rows or the pass cap is hit.
 * @author  Hermia
 * @created 2026-09-23
 * @deps    email-ingestion, acknowledgement-agent, @/lib/db
 */
import { createClient } from "@/lib/db";
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { isObviousPromotionalEmail } from "./promotional-email";
import { EmailIngestionWorker } from "./workers/email-ingestion";
import { AcknowledgementAgent } from "./acknowledgement-agent";

export interface InboxScreenResult {
    passes: number;
    unprocessedLeft: number;
    archivedNoise: number;
}

const NOISE_SUBJECT = /^(out of stock|daily agenda|oos report|reorder summary)\b/i;
const KEEP_SUBJECT = /(?:\bpo\s*#|\bpurchase order\b|\binvoice\b|\btracking\b)/i;

function header(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string {
    return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

/**
 * Archive ads and system digests that are still in INBOX even if already read.
 * The unread-only ingest misses them once Gmail or a prior pass clears UNREAD.
 * PO, invoice, and tracking subjects are never archived here.
 *
 * @returns How many messages were removed from INBOX.
 */
async function archiveInboxNoise(): Promise<number> {
    const auth = await getAuthenticatedClient("default");
    const gmail = GmailApi({ version: "v1", auth });
    const list = await gmail.users.messages.list({
        userId: "me",
        q: "in:inbox newer_than:2d",
        maxResults: 40,
    });
    let archived = 0;
    for (const m of list.data.messages || []) {
        if (!m.id) continue;
        const msg = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "metadata",
            metadataHeaders: ["From", "Subject"],
        });
        const from = header(msg.data.payload?.headers, "From");
        const subject = header(msg.data.payload?.headers, "Subject");
        if (KEEP_SUBJECT.test(subject)) continue;
        const promo = isObviousPromotionalEmail({ from, subject });
        const noise = NOISE_SUBJECT.test(subject);
        if (!promo && !noise) continue;
        await gmail.users.messages.modify({
            userId: "me",
            id: m.id,
            requestBody: { removeLabelIds: ["INBOX", "UNREAD"] },
        });
        archived++;
    }
    return archived;
}

async function unprocessedLeft(): Promise<number> {
    const db = createClient();
    if (!db) return 0;
    const { data, error } = await db
        .from("email_inbox_queue")
        .select("id")
        .eq("source_inbox", "default")
        .eq("processed_by_ack", false)
        .in("status", ["unprocessed", "processing"])
        .limit(200);
    if (error) return 0;
    return (data || []).length;
}

/**
 * Ingest and classify bill.selee@ until the unprocessed queue is empty.
 *
 * @param maxPasses  Safety cap so a stuck row cannot loop forever. Default 8.
 * @returns          How many passes ran and how many unprocessed rows remain.
 */
export async function screenDefaultInbox(maxPasses = 8): Promise<InboxScreenResult> {
    const ingest = new EmailIngestionWorker("default");
    const ack = new AcknowledgementAgent("default");
    let passes = 0;
    let left = await unprocessedLeft();

    for (let i = 0; i < maxPasses; i++) {
        passes++;
        await ingest.run(100);
        await ack.processUnreadEmails(100);
        const next = await unprocessedLeft();
        left = next;
        if (next === 0) break;
    }

    const archivedNoise = await archiveInboxNoise();
    console.log(`[inbox-screen] passes=${passes} unprocessedLeft=${left} archivedNoise=${archivedNoise}`);
    return { passes, unprocessedLeft: left, archivedNoise };
}
