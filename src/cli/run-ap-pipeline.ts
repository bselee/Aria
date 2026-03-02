/**
 * @file    run-ap-pipeline.ts
 * @purpose Manually trigger the full AP invoice pipeline on a real invoice
 *          found in Gmail. Mirrors processInvoiceBuffer() in ap-agent.ts.
 *          Used to run the AutoPot APUS-243331 invoice through the pipeline.
 * @usage   node --import tsx src/cli/run-ap-pipeline.ts
 */

import { google } from "googleapis";
import { Telegraf } from "telegraf";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { createClient } from "../lib/supabase";
import { extractPDF } from "../lib/pdf/extractor";
import { parseInvoice, InvoiceData } from "../lib/pdf/invoice-parser";
import { matchInvoiceToPO, MatchResult } from "../lib/matching/invoice-po-matcher";
import { FinaleClient } from "../lib/finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    storePendingApproval,
    ReconciliationResult,
    TrackingUpdate,
} from "../lib/finale/reconciler";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// ─── Telegram helper ────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

async function tg(msg: string) {
    try {
        await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
    } catch (err: any) {
        console.warn("   ⚠️ Telegram send failed:", err.message);
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log("═══════════════════════════════════════════════");
    console.log("  AP Pipeline — Manual Run");
    console.log("═══════════════════════════════════════════════\n");

    // ── Step 1: Gmail — find & download invoice PDF ───────────────────────────
    console.log("1️⃣  Connecting to Gmail...");
    let gmail: any;
    try {
        try {
            const auth = await getAuthenticatedClient("ap");
            gmail = google.gmail({ version: "v1", auth });
            const p = await gmail.users.getProfile({ userId: "me" });
            console.log(`   ✅ Connected as: ${p.data.emailAddress} (ap token)`);
        } catch {
            const auth = await getAuthenticatedClient("default");
            gmail = google.gmail({ version: "v1", auth });
            const p = await gmail.users.getProfile({ userId: "me" });
            console.log(`   ✅ Connected as: ${p.data.emailAddress} (default token)`);
        }
    } catch (err: any) {
        console.error("   ❌ Gmail auth failed:", err.message);
        process.exit(1);
    }

    console.log("\n2️⃣  Searching for AutoPot invoice...");
    let pdfBuffer: Buffer | null = null;
    let pdfBase64Raw = "";  // kept for bill.com forwarding
    let subject = "";
    let from = "";
    let filename = "";

    try {
        // Try AutoPot specifically first; fall back to any recent invoice PDF
        const queries = [
            "AutoPot invoice has:attachment filename:pdf newer_than:90d",
            "has:attachment filename:pdf (invoice OR inv OR bill) newer_than:30d",
        ];

        for (const q of queries) {
            const { data: search } = await gmail.users.messages.list({
                userId: "me",
                q,
                maxResults: 10,
            });

            if (!search.messages?.length) continue;

            for (const m of search.messages) {
                const { data: msg } = await gmail.users.messages.get({
                    userId: "me",
                    id: m.id!,
                });

                subject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "No Subject";
                from = msg.payload?.headers?.find((h: any) => h.name === "From")?.value || "Unknown";

                // Walk all MIME parts to find PDFs
                const pdfParts: any[] = [];
                function walkParts(parts: any[]): void {
                    for (const part of parts) {
                        if (part.mimeType === "application/pdf" && part.filename) pdfParts.push(part);
                        if (part.parts?.length) walkParts(part.parts);
                    }
                }
                walkParts(msg.payload?.parts || []);
                if (!pdfParts.length) continue;

                const part = pdfParts[0];
                filename = part.filename;
                console.log(`   ✅ Found: "${subject}"`);
                console.log(`      From: ${from}`);
                console.log(`      File: ${filename}`);

                // Download
                let base64 = "";
                if (part.body?.attachmentId) {
                    const att = await gmail.users.messages.attachments.get({
                        userId: "me",
                        messageId: m.id!,
                        id: part.body.attachmentId,
                    });
                    base64 = (att.data.data || "").replace(/-/g, "+").replace(/_/g, "/");
                } else if (part.body?.data) {
                    base64 = part.body.data.replace(/-/g, "+").replace(/_/g, "/");
                }

                if (base64) {
                    pdfBase64Raw = base64;
                    pdfBuffer = Buffer.from(base64, "base64");
                    console.log(`   ⬇️  Downloaded ${Math.round(pdfBuffer.length / 1024)} KB`);
                    break;
                }
            }
            if (pdfBuffer) break;
        }

        if (!pdfBuffer) {
            console.error("   ❌ Could not find or download any invoice PDF.");
            process.exit(1);
        }
    } catch (err: any) {
        console.error("   ❌ Gmail search failed:", err.message);
        process.exit(1);
    }

    // ── Step 2: Extract + Parse ───────────────────────────────────────────────
    console.log("\n3️⃣  Extracting and parsing invoice...");
    let invoiceData: InvoiceData;
    try {
        const extracted = await extractPDF(pdfBuffer);
        console.log(`   📄 Extracted ${extracted.rawText.length} chars of text`);

        invoiceData = await parseInvoice(extracted.rawText);
        console.log(`   ✅ Parsed:`);
        console.log(`      Invoice #:    ${invoiceData.invoiceNumber}`);
        console.log(`      Vendor:       ${invoiceData.vendorName}`);
        console.log(`      PO Reference: ${invoiceData.poNumber || "(none)"}`);
        console.log(`      Invoice Date: ${invoiceData.invoiceDate}`);
        console.log(`      Line Items:   ${invoiceData.lineItems?.length || 0}`);
        console.log(`      Subtotal:     $${invoiceData.subtotal}`);
        console.log(`      Freight:      $${invoiceData.freight || 0}`);
        console.log(`      Tax:          $${invoiceData.tax || 0}`);
        console.log(`      Tariff:       $${invoiceData.tariff || 0}`);
        console.log(`      Total:        $${invoiceData.total}`);
        console.log(`      Amount Due:   $${invoiceData.amountDue}`);
        console.log(`      Tracking:     ${invoiceData.trackingNumbers?.join(", ") || "none"}`);
        console.log(`      Confidence:   ${invoiceData.confidence}`);

        for (const item of invoiceData.lineItems || []) {
            console.log(`        - [${item.sku || "—"}] ${item.description}: qty=${item.qty} × $${item.unitPrice} = $${item.total}`);
        }
    } catch (err: any) {
        console.error("   ❌ Parse failed:", err.message);
        process.exit(1);
    }

    // ── Step 3: Match to PO ───────────────────────────────────────────────────
    console.log("\n4️⃣  Matching invoice to open PO...");
    let matchResult: MatchResult;
    try {
        matchResult = await matchInvoiceToPO(invoiceData);
        console.log(`   ${matchResult.matched ? "✅" : "❌"} Match: ${matchResult.matched ? "YES" : "NO"}`);
        console.log(`      Confidence:  ${matchResult.confidence}`);
        console.log(`      Strategy:    ${matchResult.matchStrategy}`);
        console.log(`      PO Number:   ${matchResult.matchedPO?.poNumber || "(none)"}`);
        console.log(`      Auto-Approve: ${matchResult.autoApprove}`);
        if (matchResult.discrepancies.length > 0) {
            for (const d of matchResult.discrepancies) {
                console.log(`      ⚠️ [${d.severity.toUpperCase()}] ${d.field}: invoice=${d.invoiceValue} vs PO=${d.poValue}`);
            }
        }
    } catch (err: any) {
        console.error("   ❌ Match failed:", err.message);
        // Continue with unmatched result
        matchResult = {
            matched: false,
            confidence: "none",
            matchedPO: null,
            matchStrategy: `Error: ${err.message}`,
            discrepancies: [],
            autoApprove: false,
        };
    }

    // ── Step 4: Save to Supabase ──────────────────────────────────────────────
    console.log("\n5️⃣  Saving to Supabase...");
    const supabase = createClient();
    let documentId: string | null = null;

    if (!supabase) {
        console.warn("   ⚠️ Supabase unavailable — skipping DB save");
    } else {
        try {
            const { data: docData, error: docError } = await supabase.from("documents").insert({
                type: "invoice",
                status: "PROCESSED",
                source: "email",
                source_ref: from,
                email_from: from,
                email_subject: subject,
                action_required: !matchResult.matched || matchResult.discrepancies.length > 0,
                action_summary: `Invoice from ${from} for $${invoiceData.total}`,
            }).select("id").single();

            if (docData && !docError) {
                documentId = docData.id;
                console.log(`   ✅ Document saved (id: ${documentId})`);
            } else if (docError) {
                console.error("   ❌ Document insert failed:", docError.message);
            }

            const { error: invError } = await supabase.from("invoices").upsert({
                invoice_number: invoiceData.invoiceNumber,
                vendor_name: invoiceData.vendorName,
                po_number: invoiceData.poNumber || matchResult.matchedPO?.poNumber || null,
                invoice_date: invoiceData.invoiceDate,
                due_date: invoiceData.dueDate || invoiceData.invoiceDate,
                payment_terms: invoiceData.paymentTerms,
                subtotal: invoiceData.subtotal,
                freight: invoiceData.freight || 0,
                tax: invoiceData.tax || 0,
                tariff: invoiceData.tariff || 0,
                labor: invoiceData.labor || 0,
                tracking_numbers: invoiceData.trackingNumbers || [],
                total: invoiceData.total,
                amount_due: invoiceData.amountDue,
                status: matchResult.matched
                    ? (matchResult.autoApprove ? "matched_approved" : "matched_review")
                    : "unmatched",
                discrepancies: matchResult.discrepancies,
                document_id: documentId,
                raw_data: invoiceData,
            }, { onConflict: "invoice_number" }).select("id").single();

            if (invError) {
                console.error("   ❌ Invoice upsert failed:", invError.message);
            } else {
                console.log(`   ✅ Invoice upserted: ${invoiceData.invoiceNumber}`);
            }
        } catch (err: any) {
            console.error("   ❌ Supabase error:", err.message);
        }
    }

    // ── Step 5: Forward to bill.com ───────────────────────────────────────────
    console.log("\n6️⃣  Forwarding invoice to buildasoilap@bill.com...");
    try {
        const boundary = "b_aria_fwd_" + Math.random().toString(36).substring(2);
        const mimeMessage = [
            `To: buildasoilap@bill.com`,
            `Subject: Fwd: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            ``,
            `--${boundary}`,
            `Content-Type: text/plain; charset="UTF-8"`,
            ``,
            `Forwarded Invoice via Aria AP Agent (Dropship).`,
            `Vendor: ${invoiceData.vendorName} | Invoice: ${invoiceData.invoiceNumber} | Total: $${invoiceData.total}`,
            ``,
            `--${boundary}`,
            `Content-Type: application/pdf; name="${filename}"`,
            `Content-Transfer-Encoding: base64`,
            `Content-Disposition: attachment; filename="${filename}"`,
            ``,
            pdfBase64Raw,
            `--${boundary}--`,
        ].join("\r\n");

        await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: Buffer.from(mimeMessage).toString("base64url") },
        });
        console.log(`   ✅ Forwarded to buildasoilap@bill.com`);
    } catch (err: any) {
        console.error(`   ❌ bill.com forward failed: ${err.message}`);
    }

    // ── Step 7: Telegram Notification ────────────────────────────────────────
    console.log("\n7️⃣  Sending Telegram notification...");
    let tgMsg = `🧾 *New Invoice Processed*\n`;
    tgMsg += `From: ${from}\n`;
    tgMsg += `Vendor: ${invoiceData.vendorName}\n`;
    tgMsg += `Invoice #: ${invoiceData.invoiceNumber}\n`;
    tgMsg += `Total: $${invoiceData.total.toLocaleString()} (Due: $${invoiceData.amountDue.toLocaleString()})\n`;
    tgMsg += `━━━━━\n`;

    if (matchResult.matched) {
        const poNum = matchResult.matchedPO?.poNumber || invoiceData.poNumber || "Unknown";
        tgMsg += `✅ Matched to PO #${poNum} (${matchResult.confidence} confidence)\n`;
        if (matchResult.autoApprove) {
            tgMsg += `✨ *Auto-Approved* — No discrepancies.\n`;
        } else if (matchResult.discrepancies.length > 0) {
            tgMsg += `⚠️ *Action Required — Discrepancies:*\n`;
            for (const d of matchResult.discrepancies) {
                tgMsg += `  • [${d.severity.toUpperCase()}] ${d.field}: Inv=${d.invoiceValue} vs PO=${d.poValue}\n`;
            }
        } else {
            tgMsg += `⚠️ *Manual Review Required* — ${matchResult.matchStrategy}\n`;
        }
    } else {
        tgMsg += `❌ *Unmatched Invoice*\nCould not match to an open PO.\nStrategy: ${matchResult.matchStrategy}\n`;
    }

    await tg(tgMsg);
    console.log("   ✅ Telegram notification sent");

    // ── Step 8: Reconcile against Finale ─────────────────────────────────────
    const finalePONumber = invoiceData.poNumber || matchResult.matchedPO?.poNumber;

    if (matchResult.matched && finalePONumber) {
        console.log(`\n7️⃣  Reconciling against Finale PO ${finalePONumber}...`);
        try {
            const finaleClient = new FinaleClient();
            const result: ReconciliationResult = await reconcileInvoiceToPO(invoiceData, finalePONumber, finaleClient);

            console.log(`   📊 Verdict:   ${result.overallVerdict}`);
            console.log(`   💰 Impact:    $${result.totalDollarImpact.toFixed(2)}`);
            console.log(`   🔄 Auto-applicable: ${result.autoApplicable}`);

            for (const pc of result.priceChanges) {
                const arrow = pc.percentChange > 0 ? "▲" : "▼";
                console.log(`   ${arrow} ${pc.productId}: $${pc.poPrice} → $${pc.invoicePrice} (${pc.percentChange > 0 ? "+" : ""}${pc.percentChange.toFixed(1)}%)`);
            }
            for (const fc of result.feeChanges) {
                console.log(`   💸 Fee ${fc.feeType}: $${fc.amount}`);
            }
            if (result.trackingUpdate) {
                console.log(`   📦 Tracking: ${result.trackingUpdate.trackingNumbers.join(", ")}`);
            }

            if (result.overallVerdict === "auto_approve") {
                console.log("\n   🚀 Auto-applying safe changes to Finale...");
                const applyResult = await applyReconciliation(result, finaleClient);
                console.log(`   ✅ Applied: ${applyResult.applied.length} | Skipped: ${applyResult.skipped.length} | Errors: ${applyResult.errors.length}`);
                if (applyResult.applied.length > 0) console.log(`      Changes: ${applyResult.applied.join(", ")}`);
                if (applyResult.errors.length > 0) console.error(`      Errors: ${applyResult.errors.join(", ")}`);

                // Log to Supabase
                if (supabase) {
                    await supabase.from("ap_activity_log").insert({
                        email_from: invoiceData.vendorName,
                        email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
                        intent: "RECONCILIATION",
                        action_taken: `Auto-applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`,
                        notified_slack: false,
                        metadata: { orderId: result.orderId, invoiceNumber: result.invoiceNumber },
                    });
                    console.log("   ✅ Reconciliation logged to Supabase");
                }

                // Telegram recap
                let reconMsg = `📊 *Reconciliation: ${result.orderId}*\n`;
                reconMsg += `Verdict: *${result.overallVerdict.replace(/_/g, " ")}*\n`;
                reconMsg += `Impact: $${result.totalDollarImpact.toFixed(2)}\n`;
                if (applyResult.applied.length > 0) reconMsg += `✅ Applied: ${applyResult.applied.join(", ")}\n`;
                if (applyResult.errors.length > 0) reconMsg += `❌ Errors: ${applyResult.errors.join(", ")}\n`;
                await tg(reconMsg);

            } else if (result.overallVerdict === "needs_approval") {
                console.log("\n   ⏳ Changes require approval — sending Telegram request...");
                const approvalId = storePendingApproval(result, finaleClient);
                let approvalMsg = `⚠️ *Reconciliation Approval Required*\n`;
                approvalMsg += `PO: ${result.orderId} | Invoice: ${result.invoiceNumber}\n`;
                approvalMsg += `Impact: $${result.totalDollarImpact.toFixed(2)}\n`;
                approvalMsg += `Approval ID: \`${approvalId}\`\n`;
                approvalMsg += `\nReply /approve_${approvalId} to apply or /reject_${approvalId} to discard.`;
                await tg(approvalMsg);
                console.log(`   ✅ Approval request sent (id: ${approvalId})`);

            } else if (result.overallVerdict === "rejected") {
                console.warn("   🚫 Changes REJECTED — likely OCR/decimal error. NOT applying.");
                const rejMsg = `🚫 *Reconciliation REJECTED*\n`;
                await tg(rejMsg + `PO: ${result.orderId} | Magnitude error detected. Manual review required.`);

            } else if (result.overallVerdict === "duplicate") {
                console.log("   🔁 Already reconciled — skipping.");
                await tg(`🔁 Invoice ${result.invoiceNumber} already reconciled against PO ${result.orderId}. No action taken.`);

            } else {
                console.log("   ℹ️ No changes needed.");
                await tg(`ℹ️ Invoice ${result.invoiceNumber} vs PO ${result.orderId}: no changes needed.`);
            }
        } catch (err: any) {
            console.error("   ❌ Reconciliation failed:", err.message);
            await tg(`❌ Reconciliation failed for invoice ${invoiceData.invoiceNumber}: ${err.message}`);
        }
    } else {
        console.log("\n7️⃣  Reconciliation skipped — no PO match.");
        if (!matchResult.matched) {
            console.log("      Reason: invoice not matched to a Finale PO");
        } else {
            console.log("      Reason: no PO number available");
        }
    }

    console.log("\n═══════════════════════════════════════════════");
    console.log("  Pipeline Complete");
    console.log("═══════════════════════════════════════════════\n");
    process.exit(0);
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
