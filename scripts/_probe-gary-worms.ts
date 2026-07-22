/**
 * @file    _probe-gary-worms.ts
 * @purpose One-off Gmail probe for Down to Earth Worms / Gary Ambriole invoices
 * @usage   node --import tsx --env-file=.env.local scripts/_probe-gary-worms.ts
 */
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../src/lib/gmail/auth";

async function search(slot: string, q: string) {
    const auth = await getAuthenticatedClient(slot);
    const gmail = GmailApi({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    console.log(`\n==== ${slot} as ${profile.data.emailAddress} | q=${q}`);
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 30 });
    const msgs = list.data.messages || [];
    console.log(`hits=${msgs.length}`);
    for (const m of msgs.slice(0, 20)) {
        const full = await gmail.users.messages.get({
            userId: "me",
            id: m.id!,
            format: "full",
        });
        const headers = full.data.payload?.headers || [];
        const get = (n: string) =>
            headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || "";
        const atts: Array<Record<string, unknown>> = [];
        const walk = (parts: any[] | undefined) => {
            if (!parts) return;
            for (const p of parts) {
                if (p.filename) {
                    atts.push({
                        filename: p.filename,
                        mime: p.mimeType,
                        size: p.body?.size || 0,
                        hasAtt: !!p.body?.attachmentId,
                    });
                }
                if (p.parts) walk(p.parts);
            }
        };
        walk(full.data.payload?.parts);
        if (full.data.payload?.filename) {
            atts.push({
                filename: full.data.payload.filename,
                mime: full.data.payload.mimeType,
                size: full.data.payload.body?.size || 0,
            });
        }
        const images: Array<Record<string, unknown>> = [];
        const walkImg = (part: any) => {
            if (!part) return;
            const mime = part.mimeType || "";
            if (mime.startsWith("image/") && (part.body?.attachmentId || part.body?.data)) {
                images.push({
                    mime,
                    size: part.body?.size || 0,
                    filename: part.filename || "(inline)",
                    hasAtt: !!part.body?.attachmentId,
                });
            }
            if (part.parts) for (const c of part.parts) walkImg(c);
        };
        walkImg(full.data.payload);
        console.log(
            JSON.stringify({
                id: m.id,
                date: get("Date"),
                from: get("From"),
                subject: get("Subject"),
                labels: full.data.labelIds,
                atts,
                images,
                snippet: (full.data.snippet || "").slice(0, 160),
            }),
        );
    }
}

const queries = [
    "from:garyambriole@icloud.com",
    "from:deeremother@hotmail.com",
    "from:ambriole OR from:deeremother OR \"down to earth worms\" OR \"down to earth worm\"",
    "(\"Down to Earth\" OR Ambriole OR \"earth worms\") has:attachment newer_than:365d",
    "in:sent to:buildasoilap@bill.com (Ambriole OR worms OR gary OR \"down to earth\") newer_than:365d",
];

async function main() {
    for (const slot of ["ap", "default"] as const) {
        for (const q of queries) {
            try {
                await search(slot, q);
            } catch (e: any) {
                console.error("ERR", slot, q, e.message);
            }
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
