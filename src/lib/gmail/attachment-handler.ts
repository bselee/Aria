import { google, gmail_v1 } from "googleapis";
import { getAuthenticatedClient } from "./auth";
import { extractPDF } from "../../lib/pdf/extractor";
import { classifyDocument } from "../../lib/pdf/classifier";
import { parseInvoice } from "../../lib/pdf/invoice-parser";
import { parsePurchaseOrder } from "../../lib/pdf/po-parser";
import { parseVendorStatement } from "../../lib/pdf/statement-parser";
import { matchInvoiceToPO } from "../../lib/matching/invoice-po-matcher";
import { uploadPDF } from "../../lib/storage/supabase-storage";
import { createClient } from "../../lib/supabase";
import { ShipmentTracker } from "../../lib/carriers/aftership";
import { parseBOL } from "../../lib/pdf/bol-parser";
import { indexOperationalContext } from "../intelligence/pinecone";

const PROCESSABLE_MIMES = new Set([
    "application/pdf",
    "application/x-pdf",
    "image/png",
    "image/jpeg",
    "image/tiff",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export async function processEmailAttachments(
    accountId: string,
    messageId: string,
    emailMetadata: { from: string; subject: string; date: string }
) {
    const auth = await getAuthenticatedClient(accountId);
    const gmail = google.gmail({ version: "v1", auth });

    // Get full message
    const { data: message } = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
    });

    const attachments = extractAttachmentParts(message.payload);
    if (!attachments.length) return [];

    const processedDocs = await Promise.all(
        attachments.map(async (attachment) => {
            if (!PROCESSABLE_MIMES.has(attachment.mimeType)) return null;

            // Download attachment data
            const { data: attachData } = await gmail.users.messages.attachments.get({
                userId: "me",
                messageId,
                id: attachment.attachmentId,
            });

            const buffer = Buffer.from(attachData.data!, "base64url");

            return processDocument(buffer, {
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                source: "email",
                sourceRef: messageId,
                accountId,
                emailFrom: emailMetadata.from,
                emailSubject: emailMetadata.subject,
                emailDate: emailMetadata.date,
            });
        })
    );

    return processedDocs.filter(Boolean);
}

export async function processDocument(
    buffer: Buffer,
    meta: {
        filename: string;
        mimeType: string;
        source: "email" | "upload" | "github";
        sourceRef: string;
        accountId?: string;
        emailFrom?: string;
        emailSubject?: string;
        emailDate?: string;
    }
) {
    const supabase = createClient();
    const tracker = new ShipmentTracker();

    // 1. Extract text from PDF
    const extraction = await extractPDF(buffer);

    // 2. Classify document type
    const classification = await classifyDocument(extraction);

    // 3. Parse structured data based on type
    let extractedData: unknown = null;
    let matchResult = null;

    switch (classification.type) {
        case "INVOICE":
            extractedData = await parseInvoice(extraction.rawText,
                extraction.tables.map(t => [t.headers.join(" | "), ...t.rows.map(r => r.join(" | "))])
            );
            // Immediately attempt PO match
            if (extractedData) {
                matchResult = await matchInvoiceToPO(extractedData as ReturnType<typeof parseInvoice> extends Promise<infer T> ? T : never);
            }
            break;

        case "PURCHASE_ORDER":
            extractedData = await parsePurchaseOrder(extraction.rawText);
            break;

        case "VENDOR_STATEMENT":
            extractedData = await parseVendorStatement(extraction.rawText);
            break;

        case "BILL_OF_LADING":
        case "PACKING_SLIP":
            extractedData = await parseBOL(extraction.rawText);
            // Extract any tracking numbers
            const trackingNums = tracker.extractFromText(extraction.rawText);
            if (trackingNums.length > 0) {
                // Auto-track any found tracking numbers
                const trackingResults = await Promise.all(
                    trackingNums.map(t => tracker.track(t.trackingNumber, t.carrier))
                );
                (extractedData as Record<string, unknown>).trackingData = trackingResults;
            }
            break;
    }

    // 4. Upload PDF to Supabase Storage (Optional)
    let storagePath = "";
    if (supabase) {
        try {
            storagePath = await uploadPDF(buffer, {
                type: classification.type,
                vendor: (extractedData as Record<string, string>)?.vendorName ?? "unknown",
                date: new Date().toISOString().slice(0, 10),
                filename: meta.filename,
            });
        } catch (e: any) {
            console.warn("⚠️ Storage upload failed, skipping:", e.message);
        }
    }

    // 5. Save to database and index to Pinecone
    let savedDoc = null;
    let vendorId = "";

    if (supabase && extractedData) {
        try {
            // Identify/create vendor
            vendorId = await findOrCreateVendor(
                (extractedData as Record<string, string>)?.vendorName ?? meta.emailFrom ?? "Unknown Vendor"
            );

            // Save processed document
            const { data } = await supabase.from("documents").insert({
                type: classification.type,
                status: matchResult?.autoApprove ? "MATCHED" : "EXTRACTED",
                source: meta.source,
                source_ref: meta.sourceRef,
                vendor_id: vendorId,
                extracted_data: extractedData,
                raw_text: extraction.rawText.slice(0, 50000),
                pdf_path: storagePath,
                confidence: classification.confidence,
                action_required: !matchResult?.autoApprove,
                action_summary: generateActionSummary(classification.type, extractedData, matchResult),
                linked_documents: matchResult?.matchedPO
                    ? [(extractedData as Record<string, string>)?.poNumber]
                    : [],
                email_from: meta.emailFrom,
                email_subject: meta.emailSubject,
                email_date: meta.emailDate,
            }).select().single();
            savedDoc = data;

            // Type-specific DB storage
            if (classification.type === "INVOICE") {
                await supabase.from("invoices").upsert({
                    invoice_number: (extractedData as Record<string, unknown>).invoiceNumber,
                    vendor_id: vendorId,
                    vendor_name: (extractedData as Record<string, unknown>).vendorName,
                    po_number: (extractedData as Record<string, unknown>).poNumber,
                    invoice_date: (extractedData as Record<string, unknown>).invoiceDate,
                    due_date: (extractedData as Record<string, unknown>).dueDate,
                    total: (extractedData as Record<string, unknown>).total,
                    status: matchResult?.autoApprove ? "matched" : "unmatched",
                    matched_po_id: matchResult?.matchedPO ? (extractedData as Record<string, unknown>).poNumber : null,
                    discrepancies: matchResult?.discrepancies ?? [],
                    document_id: savedDoc?.id,
                    raw_data: extractedData,
                }, { onConflict: "invoice_number" });
            }
        } catch (dbErr: any) {
            console.error("❌ Database sync failed:", dbErr.message);
        }
    }

    // 🧠 Always Index to Pinecone (Memory)
    await indexOperationalContext(
        `doc-${meta.sourceRef}-${meta.filename}`,
        `Document ${meta.filename} (${classification.type}) from ${meta.emailFrom}. \nContent: ${extraction.rawText.slice(0, 2000)}`,
        {
            type: classification.type,
            source: meta.source,
            source_ref: meta.sourceRef,
            vendor_name: (extractedData as Record<string, any>)?.vendorName
        }
    );

    return { document: savedDoc, classification, extractedData, matchResult };
}

async function findOrCreateVendor(vendorName: string): Promise<string> {
    const supabase = createClient();

    // Fuzzy search for existing vendor
    const { data: existing } = await supabase
        .from("vendors")
        .select("id, name")
        .textSearch("name", vendorName.split(" ").join(" | "));

    if (existing?.length) return existing[0].id;

    // Create new vendor record
    const { data: newVendor } = await supabase
        .from("vendors")
        .insert({ name: vendorName, status: "active" })
        .select("id")
        .single();

    return newVendor!.id;
}

function extractAttachmentParts(
    payload: gmail_v1.Schema$MessagePart | undefined,
    parts: Array<{ attachmentId: string; filename: string; mimeType: string }> = []
) {
    if (!payload) return parts;
    if (payload.filename && payload.body?.attachmentId) {
        parts.push({
            attachmentId: payload.body.attachmentId,
            filename: payload.filename,
            mimeType: payload.mimeType ?? "application/octet-stream",
        });
    }
    for (const part of payload.parts ?? []) {
        extractAttachmentParts(part, parts);
    }
    return parts;
}

function generateActionSummary(type: string, data: unknown, match: unknown): string {
    const d = data as Record<string, unknown>;
    const m = match as Record<string, unknown>;

    if (type === "INVOICE") {
        if (m?.autoApprove) return `Invoice ${d?.invoiceNumber} matched to PO ${d?.poNumber}. Ready for payment.`;
        if (m?.matched) return `Invoice ${d?.invoiceNumber} matched to PO with ${(m?.discrepancies as unknown[])?.length} discrepancies. Review required.`;
        return `Invoice ${d?.invoiceNumber} from ${d?.vendorName} for $${d?.total} — no matching PO found.`;
    }
    if (type === "VENDOR_STATEMENT") return `Statement from ${d?.vendorName}. Balance: $${d?.endingBalance}. Requires reconciliation.`;
    if (type === "BILL_OF_LADING") return `BOL received from ${d?.carrierName ?? "carrier"}. Contains ${(d?.trackingData as unknown[])?.length ?? 0} shipments.`;
    return `${type} document received. Review required.`;
}
