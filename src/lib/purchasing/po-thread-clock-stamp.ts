/**
 * @file    src/lib/purchasing/po-thread-clock-stamp.ts
 * @purpose Stamp sold-out PO threads already in bill.selee@ Gmail.
 *          Search is the subject join plus the stockout words. No new inbox scan.
 * @author  Hermia
 * @created 2026-09-24
 * @deps    gmail auth, po-thread-clock, db
 * @env     Gmail OAuth token for the default slot
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { createClient } from "@/lib/db";
import {
    holdStampRow,
    isOurSender,
    plainThreadText,
    poNumberFromSubject,
    readPoThreadClock,
    type ThreadClockMessage,
} from "@/lib/purchasing/po-thread-clock";

/** Threads whose vendor said they could not fill. 180d covers a stockout that shipped late. */
export const STOCKOUT_THREAD_QUERY =
    '("BuildASoil PO #") ("sold out" OR "out of stock" OR backorder OR "back ordered" OR "back-order") newer_than:180d';

function decodeBody(data: string): string {
    return Buffer.from(data, "base64url").toString("utf8");
}

function walkParts(parts: Array<{ body?: { data?: string }; parts?: unknown[] }> | undefined, out: string[]): void {
    if (!parts) return;
    for (const part of parts) {
        if (part.body?.data) out.push(decodeBody(part.body.data));
        if (part.parts) walkParts(part.parts as Array<{ body?: { data?: string }; parts?: unknown[] }>, out);
    }
}

interface GmailHeader {
    name?: string | null;
    value?: string | null;
}

interface GmailThreadMessage {
    internalDate?: string | null;
    snippet?: string | null;
    payload?: {
        headers?: GmailHeader[] | null;
        body?: { data?: string | null } | null;
        parts?: Array<{ body?: { data?: string }; parts?: unknown[] }> | null;
    } | null;
}

function header(msg: GmailThreadMessage, name: string): string {
    return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
}

/** Map one Gmail thread into clock messages. Exported for the unit of the walker. */
export function messagesFromGmailThread(messages: GmailThreadMessage[]): ThreadClockMessage[] {
    return messages.map((msg) => {
        const parts: string[] = [msg.snippet || ""];
        if (msg.payload?.body?.data) parts.push(decodeBody(msg.payload.body.data));
        walkParts(msg.payload?.parts || undefined, parts);
        const atMs = parseInt(msg.internalDate || "0", 10);
        return {
            at: new Date(Number.isFinite(atMs) ? atMs : 0).toISOString(),
            fromUs: isOurSender(header(msg, "From")),
            text: plainThreadText(parts.join("\n")),
        };
    });
}

export function poNumberFromThread(messages: GmailThreadMessage[]): string | null {
    for (const msg of messages) {
        const po = poNumberFromSubject(header(msg, "Subject"));
        if (po) return po;
    }
    return null;
}

export interface StockoutStampResult {
    checked: number;
    stamped: string[];
    skipped: number;
}

/**
 * Open PO threads Gmail already has that contain a stockout phrase, and
 * write the hold onto purchase_orders. Silent threads are not touched.
 *
 * @param maxThreads Cap on distinct threads fetched this pass.
 */
export async function stampStockoutThreads(maxThreads = 200): Promise<StockoutStampResult> {
    const auth = await getAuthenticatedClient("default");
    const gmail = GmailApi({ version: "v1", auth });
    const db = createClient();
    const result: StockoutStampResult = { checked: 0, stamped: [], skipped: 0 };
    if (!db) return result;

    const threadIds: string[] = [];
    let pageToken: string | undefined;
    while (threadIds.length < maxThreads) {
        const { data: search } = await gmail.users.messages.list({
            userId: "me",
            q: STOCKOUT_THREAD_QUERY,
            maxResults: Math.min(100, maxThreads - threadIds.length),
            pageToken,
        });
        for (const message of search.messages || []) {
            if (message.threadId && !threadIds.includes(message.threadId)) threadIds.push(message.threadId);
        }
        pageToken = search.nextPageToken || undefined;
        if (!pageToken || !(search.messages || []).length) break;
    }
    result.checked = threadIds.length;

    for (const threadId of threadIds) {
        const { data: thread } = await gmail.users.threads.get({
            userId: "me",
            id: threadId,
            format: "full",
        });
        const messages = (thread.messages || []) as GmailThreadMessage[];
        const poNumber = poNumberFromThread(messages);
        if (!poNumber) {
            result.skipped += 1;
            continue;
        }
        const clock = readPoThreadClock(messagesFromGmailThread(messages));
        const row = holdStampRow(poNumber, clock);
        if (!row) {
            result.skipped += 1;
            continue;
        }
        const { error } = await db.from("purchase_orders").upsert(row, { onConflict: "po_number" });
        if (error) {
            console.warn(`[thread-clock] ${poNumber} stamp failed: ${error.message}`);
            result.skipped += 1;
            continue;
        }
        result.stamped.push(poNumber);
        console.log(`[thread-clock] PO ${poNumber} hold ${clock.holdStartedAt} fulfill ${clock.fulfillLeadDays ?? "?"}d`);
    }
    return result;
}
