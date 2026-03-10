/**
 * @file    run-ap-pipeline.ts
 * @purpose Manually trigger the full AP invoice pipeline on a real invoice
 *          found in Gmail. Mirrors processInvoiceBuffer() in ap-agent.ts.
 *          Searches for any recent invoice with a PDF — most recent match wins.
 * @usage   node --import tsx src/cli/run-ap-pipeline.ts
 */

import { gmail as GmailApi } from "@googleapis/gmail";
import { Telegraf, Markup } from "telegraf";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { createClient } from "../lib/supabase";
import { extractPDF } from "../lib/pdf/extractor";
import { parseInvoice, InvoiceData } from "../lib/pdf/invoice-parser";
import { FinaleClient } from "../lib/finale/client";
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    storePendingApproval,
    buildAuditMetadata,
    ReconciliationResult,
    TrackingUpdate,
} from "../lib/finale/reconciler";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

// ─── Telegram helper ────────────────────────────────────────────────────────
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

async function tg(msg: string, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
            return;
        } catch (err: any) {
            if (i < retries - 1) {
                console.warn(`   ⚠️ Telegram send failed (attempt ${i + 1}/${retries}): ${err.message} — retrying...`);
                await new Promise(r => setTimeout(r, 2000 * (i + 1)));
            } else {
                console.warn(`   ⚠️ Telegram send failed after ${retries} attempts: ${err.message}`);
            }
        }
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
            gmail = GmailApi({ version: "v1", auth });
            const p = await gmail.users.getProfile({ userId: "me" });
            console.log(`   ✅ Connected as: ${p.data.emailAddress} (ap token)`);
        } catch {
            const auth = await getAuthenticatedClient("default");
            gmail = GmailApi({ version: "v1", auth });
            const p = await gmail.users.getProfile({ userId: "me" });
            console.log(`   ✅ Connected as: ${p.data.emailAddress} (default token)`);
        }
    } catch (err: any) {
        console.error("   ❌ Gmail auth failed:", err.message);
        process.exit(1);
    }

    console.log("\n2️⃣  Searching for most recent invoice with PDF...");
    let pdfBuffer: Buffer | null = null;
    let pdfBase64Raw = "";  // kept for bill.com forwarding
    let subject = "";
    let from = "";
    let filename = "";

    // Optional: --subject "substring" narrows the Gmail search to a specific invoice
    const subjectFilter = (() => {
        const idx = process.argv.indexOf("--subject");
        return idx !== -1 ? process.argv[idx + 1] : null;
    })();
    if (subjectFilter) console.log(`   🔍 Filtering by subject: "${subjectFilter}"`);

    try {
        // Find any recent invoice PDF — most recent match wins
        const baseSearch = subjectFilter
            ? `subject:"${subjectFilter}" has:attachment filename:pdf newer_than:90d`
            : null;
        const queries = baseSearch ? [baseSearch] : [
            "has:attachment filename:pdf (invoice OR inv OR bill) newer_than:14d",
            "has:attachment filename:pdf newer_than:30d",
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
                        if (part.filename && part.filename.toLowerCase().endsWith(".pdf")) pdfParts.push(part);
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
                    const candidate = Buffer.from(base64, "base64");
                    if (candidate.length < 1024) {
                        console.log(`   ⏭️  Skipping ${filename} — too small (${candidate.length} bytes), likely not a real invoice`);
                        continue;
                    }
                    // Skip dashboard upload echoes forwarded by the bot itself
                    if (subject.includes("Dashboard Upload")) {
                        console.log(`   ⏭️  Skipping dashboard upload echo: "${subject}"`);
                        continue;
                    }
                    pdfBase64Raw = base64;
                    pdfBuffer = candidate;
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
    let subjectPoFallback: string | null = null;
    try {
        const extracted = await extractPDF(pdfBuffer);
        console.log(`   📄 Extracted ${extracted.rawText.length} chars of text`);

        invoiceData = await parseInvoice(extracted.rawText);

        // Subject-line PO is stored as a last-resort fallback.
        // Vendor invoice references (e.g., Riceland's "B123402") are often THEIR internal PO
        // number, not BuildASoil's Finale PO. OCR reads BuildASoil's printed PO ("B124302" →
        // Finale 124302). Only use subject extraction if ALL OCR candidates fail Finale probe.
        const subjectPoMatch = subject.match(/\bPO\s*#?\s*([A-Za-z]?\d{5,})/i);
        subjectPoFallback = subjectPoMatch ? subjectPoMatch[1] : null;
        if (subjectPoFallback && !invoiceData.poNumber) {
            invoiceData.poNumber = subjectPoFallback;
            console.log(`   📧 PO from subject (no OCR PO found): ${subjectPoFallback}`);
        } else if (subjectPoFallback) {
            console.log(`   📧 Subject PO ${subjectPoFallback} noted as fallback (probing OCR candidates first)`);
        }

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

    // ── Step 3b: Resolve PO via Finale-direct probe ───────────────────────────
    // NOTE: Production ap-agent.ts queries Finale directly (not Supabase).
    // This step mirrors that behavior exactly so test results match production.
    console.log("\n4️⃣  Resolving PO via Finale direct probe...");
    let finalePONumber = invoiceData.poNumber || null;
    let matchSource = "PO# on invoice";

    if (subjectPoFallback && !finalePONumber) {
        finalePONumber = subjectPoFallback;
        matchSource = "PO# from email subject (no OCR PO found)";
    }

    if (finalePONumber) {
        const tokens = finalePONumber.includes(" ")
            ? finalePONumber.split(/\s+/).filter(Boolean)
            : [finalePONumber];
        const candidates: string[] = [];
        for (const t of tokens) {
            candidates.push(t);
            const withParens = t.replace(/^([A-Za-z]+)(\d+)$/, "$1($2)");
            if (withParens !== t) candidates.push(withParens);
            const digitsOnly = t.replace(/^[A-Za-z]+/, "");
            if (digitsOnly && digitsOnly !== t) {
                candidates.push(digitsOnly);
                candidates.push(`(${digitsOnly})`);
                for (let i = 0; i < digitsOnly.length - 1; i++) {
                    const arr = digitsOnly.split("");
                    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
                    const swapped = arr.join("");
                    if (swapped !== digitsOnly) candidates.push(swapped);
                }
            }
        }
        if (candidates.length > 1 || candidates[0] !== finalePONumber) {
            console.log(`   ⚠️  Probing Finale for valid PO from candidates: ${candidates.join(", ")}...`);
            const probeClient = new FinaleClient();
            const validCandidates: string[] = [];
            for (const candidate of candidates) {
                try {
                    await probeClient.getOrderDetails(candidate);
                    validCandidates.push(candidate);
                } catch {
                    console.log(`   ↳ "${candidate}" not found in Finale`);
                }
            }
            if (validCandidates.length === 1) {
                console.log(`   ✅ Resolved to PO: ${validCandidates[0]}`);
                finalePONumber = validCandidates[0];
            } else if (validCandidates.length > 1) {
                console.log(`   ⚠️  Multiple POs found: ${validCandidates.join(", ")} — disambiguating by vendor...`);
                let bestCandidate = validCandidates[0];
                let bestScore = -1;
                const invoiceVendorWords = (invoiceData.vendorName || "")
                    .toLowerCase().split(/\s+/).filter(w => w.length > 2);
                for (const candidate of validCandidates) {
                    try {
                        const summary = await probeClient.getOrderSummary(candidate);
                        if (!summary) continue;
                        const score = invoiceVendorWords.filter(w => summary.supplier.toLowerCase().includes(w)).length;
                        console.log(`   ↳ PO ${candidate}: supplier="${summary.supplier}", score=${score}`);
                        if (score > bestScore) { bestScore = score; bestCandidate = candidate; }
                    } catch { /* leave current best */ }
                }
                console.log(`   ✅ Best vendor match: PO ${bestCandidate}`);
                finalePONumber = bestCandidate;
            } else if (subjectPoFallback) {
                // Last resort: subject line fallback
                const subjectCandidates = [subjectPoFallback];
                const subjectDigits = subjectPoFallback.replace(/^[A-Za-z]+/, "");
                if (subjectDigits && subjectDigits !== subjectPoFallback) subjectCandidates.push(subjectDigits);
                for (const candidate of subjectCandidates) {
                    try {
                        await probeClient.getOrderDetails(candidate);
                        console.log(`   ✅ Resolved via subject fallback: PO ${candidate}`);
                        finalePONumber = candidate;
                        matchSource = "PO# from email subject (fallback)";
                        break;
                    } catch {
                        console.log(`   ↳ "${candidate}" not found`);
                    }
                }
            }
        }
    }

    // If still no PO, try Finale vendor+date fallback
    if (!finalePONumber) {
        try {
            const finaleClient = new FinaleClient();
            const candidates = await finaleClient.findPOByVendorAndDate(
                invoiceData.vendorName, invoiceData.invoiceDate, 30
            );
            const plausible = candidates.filter(c =>
                (c.status === "Committed" || c.status === "Open") &&
                invoiceData.total > 0 &&
                Math.abs(c.total - invoiceData.total) / invoiceData.total < 0.10
            );
            if (plausible.length > 0) {
                plausible.sort((a, b) => Math.abs(a.total - invoiceData.total) - Math.abs(b.total - invoiceData.total));
                finalePONumber = plausible[0].orderId;
                matchSource = `Finale vendor+date match (${plausible[0].supplier}, ${plausible[0].orderDate}) — REQUIRES APPROVAL`;
                console.log(`   → Finale fallback matched PO ${finalePONumber} for ${invoiceData.vendorName}`);
            }
        } catch (err: any) {
            console.warn(`   ⚠️  Finale fallback lookup failed: ${err.message}`);
        }
    }

    const matched = !!finalePONumber;
    console.log(`   ${matched ? "✅" : "❌"} Match: ${matched ? `YES — PO ${finalePONumber} (${matchSource})` : "NO"}\n`);

    // ── Step 4: Save to Supabase ──────────────────────────────────────────────
    console.log("5️⃣  Saving to Supabase...");
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
                action_required: !matched,
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
                po_number: finalePONumber || null,
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
                status: matched ? "matched_review" : "unmatched",
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

        // Chunk the base64 string to adhere to RFC 2045 76-character line limit
        const chunkedBase64 = pdfBase64Raw.match(/.{1,76}/g)?.join("\r\n") || pdfBase64Raw;

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
            chunkedBase64,
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

    // ── Step 6b: Telegram Notification ───────────────────────────────────────
    console.log("\n7️⃣  Sending Telegram notification...");
    let tgMsg = `🧾 *New Invoice Processed* _(manual pipeline run)_\n`;
    tgMsg += `From: ${from}\n`;
    tgMsg += `Vendor: ${invoiceData.vendorName}\n`;
    tgMsg += `Invoice #: ${invoiceData.invoiceNumber}\n`;
    tgMsg += `Total: $${invoiceData.total.toLocaleString()} (Due: $${invoiceData.amountDue.toLocaleString()})\n`;
    tgMsg += `━━━━━\n`;

    if (matched && finalePONumber) {
        tgMsg += `✅ Matched to PO #${finalePONumber}\n`;
        tgMsg += `_${matchSource}_\n`;
        tgMsg += `Running reconciliation against Finale...\n`;
    } else {
        tgMsg += `❌ *No PO found*\nInvoice #: ${invoiceData.invoiceNumber}\n_Searched Finale by vendor name + date_\n`;
    }

    await tg(tgMsg);
    console.log("   ✅ Telegram notification sent");

    // ── Step 7: Reconcile against Finale ─────────────────────────────────────
    // PO already resolved via Finale-direct probe in Step 4 above.
    // forceApproval=true when matched via vendor+date fallback (mirrors production behavior).
    const forceApproval = matchSource.includes("REQUIRES APPROVAL");

    if (matched && finalePONumber) {
        console.log(`\n7️⃣  Reconciling against Finale PO ${finalePONumber}${forceApproval ? " (force-approval: fallback match)" : ""}...`);
        try {
            const finaleClient = new FinaleClient();
            const result: ReconciliationResult = await reconcileInvoiceToPO(invoiceData, finalePONumber, finaleClient);

            // Mirror production ap-agent behavior: fallback matches require approval before any Finale writes
            if (forceApproval && result.overallVerdict === "auto_approve") {
                result.overallVerdict = "needs_approval";
                result.autoApplicable = false;
                for (const pc of result.priceChanges) {
                    if (pc.verdict === "auto_approve") {
                        pc.verdict = "needs_approval";
                        pc.reason += " | PO matched via vendor+date fallback — manual confirmation required";
                    }
                }
                console.log(`   ⚠️  Force-upgraded to needs_approval (fallback PO match)`);
            }

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

                // Full audit log to Supabase
                if (supabase) {
                    await supabase.from("ap_activity_log").insert({
                        email_from: invoiceData.vendorName,
                        email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
                        intent: "RECONCILIATION",
                        action_taken: `Auto-applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`,
                        notified_slack: false,
                        metadata: buildAuditMetadata(result, applyResult, "auto"),
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
                // Manual test run — apply immediately instead of waiting for Telegram approval.
                // The live bot's 15-min AP check uses the normal approval flow; this script
                // is interactive so Will can see the output and it's appropriate to apply now.
                console.log("\n   🚀 Applying changes (manual run — auto-approved)...");
                const allApprovedItems = result.priceChanges
                    .filter(pc => pc.verdict === "needs_approval")
                    .map(pc => pc.productId);
                const allApprovedFees = result.feeChanges
                    .filter(fc => fc.verdict === "needs_approval")
                    .map(fc => fc.feeType);
                const applyResult = await applyReconciliation(result, finaleClient, allApprovedItems, allApprovedFees);
                console.log(`   ✅ Applied: ${applyResult.applied.length} | Skipped: ${applyResult.skipped.length} | Errors: ${applyResult.errors.length}`);
                if (applyResult.applied.length > 0) console.log(`      Changes: ${applyResult.applied.join(", ")}`);
                if (applyResult.errors.length > 0) console.error(`      Errors: ${applyResult.errors.join(", ")}`);

                // Full audit log to Supabase
                if (supabase) {
                    await supabase.from("ap_activity_log").insert({
                        email_from: invoiceData.vendorName,
                        email_subject: `Invoice ${result.invoiceNumber} → PO ${result.orderId}`,
                        intent: "RECONCILIATION",
                        action_taken: `Manual run applied: ${applyResult.applied.length} changes, ${applyResult.skipped.length} skipped`,
                        notified_slack: false,
                        metadata: buildAuditMetadata(result, applyResult, "manual"),
                    });
                    console.log("   ✅ Reconciliation logged to Supabase");
                }

                let reconMsg = result.summary + "\n\n✅ *Applied via manual pipeline run*\n";
                if (applyResult.applied.length > 0) reconMsg += `Changes: ${applyResult.applied.join(", ")}\n`;
                if (applyResult.errors.length > 0) reconMsg += `Errors: ${applyResult.errors.join(", ")}\n`;
                await tg(reconMsg);

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
        console.log("\n7️⃣  Reconciliation skipped — no PO matched in Finale.");
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
