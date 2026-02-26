import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { google } from "googleapis";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { unifiedObjectGeneration } from "../lib/intelligence/llm";
import { z } from "zod";

async function classifyEmailIntent(subject: string, from: string, snippet: string): Promise<string> {
    const schema = z.object({
        intent: z.enum(["INVOICE", "STATEMENT", "ADVERTISEMENT", "HUMAN_INTERACTION"]),
        reasoning: z.string()
    });

    const prompt = `Classify this incoming email from our Accounts Payable inbox.
From: ${from}
Subject: ${subject}
Snippet: ${snippet}

CATEGORIES:
INVOICE - Vendor submitting a bill or invoice requiring payment.
STATEMENT - Vendor sending an account statement, aging summary, or reconciliation.
ADVERTISEMENT - Marketing, promotional spam, newsletters, or sales pitches.
HUMAN_INTERACTION - Payment questions, order issues, or generic emails that a human must read and reply to.

Classify carefully based on the sender, subject and text snippet.`;

    try {
        const res = await unifiedObjectGeneration({
            system: "You are an AP Routing Engine sorting a corporate inbox.",
            prompt,
            schema,
            schemaName: "EmailIntent"
        }) as { intent: string, reasoning: string };

        console.log(`   [LLM Reasoning]: ${res.reasoning}`);
        return res.intent;
    } catch (err) {
        return "HUMAN_INTERACTION";
    }
}

async function run() {
    // If user provided a specific search string, use it. Otherwise default to a few unread messages.
    const query = process.argv.slice(2).join(" ") || "is:unread";
    console.log(`🔍 Testing Routing via bill.selee@... Search: "${query}"`);

    // Auth as bill
    const auth = await getAuthenticatedClient("default");
    const gmail = google.gmail({ version: "v1", auth });

    const { data } = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 5
    });

    const messages = data.messages || [];
    if (messages.length === 0) {
        console.log("No messages found matching query.");
        return;
    }

    console.log(`Found ${messages.length} email(s) for testing...\n`);

    for (const m of messages) {
        const msg = await gmail.users.messages.get({ userId: "me", id: m.id! });
        const payload = msg.data.payload;
        const headers = payload?.headers || [];

        const subject = headers.find((h: any) => h.name === "Subject")?.value || "No Subject";
        const from = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
        const snippet = msg.data.snippet || "";

        console.log(`==========================================`);
        console.log(`✉️  Email: "${subject}"`);
        console.log(`   From: ${from}`);
        console.log(`   Snippet: "${snippet.substring(0, 80)}..."`);

        const intent = await classifyEmailIntent(subject, from, snippet);
        console.log(`🤖 Classified Intent: => **${intent}**`);

        // Output dry-run simulated actions
        if (intent === "ADVERTISEMENT") {
            console.log(`   [DRY RUN]: Would Archive and Mark Read`);
        } else if (intent === "STATEMENT") {
            console.log(`   [DRY RUN]: Would add label "Statements" and Mark Read`);
        } else if (intent === "HUMAN_INTERACTION") {
            console.log(`   [DRY RUN]: Would DO NOTHING (Leave unread in inbox for human review)`);
        } else if (intent === "INVOICE") {
            const parts = payload?.parts || [];

            // Note: In some multipart messages parts are nested. Let's do a simple recursive finder for attachments for the test script.
            const attachs: any[] = [];
            const findPdfs = (pts: any[]) => {
                for (const p of pts) {
                    if (p.mimeType === "application/pdf" && p.filename) {
                        attachs.push(p);
                    }
                    if (p.parts) {
                        findPdfs(p.parts);
                    }
                }
            };
            findPdfs(parts);

            if (attachs.length > 0) {
                console.log(`   [DRY RUN]: Found PDF attachment(s): ${attachs.map((p: any) => p.filename).join(", ")}`);
                console.log(`   [DRY RUN]: Would parse PDF, match to DB, and forward explicitly to buildasoilap@bill.com`);
                console.log(`   [DRY RUN]: Would add label "Invoice Forward" and Mark Read`);
            } else {
                console.log(`   [DRY RUN]: No PDF found. Would fallback to HUMAN_INTERACTION.`);
            }
        }
        console.log(`==========================================\n`);
    }
}

run().catch(console.error);
