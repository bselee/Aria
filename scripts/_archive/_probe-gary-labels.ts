/**
 * @file    _probe-gary-labels.ts
 * @purpose Label status + Bill.com sent search for Gary Ambriole invoices
 */
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../src/lib/gmail/auth";

async function main() {
    const auth = await getAuthenticatedClient("ap");
    const gmail = GmailApi({ version: "v1", auth });

    const labs = await gmail.users.labels.list({ userId: "me" });
    const map = Object.fromEntries((labs.data.labels || []).map((l) => [l.id!, l.name!]));

    const ids = [
        "19f47da4f04c8f9d",
        "19f1f6443da7380e",
        "19ef03e2a64a60a8",
        "19ead1571b5c1b91",
        "19e81083b23391e0",
        "19df331149d76cc2",
        "19dac1259be75a79",
        "19d4589655559795",
    ];
    console.log("=== ap@ label status ===");
    for (const id of ids) {
        const full = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
        });
        const labels = (full.data.labelIds || []).map((lid) => map[lid] || lid);
        const headers = full.data.payload?.headers || [];
        const get = (n: string) => headers.find((h) => h.name === n)?.value || "";
        console.log({
            id,
            date: get("Date"),
            subject: get("Subject"),
            labels,
            unread: labels.includes("UNREAD"),
            inbox: labels.includes("INBOX"),
        });
    }

    console.log("\n=== sent to bill.com image-like ===");
    const queries = [
        "in:sent to:buildasoilap@bill.com filename:jpg newer_than:365d",
        "in:sent to:buildasoilap@bill.com filename:jpeg newer_than:365d",
        "in:sent to:buildasoilap@bill.com filename:png newer_than:365d",
        "in:sent to:buildasoilap@bill.com filename:IMG_ newer_than:365d",
        'in:sent to:buildasoilap@bill.com Ambriole newer_than:730d',
        'in:sent to:buildasoilap@bill.com "Down to Earth" newer_than:730d',
        "in:sent to:buildasoilap@bill.com worms newer_than:730d",
        "in:sent to:buildasoilap@bill.com garyambriole newer_than:730d",
    ];
    for (const q of queries) {
        const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 5 });
        console.log(q, "hits=", (list.data.messages || []).length);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
