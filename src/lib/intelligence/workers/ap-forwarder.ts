import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../../gmail/auth";
import { createClient } from "../../supabase";

/**
 * @file ap-forwarder.ts
 * @purpose Agent 2 of the decoupled AP pipeline (The "Hands").
 *          Polls ap_inbox_queue for PENDING_FORWARD items, downloads the
 *          associated PDF from Storage, constructs a MIME message, and sends
 *          it to buildasoilap@bill.com. Updates status to FORWARDED on success.
 *
 *          Pipeline flow:
 *            AP Identifier → ap_inbox_queue (PENDING_FORWARD)
 *              → AP Forwarder (PROCESSING_FORWARD → FORWARDED / ERROR_FORWARDING)
 *
 *          Status lifecycle:
 *            PENDING_FORWARD → PROCESSING_FORWARD → FORWARDED
 *                                                 → ERROR_FORWARDING (on failure)
 *
 * @author Antigravity / Aria
 * @updated 2026-03-19 — Changed success status from PROCESSED to FORWARDED for
 *          clearer pipeline semantics.
 */
export class APForwarderAgent {
    private async logActivity(supabase: any, from: string, subject: string, intent: string, action: string, metadata: any = {}) {
        if (!supabase) return;
        try {
            await supabase.from("ap_activity_log").insert({
                email_from: from,
                email_subject: subject,
                intent,
                action_taken: action,
                metadata
            });
        } catch (e: any) {
            console.error("   ❌ Failed to log activity:", e.message);
        }
    }

    async processPendingForwards() {
        console.log("📤 [AP-Forwarder] Scanning queue for invoices to forward to Bill.com...");
        try {
            const supabase = createClient();
            if (!supabase) {
                console.error("   ❌ Supabase client not available.");
                return;
            }

            const { data: queueItems, error } = await supabase
                .from('ap_inbox_queue')
                .select('*')
                .eq('status', 'PENDING_FORWARD')
                .limit(10);

            if (error) throw error;

            if (!queueItems || queueItems.length === 0) {
                return;
            }

            console.log(`   Found ${queueItems.length} invoice(s) pending forward.`);

            let auth;
            try {
                auth = await getAuthenticatedClient("ap");
            } catch (err: any) {
                console.warn("   ⚠️ Missing 'ap' token, falling back to 'default'...");
                auth = await getAuthenticatedClient("default");
            }
            const gmail = GmailApi({ version: "v1", auth });

            for (const item of queueItems) {
                try {
                    // Try to lock the row by updating status to PROCESSING_FORWARD
                    const { error: lockError } = await supabase
                        .from('ap_inbox_queue')
                        .update({ status: 'PROCESSING_FORWARD' })
                        .eq('id', item.id)
                        .eq('status', 'PENDING_FORWARD');

                    if (lockError) {
                        console.error(`   ❌ Failed to lock item ${item.id}:`, lockError.message);
                        continue;
                    }

                    console.log(`   -> Forwarding ${item.pdf_filename} from ${item.email_from}`);

                    // Download PDF from Supabase Storage
                    const { data: fileData, error: downloadError } = await supabase.storage
                        .from('ap_invoices')
                        .download(item.pdf_path);

                    if (downloadError || !fileData) {
                        throw new Error(`Failed to download PDF from storage: ${downloadError?.message}`);
                    }

                    const buffer = Buffer.from(await fileData.arrayBuffer());
                    const rawBase64 = buffer.toString('base64');
                    // RFC 2045 requires base64 to be split into lines no longer than 76 characters.
                    const chunkedBase64 = rawBase64.match(/.{1,76}/g)?.join("\r\n") || rawBase64;

                    const boundary = "b_aria_fwd_" + Math.random().toString(36).substring(2);

                    const mimeMessage = [
                        `To: buildasoilap@bill.com`,
                        `Subject: Fwd: ${item.email_subject}`,
                        `MIME-Version: 1.0`,
                        `Content-Type: multipart/mixed; boundary="${boundary}"`,
                        ``,
                        `--${boundary}`,
                        `Content-Type: text/plain; charset="UTF-8"`,
                        ``,
                        `Forwarded invoice.`,
                        ``,
                        `--${boundary}`,
                        `Content-Type: application/pdf; name="${item.pdf_filename}"`,
                        `Content-Transfer-Encoding: base64`,
                        `Content-Disposition: attachment; filename="${item.pdf_filename}"`,
                        ``,
                        chunkedBase64,
                        `--${boundary}--`
                    ].join("\r\n");

                    await gmail.users.messages.send({
                        userId: "me",
                        requestBody: { raw: Buffer.from(mimeMessage).toString("base64url") }
                    });

                    // Update status to FORWARDED (sent to Bill.com)
                    await supabase
                        .from('ap_inbox_queue')
                        .update({ status: 'FORWARDED' })
                        .eq('id', item.id);

                    await this.logActivity(
                        supabase,
                        item.email_from,
                        item.email_subject,
                        item.intent || 'INVOICE',
                        `Forwarded to Bill.com: ${item.pdf_filename}`
                    );

                    console.log(`   ✅ Successfully forwarded ${item.pdf_filename}`);

                } catch (err: any) {
                    console.error(`   ❌ Forwarding failed for ${item.id}:`, err.message);
                    await supabase
                        .from('ap_inbox_queue')
                        .update({ status: 'ERROR_FORWARDING' })
                        .eq('id', item.id);
                    await this.logActivity(
                        supabase,
                        item.email_from,
                        item.email_subject,
                        item.intent || 'INVOICE',
                        `Error forwarding to Bill.com: ${err.message}`
                    );
                }
            }
        } catch (err: any) {
            console.error("❌ [AP-Forwarder] Critical Error:", err.message);
        }
    }
}
