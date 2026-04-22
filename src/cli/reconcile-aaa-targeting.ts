const AAA_SENDER_PATTERN = /aaa\s*cooper/i;
const AAA_QUERY = "from:aaacooper.com after:2026/01/01";

export interface StatementAttachment {
    attachmentId: string;
    filename: string;
    pdfBuffer: Buffer;
}

export interface StatementEmail {
    messageId: string;
    subject: string;
    from: string;
    date: string;
    attachments: StatementAttachment[];
    labelIds: string[];
}

export interface ReconcileAAAArgs {
    dryRun: boolean;
    scrapeOnly: boolean;
    limit: number;
    messageId?: string;
    inboxOnly: boolean;
}

export interface GmailLike {
    users: {
        messages: {
            list: (params: { userId: string; q: string; maxResults: number }) => Promise<{ data: { messages?: Array<{ id?: string }> } }>;
            get: (params: { userId: string; id: string; format: "full" }) => Promise<{ data: any }>;
            attachments: {
                get: (params: { userId: string; messageId: string; id: string }) => Promise<{ data: { data?: string } }>;
            };
        };
    };
}

export function parseReconcileAAAArgs(args: string[]): ReconcileAAAArgs {
    return {
        dryRun: args.includes("--dry-run"),
        scrapeOnly: args.includes("--scrape-only"),
        limit: (() => {
            const idx = args.indexOf("--limit");
            return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 5;
        })(),
        messageId: (() => {
            const idx = args.indexOf("--message-id");
            return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
        })(),
        inboxOnly: args.includes("--inbox-only"),
    };
}

export async function fetchAAACooperStatements(
    gmail: GmailLike,
    options: { messageId?: string; inboxOnly?: boolean },
): Promise<StatementEmail[]> {
    if (options.messageId) {
        const statement = await fetchSingleStatement(gmail, options.messageId, options.inboxOnly ?? false);
        return statement ? [statement] : [];
    }

    const query = options.inboxOnly ? `in:inbox ${AAA_QUERY}` : AAA_QUERY;
    const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 20,
    });

    const msgs = res.data.messages || [];
    const statements: StatementEmail[] = [];

    for (const msgRef of msgs) {
        if (!msgRef.id) continue;
        const statement = await fetchSingleStatement(gmail, msgRef.id, options.inboxOnly ?? false);
        if (statement) statements.push(statement);
    }

    return statements;
}

async function fetchSingleStatement(
    gmail: GmailLike,
    messageId: string,
    inboxOnly: boolean,
): Promise<StatementEmail | null> {
    const msg = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
    });

    const labelIds = msg.data.labelIds || [];
    if (inboxOnly && !labelIds.includes("INBOX")) {
        return null;
    }

    const headers = msg.data.payload?.headers || [];
    const subject = headers.find((h: any) => h.name === "Subject")?.value || "";
    const from = headers.find((h: any) => h.name === "From")?.value || "";
    const date = headers.find((h: any) => h.name === "Date")?.value || "";

    if (!subject || !AAA_SENDER_PATTERN.test(from)) {
        return null;
    }

    const attachmentRefs: Array<{ attachmentId: string; filename: string }> = [];
    const walk = (parts: any[]) => {
        for (const part of parts || []) {
            if (part.filename?.toLowerCase().endsWith(".pdf") && part.body?.attachmentId) {
                attachmentRefs.push({
                    attachmentId: part.body.attachmentId,
                    filename: part.filename || "statement.pdf",
                });
            }
            if (part.parts) walk(part.parts);
        }
    };
    walk(msg.data.payload?.parts || []);

    if (attachmentRefs.length === 0) {
        return null;
    }

    const attachments: StatementAttachment[] = [];
    for (const attachment of attachmentRefs) {
        try {
            const attachRes = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId,
                id: attachment.attachmentId,
            });
            const data = attachRes.data.data;
            if (!data) continue;

            attachments.push({
                ...attachment,
                pdfBuffer: Buffer.from(data, "base64url"),
            });
        } catch (err: any) {
            console.warn(`   Failed to download ${attachment.filename}: ${err.message}`);
        }
    }

    if (attachments.length === 0) {
        return null;
    }

    return {
        messageId,
        subject,
        from,
        date,
        attachments,
        labelIds,
    };
}
