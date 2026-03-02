/**
 * @file    test-ap-agent-live.ts
 * @purpose Live integration test: proves the AP Agent pipeline works with real
 *          Gmail, Supabase, and Finale APIs. Uses bill.selee token (default)
 *          since token-ap.json for ap@buildasoil.com may not exist yet.
 * @author  Antigravity
 * @created 2026-02-27
 */

import { google } from "googleapis";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { createClient } from "../lib/supabase";
import { parseInvoice } from "../lib/pdf/invoice-parser";
import { extractPDF } from "../lib/pdf/extractor";
import { FinaleClient } from "../lib/finale/client";
import {
    reconcileInvoiceToPO,
} from "../lib/finale/reconciler";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function main() {
    console.log("═══════════════════════════════════════════════");
    console.log("  AP Agent Live Integration Test");
    console.log("═══════════════════════════════════════════════\n");

    // ── Step 1: Gmail Access ──────────────────────────
    console.log("1️⃣  Gmail Connection...");
    let gmail: any;
    let tokenUsed = "unknown";
    try {
        // Try ap token first, fall back to default
        try {
            const auth = await getAuthenticatedClient("ap");
            gmail = google.gmail({ version: "v1", auth });
            tokenUsed = "ap (ap@buildasoil.com)";
        } catch {
            const auth = await getAuthenticatedClient("default");
            gmail = google.gmail({ version: "v1", auth });
            tokenUsed = "default (bill.selee@buildasoil.com)";
        }

        const profile = await gmail.users.getProfile({ userId: "me" });
        console.log(`   ✅ Connected as: ${profile.data.emailAddress} (token: ${tokenUsed})`);
        console.log(`   📬 Total messages: ${profile.data.messagesTotal}`);
    } catch (err: any) {
        console.error(`   ❌ Gmail FAILED: ${err.message}`);
        process.exit(1);
    }

    // ── Step 2: Find a real invoice email ──────────────
    console.log("\n2️⃣  Searching for invoice emails...");
    let invoiceEmail: any = null;
    let pdfAttachment: any = null;
    let base64Pdf: string | null = null;
    try {
        const { data: search } = await gmail.users.messages.list({
            userId: "me",
            q: "has:attachment filename:pdf (invoice OR inv OR bill) newer_than:30d",
            maxResults: 5,
        });

        if (!search.messages?.length) {
            console.log("   ⚠️ No invoice emails found in last 30 days.");
        } else {
            for (const m of search.messages) {
                const { data: msg } = await gmail.users.messages.get({
                    userId: "me",
                    id: m.id!,
                });

                const subject = msg.payload?.headers?.find((h: any) => h.name === "Subject")?.value || "No Subject";
                const from = msg.payload?.headers?.find((h: any) => h.name === "From")?.value || "Unknown";

                const pdfParts: any[] = [];
                function walkParts(parts: any[]): void {
                    for (const part of parts) {
                        if (part.mimeType === "application/pdf" && part.filename) {
                            pdfParts.push(part);
                        }
                        if (part.parts?.length) {
                            walkParts(part.parts);
                        }
                    }
                }
                walkParts(msg.payload?.parts || []);

                if (pdfParts.length > 0) {
                    invoiceEmail = { subject, from, messageId: m.id };
                    pdfAttachment = pdfParts[0];
                    console.log(`   ✅ Found: "${subject}"`);
                    console.log(`      From: ${from}`);
                    console.log(`      PDFs found: ${pdfParts.length} (${pdfParts.map((p: any) => p.filename).join(", ")})`);

                    // Download the attachment
                    if (pdfAttachment.body?.attachmentId) {
                        console.log(`   ⬇️ Downloading PDF attachment...`);
                        const att = await gmail.users.messages.attachments.get({
                            userId: "me",
                            messageId: m.id!,
                            id: pdfAttachment.body.attachmentId
                        });
                        if (att.data.data) {
                            // Base64Url encode to standard Base64
                            base64Pdf = att.data.data!.replace(/-/g, "+").replace(/_/g, "/");
                            console.log(`   ✅ PDF Downloaded (${Math.round((base64Pdf?.length ?? 0) / 1024)} KB)`);
                        }
                    } else if (pdfAttachment.body?.data) {
                        base64Pdf = pdfAttachment.body.data.replace(/-/g, "+").replace(/_/g, "/");
                        console.log(`   ✅ PDF Loaded from inline data`);
                    }
                    break;
                }
            }
        }
    } catch (err: any) {
        console.error(`   ❌ Email search FAILED: ${err.message}`);
    }

    // ── Step 3: Parse PDF explicitly if found ──────────
    console.log("\n3️⃣  Invoice Parsing (Gemini)...");
    let parsedInvoiceBuffer: any = null;
    if (base64Pdf) {
        try {
            console.log("   🧠 Sending PDF to Gemini for parsing...");
            const buffer = Buffer.from(base64Pdf, "base64");
            const extracted = await extractPDF(buffer);
            parsedInvoiceBuffer = await parseInvoice(extracted.rawText);
            console.log(`   ✅ Parse success:`);
            console.log(`      Invoice #: ${parsedInvoiceBuffer.invoiceNumber}`);
            console.log(`      Vendor: ${parsedInvoiceBuffer.vendorName}`);
            console.log(`      Line Items: ${parsedInvoiceBuffer.lineItems?.length || 0}`);
            console.log(`      Total: $${parsedInvoiceBuffer.total}`);
            console.log(`      Tariff/Labor fields present: ${'tariff' in parsedInvoiceBuffer}, ${'labor' in parsedInvoiceBuffer}`);
            console.log(`      Tracking numbers: ${parsedInvoiceBuffer.tracking_numbers?.join(', ') || 'none'}`);
        } catch (err: any) {
            console.error(`   ❌ PDF Parse FAILED: ${err.message}`);
        }
    } else {
        console.log("   ⚠️ No PDF available to parse.");
    }

    // ── Step 4: Supabase Connection & Validations ─────
    console.log("\n4️⃣  Supabase Validation...");
    const supabase = createClient();
    if (!supabase) {
        console.error("   ❌ Supabase client is null");
        process.exit(1);
    }
    try {
        const { data: cols, error: colErr } = await supabase
            .from("invoices")
            .select("tariff, labor, tracking_numbers")
            .limit(1);
        if (colErr) throw colErr;
        console.log(`   ✅ invoices.tariff/labor/tracking_numbers columns physically exist`);

        // Test vendor_profiles basic write/read
        console.log("   📝 Testing vendor_profiles persistence...");
        const testVendorName = `test-vendor-${Date.now()}`;
        await supabase.from("vendor_profiles").upsert({
            vendor_name: testVendorName,
            vendor_emails: ["test@vendor.com"],
            total_pos: 1,
            responded_count: 0,
            communication_pattern: "no_response",
        }, { onConflict: "vendor_name" });

        const { data: vp } = await supabase.from("vendor_profiles").select("*").eq("vendor_name", testVendorName).single();
        if (vp) {
            console.log(`   ✅ vendor_profiles WRITE & READ successful`);
            await supabase.from("vendor_profiles").delete().eq("vendor_name", testVendorName);
        } else {
            console.log(`   ❌ vendor_profiles READ failed`);
        }
    } catch (err: any) {
        console.error(`   ❌ Supabase FAILED: ${err.message}`);
    }

    // ── Step 5: Finale API & Reconciliation ──────────
    console.log("\n5️⃣  Finale API & Reconciliation Engine (live data)...");
    try {
        const finale = new FinaleClient();
        const receivedPOs = await finale.getTodaysReceivedPOs();
        console.log(`   ✅ Finale connected — ${receivedPOs.length} PO(s) received recently`);

        // Find a valid standard PO (skip Dropship/Transfer)
        const committedPOs = await finale.getTodaysCommittedPOs();
        const validPO = committedPOs.find((p: any) => !p.orderId.includes('Dropship') && !p.orderId.includes('Transfer'));

        if (validPO) {
            console.log(`   🔍 Testing reconciliation against standard PO ${validPO.orderId} (Vendor: ${(validPO as any).vendorName || 'Unknown'})...`);

            const mockObj = parsedInvoiceBuffer || {
                documentType: "invoice",
                invoiceNumber: `TEST-${Date.now()}`,
                vendorName: (validPO as any).vendorName || "Test Vendor",
                invoiceDate: new Date().toISOString().split("T")[0],
                lineItems: validPO.items?.slice(0, 2).map((item: any) => ({
                    description: item.productId || "Test Item",
                    qty: item.quantity || 1,
                    unitPrice: item.unitPrice || 10,
                    total: (item.quantity || 1) * (item.unitPrice || 10),
                })) || [{ description: "Test", qty: 1, unitPrice: 10, total: 10 }],
                subtotal: 100,
                total: 100,
                amountDue: 100,
                confidence: "high"
            };

            const result = await reconcileInvoiceToPO(mockObj as any, validPO.orderId, finale);

            console.log(`   ✅ Verdict: ${result.overallVerdict}`);
            console.log(`   💰 Impact: $${result.totalDollarImpact.toFixed(2)}`);

            console.log(`\n   ── Summary ──`);
            for (const pc of result.priceChanges) {
                console.log(`   ${pc.productId}: $${pc.poPrice} → $${pc.invoicePrice} (${pc.percentChange > 0 ? '+' : ''}${pc.percentChange.toFixed(1)}%)`);
            }
            if (result.priceChanges.length === 0) console.log(`   No price changes.`);
            for (const fc of result.feeChanges) {
                console.log(`   Fee: ${fc.feeType}: $${fc.amount}`);
            }
        } else {
            console.log("   ⚠️ No valid standard POs found to test reconciliation.");
        }
    } catch (err: any) {
        console.error(`   ❌ Reconciliation FAILED: ${err.message}`);
    }

    // ── Step 6: Duplicate Detection ─────────────────
    console.log("\n6️⃣  Duplicate Detection & Audit Trail...");
    try {
        const testInvoiceNum = `DUPE-TEST-${Date.now()}`;
        const { error: insertErr } = await supabase.from("ap_activity_log").insert({
            email_from: "test@vendor.com",
            email_subject: `Invoice ${testInvoiceNum} → PO 999999`,
            intent: "RECONCILIATION",
            action_taken: "Test entry for duplicate detection",
            notified_slack: true, // test the new column
            metadata: {
                invoiceNumber: testInvoiceNum,
                orderId: "999999",
            },
        });

        if (insertErr) {
            console.error(`   ❌ Supabase insert failed: ${insertErr.message}`);
        }

        const { data } = await supabase
            .from("ap_activity_log")
            .select("created_at, action_taken, notified_slack")
            .eq("intent", "RECONCILIATION")
            .filter("metadata->>invoiceNumber", "eq", testInvoiceNum)
            .filter("metadata->>orderId", "eq", "999999")
            .limit(1);

        if (data && data.length > 0) {
            console.log(`   ✅ Duplicate detection FINDS entry. notified_slack = ${data[0].notified_slack}`);
        } else {
            console.log("   ❌ Duplicate detection FAILED");
        }

        await supabase.from("ap_activity_log").delete().eq("action_taken", "Test entry for duplicate detection");
        console.log("   🧹 Test entry cleaned up");
    } catch (err: any) {
        console.error(`   ❌ Duplicate detection test FAILED: ${err.message}`);
    }

    console.log("\n═══════════════════════════════════════════════");
    console.log("  Integration Test Complete");
    console.log("═══════════════════════════════════════════════\n");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
