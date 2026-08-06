/**
 * @file    gmail-sent-reader.ts
 * @purpose SCAFFOLD — read Gmail Sent Mail for threads Aria drafted into, and
 *          extract Bill's final language as gold training samples. When Bill
 *          edits a draft and sends it, that final text is the ground-truth
 *          voice sample the feedback loop should capture.
 *
 *          No cron wiring yet — this module only exposes the query primitive
 *          and is fully mockable (the `gmail` client is injected, never
 *          constructed here). Wire-up lives in a later workstream.
 *
 * @author  Hermia
 * @created 2026-08-06
 * @deps    none (gmail client injected by caller)
 */

export interface SentReplyResult {
    messageId: string;
    threadId: string;
    body: string;
}

function decodeBody(data: string | null | undefined): string {
    if (!data) return "";
    try {
        return Buffer.from(data, "base64url").toString("utf-8");
    } catch {
        return "";
    }
}

/**
 * Walk a Gmail message payload and collect text/plain parts (plus any inline
 * body data) into a single plain-text string. Mirrors the extraction used by
 * the AP/tracking agents so sent-reply bodies are comparable to drafts.
 */
export function extractMessageText(payload: any): string {
    if (!payload) return "";
    let text = "";
    const walk = (part: any) => {
        if (!part) return;
        if (part.mimeType === "text/plain" && part.body?.data) {
            text += decodeBody(part.body.data) + "\n";
        }
        if (part.parts?.length) {
            for (const sub of part.parts) walk(sub);
        }
    };
    if (payload.body?.data) text += decodeBody(payload.body.data) + "\n";
    if (payload.parts?.length) {
        for (const part of payload.parts) walk(part);
    }
    return text.trim();
}

/**
 * Find the latest message Bill (myEmail) sent into the given thread and return
 * its body. Queries the Sent folder via `from:<myEmail> in:sent` (results come
 * back newest-first), filters to the target thread, then fetches the full
 * message payload for the newest match.
 *
 * @param gmail    Google Gmail API client (injected — no auth here)
 * @param threadId Gmail thread id to scope the search to
 * @param myEmail  Bill's address; used as the `from:` query term
 * @returns the latest sent reply body, or null if Bill never sent into this thread
 */
export async function findSentRepliesInThread(
    gmail: any,
    threadId: string,
    myEmail: string,
): Promise<SentReplyResult | null> {
    const res = await gmail.users.messages.list({
        userId: "me",
        q: `from:${myEmail} in:sent`,
        maxResults: 100,
    });
    const messages: Array<{ id: string; threadId: string }> = res?.data?.messages ?? [];
    const inThread = messages.filter((m) => m.threadId === threadId);
    if (inThread.length === 0) return null;

    // Gmail list order is newest-first, so the first match is the latest send.
    const latest = inThread[0];
    const full = await gmail.users.messages.get({
        userId: "me",
        id: latest.id,
        format: "full",
    });

    return {
        messageId: latest.id,
        threadId,
        body: extractMessageText(full?.data?.payload),
    };
}
