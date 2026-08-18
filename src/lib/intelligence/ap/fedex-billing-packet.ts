/**
 * @file    fedex-billing-packet.ts
 * @purpose Detect FedEx Billing Online multi-page invoice packets and define
 *          AP handling rules: forward FULL PDF (never trim), pay-path only
 *          (Bill.com), never product-PO freight apply / Uline bas_freight.
 *
 * Format (verified 2026-08-05):
 *   Email: noreply@fedex.com → ap@
 *   Subject: Your New FedEx Billing Online invoice is attached
 *   Attachments: 12.99999.<batch>.<invoiceDigits>.XXXXX5250.<seq>.pdf
 *     - Express packet (~40pp) + Ground packet (~100–150pp) typical
 *   Content: parcel Express/Ground (mostly BAS outbound). Not Freight LTL,
 *            not Uline COLLECT — those stay on FBO CSV / LTL Select.
 *
 * @author  Hermia
 * @created 2026-08-05
 * @deps    none
 */

/** Opaque FBO attachment name FedEx emails to AP. */
export const FEDEX_BILLING_PACKET_FILENAME_RE =
    /^12\.99999\.\d+\.(\d+)\.XXXXX\d+\.\d+\.pdf$/i;

/** Routing action stored on queue rows — forwarders skip PO match. */
export const FEDEX_CARRIER_BILL_ACTION = "carrier_bill" as const;

export type FedExBillingServiceHint = "Express" | "Ground" | "Freight" | "Unknown";

export interface FedExBillingPacketMeta {
    /** True when this email/attachment is a FedEx Billing Online carrier packet. */
    isPacket: boolean;
    /** Digits from filename (e.g. 939879901) when present. */
    invoiceDigitsFromFilename: string | null;
    /** Display invoice # preferred for Bill.com subject/filename. */
    invoiceNumberDisplay: string | null;
    serviceHint: FedExBillingServiceHint;
    /** Always false — full multi-page PDF must be forwarded. */
    mayTrimPages: false;
    /** Never run product-PO / Uline bas_freight apply on these. */
    skipProductPoMatch: true;
    reason: string;
}

/**
 * True when the sender is FedEx Billing Online (or generic FedEx invoice mail).
 * Past-due mail from billingonline@ is handled separately by vendor-router skip.
 */
export function isFedExBillingOnlineSender(from: string | null | undefined): boolean {
    const f = String(from || "").toLowerCase();
    if (!f.includes("fedex")) return false;
    // Past-due notices (no invoice PDF) — not a packet
    if (f.includes("billingonline@")) return false;
    return (
        f.includes("noreply@fedex")
        || f.includes("fedex.com")
        || f.includes("fedex billing")
    );
}

/**
 * Opaque FBO packet filename: 12.99999.{batch}.{invoiceDigits}.XXXXX{acct}.{seq}.pdf
 */
export function isFedExBillingPacketFilename(filename: string | null | undefined): boolean {
    const base = String(filename || "").trim().split(/[/\\]/).pop() || "";
    return FEDEX_BILLING_PACKET_FILENAME_RE.test(base);
}

/**
 * Extract bare invoice digit run from FBO filename (group 1).
 * e.g. 12.99999.10033.939879901.XXXXX5250.000030.pdf → "939879901"
 */
export function extractInvoiceDigitsFromFedExFilename(
    filename: string | null | undefined,
): string | null {
    const base = String(filename || "").trim().split(/[/\\]/).pop() || "";
    const m = base.match(FEDEX_BILLING_PACKET_FILENAME_RE);
    return m?.[1] ?? null;
}

/**
 * Format FBO digit run as display invoice # (9-398-79901 style when 9 digits).
 */
export function formatFedExInvoiceDisplay(digits: string | null | undefined): string | null {
    const d = String(digits || "").replace(/\D/g, "");
    if (!d) return null;
    if (d.length === 9) {
        return `${d.slice(0, 1)}-${d.slice(1, 4)}-${d.slice(4)}`;
    }
    return d;
}

/**
 * Pull invoice number from PDF text summary page when present.
 * Prefers "Invoice Number" + dashed form.
 */
export function extractFedExInvoiceNumberFromText(text: string | null | undefined): string | null {
    const t = String(text || "");
    const dashed = t.match(/Invoice\s*Number\s*[\n\r\s:]*([0-9]+-[0-9]+-[0-9]+)/i);
    if (dashed?.[1]) return dashed[1];
    const plain = t.match(/Invoice\s*Number\s*[\n\r\s:]*([0-9]{6,14})/i);
    if (plain?.[1]) return formatFedExInvoiceDisplay(plain[1]) || plain[1];
    return null;
}

/**
 * Extract the TOTAL THIS INVOICE amount from FedEx packet summary text.
 * Packet page 1 renders it as "TOTAL THIS INVOICEUSD$15,287.10" (no space
 * between INVOICE and USD). Returns the bare number or null when absent.
 */
export function extractFedExInvoiceTotal(text: string | null | undefined): number | null {
    const t = String(text || "");
    const m = t.match(/TOTAL\s+THIS\s+INVOICE\s*USD\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!m?.[1]) return null;
    const n = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function detectFedExBillingServiceHint(
    text: string | null | undefined,
    subject?: string | null,
): FedExBillingServiceHint {
    const blob = `${subject || ""}\n${text || ""}`;
    if (/FedEx\s+Freight/i.test(blob) || /\bFXFE\b|\bFXNL\b/i.test(blob)) return "Freight";
    if (/FedEx\s+Ground\s+Services/i.test(blob) || /Ground-Home Delivery|Ground-Prepaid/i.test(blob)) {
        return "Ground";
    }
    if (/FedEx\s+Express\s+Services/i.test(blob) || /FedEx\s+2Day/i.test(blob)) return "Express";
    if (/\bGround\b/i.test(blob) && !/\bExpress\b/i.test(blob)) return "Ground";
    if (/\bExpress\b/i.test(blob)) return "Express";
    return "Unknown";
}

/**
 * Email-level: FedEx Billing Online invoice notice (may attach 1–N packets).
 */
export function isFedExBillingOnlineEmail(
    from: string | null | undefined,
    subject: string | null | undefined,
    snippet?: string | null,
    pdfFilenames?: string[] | null,
): boolean {
    const names = pdfFilenames || [];
    if (names.some(isFedExBillingPacketFilename)) return true;
    if (!isFedExBillingOnlineSender(from)) return false;
    const subj = String(subject || "");
    const snip = String(snippet || "");
    return (
        /billing\s*online/i.test(subj)
        || /new\s+fedex.*invoice/i.test(subj)
        || (/\binvoice\b/i.test(subj) && /fedex/i.test(String(from || "")))
        || /billing\s*online/i.test(snip)
        || (/\binvoice\b/i.test(snip) && /fedex/i.test(snip))
    );
}

/**
 * Attachment-level decision for AP queue/forward.
 * mayTrimPages is always false — never single-page-trim FBO packets.
 */
export function classifyFedExBillingAttachment(args: {
    from?: string | null;
    subject?: string | null;
    snippet?: string | null;
    filename?: string | null;
    pdfTextPreview?: string | null;
}): FedExBillingPacketMeta {
    const filename = args.filename || "";
    const isName = isFedExBillingPacketFilename(filename);
    const isEmail = isFedExBillingOnlineEmail(
        args.from,
        args.subject,
        args.snippet,
        filename ? [filename] : [],
    );
    const isPacket = isName || (isEmail && /\.pdf$/i.test(filename));

    if (!isPacket) {
        return {
            isPacket: false,
            invoiceDigitsFromFilename: null,
            invoiceNumberDisplay: null,
            serviceHint: "Unknown",
            mayTrimPages: false,
            skipProductPoMatch: true,
            reason: "not_fedex_billing_packet",
        };
    }

    const digits = extractInvoiceDigitsFromFedExFilename(filename);
    const fromText = extractFedExInvoiceNumberFromText(args.pdfTextPreview);
    const display =
        fromText
        || formatFedExInvoiceDisplay(digits)
        || digits;

    return {
        isPacket: true,
        invoiceDigitsFromFilename: digits,
        invoiceNumberDisplay: display,
        serviceHint: detectFedExBillingServiceHint(args.pdfTextPreview, args.subject),
        mayTrimPages: false,
        skipProductPoMatch: true,
        reason: isName
            ? "fedex_billing_packet_filename"
            : "fedex_billing_online_email_pdf",
    };
}

/**
 * Clean Bill.com attachment name — full packet still attached; name is for humans/OCR.
 * Example: FedEx_Ground_9-398-79902.pdf
 */
export function buildFedExBillComFilename(
    meta: Pick<FedExBillingPacketMeta, "invoiceNumberDisplay" | "serviceHint">,
    originalFilename?: string | null,
): string {
    const inv = (meta.invoiceNumberDisplay || "unknown").replace(/[^\w.-]+/g, "_");
    const svc = meta.serviceHint && meta.serviceHint !== "Unknown" ? meta.serviceHint : "Invoice";
    const base = `FedEx_${svc}_${inv}.pdf`;
    if (/\.pdf$/i.test(base)) return base;
    const orig = String(originalFilename || "packet.pdf");
    return orig.toLowerCase().endsWith(".pdf") ? orig : `${orig}.pdf`;
}

/**
 * Queue extracted_json fields for identifier / forwarder.
 */
export function buildFedExCarrierBillQueueFields(meta: FedExBillingPacketMeta): Record<string, unknown> {
    return {
        vendor_routing_action: FEDEX_CARRIER_BILL_ACTION,
        fedex_billing_packet: true,
        fedex_may_trim_pages: false,
        skip_product_po_match: true,
        skip_uline_bas_freight: true,
        invoice_number: meta.invoiceNumberDisplay,
        fedex_service_hint: meta.serviceHint,
        fedex_packet_reason: meta.reason,
        completion_mode: "forward_success",
    };
}

/**
 * True when a queued row is a FedEx carrier bill (pay path, no PO freight).
 */
export function isFedExCarrierBillExtractedJson(
    extracted: Record<string, unknown> | null | undefined,
): boolean {
    if (!extracted || typeof extracted !== "object") return false;
    if (extracted.vendor_routing_action === FEDEX_CARRIER_BILL_ACTION) return true;
    if (extracted.fedex_billing_packet === true) return true;
    if (extracted.skip_product_po_match === true && extracted.fedex_may_trim_pages === false) {
        return true;
    }
    return false;
}
