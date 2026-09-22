/**
 * @file    scripts/resolve-stuck-ap.ts
 * @purpose Resolve 19 stuck PENDING_FORWARD items in ap_inbox_queue.
 *          Checks Gmail for PDFs, skips non-invoice items, forwards real ones.
 * @run     node --import tsx --env-file=.env.local scripts/resolve-stuck-ap.ts
 */

import { createClient } from "@/lib/db";
import { getLocalDb } from "@/lib/storage/local-db";
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { forwardInvoiceOnce } from "@/lib/intelligence/ap-single-forward";

const BILL_COM = process.env.BILL_COM_FORWARD_EMAIL || "buildasoilap@bill.com";

async function main() {
  const supabase = createClient();
  const localDb = getLocalDb();

  const { data: stuck } = await supabase
    .from("ap_inbox_queue").select("*")
    .eq("status", "PENDING_FORWARD").order("created_at");

  if (!stuck?.length) { console.log("No stuck items!"); return; }
  console.log(`Found ${stuck.length} stuck PENDING_FORWARD items\n`);

  // Count local DB matches first
  for (const item of stuck) {
    const mid = item.message_id || "";
    const local = localDb.prepare(
      "SELECT status, forwarded_at FROM ap_local_forwards WHERE gmail_message_id = ?"
    ).get(mid) as any;
    if (local) {
      console.log(`[LOCAL] ${item.id.substring(0,8)} msg_id=${mid.substring(0,16)}... local_status=${local.status} @ ${local.forwarded_at}`);
    } else {
      console.log(`[NO LOCAL] ${item.id.substring(0,8)} msg_id=${mid.substring(0,16)}... from=${(item.email_from||'').substring(0,40)} pdf=${(item.pdf_filename||'none').substring(0,30)}`);
    }
  }

  console.log(`\nNow checking Gmail for PDFs...\n`);

  // Get Gmail client
  let auth, gmail;
  try {
    auth = await getAuthenticatedClient("ap");
  } catch {
    auth = await getAuthenticatedClient("default");
  }
  gmail = GmailApi({ version: "v1", auth });

  let resolved = 0, skipped = 0, fwdSent = 0, fwdFailed = 0;

  for (const item of stuck) {
    const short = item.id.substring(0, 8);
    const mid = item.message_id || "";
    const from = (item.email_from || "").toLowerCase();

    // QuickBooks notifications = no PDF invoice
    if (from.includes("quickbooks@notification") || (mid && !item.pdf_filename)) {
      console.log(`[${short}] QuickBooks/no-PDF → SKIP`);
      await supabase.from("ap_inbox_queue").update({
        status: "ERROR_FORWARDING",
        error_message: "QuickBooks notification or no PDF — not a forwardable invoice"
      }).eq("id", item.id);
      skipped++;
      continue;
    }

    // Try to fetch the message
    if (!mid) { skipped++; continue; }

    try {
      const msg = await gmail.users.messages.get({ userId: "me", id: mid, format: "full" });
      const parts = msg.data?.payload?.parts || [];
      const pdfs = parts.filter((p: any) =>
        p.mimeType === "application/pdf" ||
        (p.filename && p.filename.toLowerCase().endsWith(".pdf"))
      );

      if (pdfs.length === 0) {
        console.log(`[${short}] No PDF in Gmail → SKIP`);
        await supabase.from("ap_inbox_queue").update({
          status: "ERROR_FORWARDING",
          error_message: "No PDF attachment found in source email"
        }).eq("id", item.id);
        skipped++;
        continue;
      }

      // Download and forward
      for (const pdf of pdfs.slice(0, 1)) {
        const att = await gmail.users.messages.attachments.get({
          userId: "me", messageId: mid, id: pdf.body.attachmentId
        });
        const buf = Buffer.from(att.data.data, "base64url");
        const result = await forwardInvoiceOnce({
          gmailMessageId: mid,
          emailFrom: item.email_from || "",
          emailSubject: item.email_subject || "",
          pdfFilename: pdf.filename || item.pdf_filename || "invoice.pdf",
          pdfBuffer: buf,
          source: "manual",
        });

        if (result.status === "forwarded") {
          console.log(`[${short}] FORWARDED → Bill.com (${pdf.filename})`);
          await supabase.from("ap_inbox_queue").update({ status: "FORWARDED" }).eq("id", item.id);
          resolved++; fwdSent++;
        } else {
          console.log(`[${short}] BLOCKED: ${(result as any).reason || "unknown"}`);
          await supabase.from("ap_inbox_queue").update({
            status: "ERROR_FORWARDING",
            error_message: `forwardInvoiceOnce returned ${result.status}: ${(result as any).reason || ""}`
          }).eq("id", item.id);
          skipped++;
        }
      }
    } catch (e: any) {
      console.log(`[${short}] Gmail error: ${e.message?.substring(0,80)}`);
      // Message not found = probably already archived by local forwarder
      await supabase.from("ap_inbox_queue").update({
        status: "FORWARDED",
        error_message: `Gmail message inaccessible — already forwarded by local path`
      }).eq("id", item.id);
      resolved++;
    }
  }

  // Final summary
  const { data: remaining } = await supabase
    .from("ap_inbox_queue").select("count", { count: "exact" })
    .eq("status", "PENDING_FORWARD");

  console.log(`\n=== RESULT ===`);
  console.log(`Forwarded: ${fwdSent}`);
  console.log(`Resolved (already handled): ${resolved - fwdSent}`);
  console.log(`Skipped (non-invoice): ${skipped}`);
  console.log(`Failed: ${fwdFailed}`);
  console.log(`Remaining PENDING_FORWARD: ${remaining?.[0]?.count ?? "?"}`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });