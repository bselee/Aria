/**
 * @file    _probe-billcom-images.ts
 * @purpose Inspect rare image-named forwards to Bill.com (are any Gary?)
 */
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../src/lib/gmail/auth";

async function main() {
    const auth = await getAuthenticatedClient("ap");
    const gmail = GmailApi({ version: "v1", auth });
    for (const q of [
        "in:sent to:buildasoilap@bill.com filename:jpg newer_than:365d",
        "in:sent to:buildasoilap@bill.com filename:jpeg newer_than:365d",
        "in:sent to:buildasoilap@bill.com filename:png newer_than:365d",
    ]) {
        console.log("\n===", q);
        const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 10 });
        for (const m of list.data.messages || []) {
            const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
            const headers = full.data.payload?.headers || [];
            const get = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || "";
            const atts: string[] = [];
            const walk = (parts: any[] | undefined) => {
                if (!parts) return;
                for (const p of parts) {
                    if (p.filename) atts.push(`${p.filename}|${p.mimeType}`);
                    if (p.parts) walk(p.parts);
                }
            };
            walk(full.data.payload?.parts);
            console.log(
                JSON.stringify({
                    id: m.id,
                    date: get("Date"),
                    subject: get("Subject"),
                    snippet: (full.data.snippet || "").slice(0, 180),
                    atts,
                }),
            );
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
