/**
 * @file    src/lib/intelligence/ap/invoice-number.ts
 * @purpose Single shared subject/filename-first invoice-number derivation for
 *          the AP forward path. The weekly reconcile CLI derives the invoice
 *          number with the same precedence (Pro# > "Invoice# N" > FedEx
 *          9-xxx-xxxxx > alphanumeric ID > bare digits); this module carries
 *          the SAME rules so ap_local_forwards.ocr_invoice_number can be
 *          populated at forward time — even for dropship and FedEx carrier
 *          rows where the PO-match enrich path never runs.
 *
 *          Precedence mirrors src/cli/reconcile-billcom.ts deriveInvoice():
 *            0.   Subject Pro#          (AAA Cooper scans: OCR grabs 3746570)
 *            0.5  Subject "Invoice# N"  (subject states it — OCR grabs a PO#)
 *            1.   FedEx 9-454-04878     (from subject OR filename)
 *            2.   APUS-247442 / INV12928 style alphanumeric ID
 *            3.   Keyword "Invoice 135879" / Inv_150000 / Facture
 *
 *          The bare long-digit fallback from the CLI is intentionally EXCLUDED
 *          here: it false-positives on dates ("Benny_09092026") and order
 *          ids. Consumers that need maximum recall (the reconcile CLI) keep
 *          their own richer haystack logic.
 *
 * @author  Hermia
 * @created 2026-09-17
 * @deps    none
 * @env     none
 */

/** Result of a confident derivation. Null when nothing reliable matched. */
export function deriveInvoiceNumberFromSubject(
    subject: string | null | undefined,
    filename?: string | null,
): string | null {
    const subj = String(subject || "");
    const file = String(filename || "");

    // 0. Subject Pro# — authoritative for AAA Cooper scans (OCR grabs the
    //    account/shipper number from the PDF body instead).
    const pro = subj.match(/\bPro#?:?\s*(\d{6,10})\b/i);
    if (pro) return pro[1];

    // 0.5 Subject explicit "Invoice# N" — authoritative when the subject
    //     states the number ("Concentrates, Inc - Invoice# 3084520").
    const subjInv = subj.match(/\b(?:invoice|inv|facture)\s*[#:._-]*\s*(\d[A-Za-z0-9-]{2,})/i);
    if (subjInv) return subjInv[1];

    const hay = [subj, file].filter(Boolean).join(" | ");

    // 1. FedEx billing: 9-454-04878 (dashed, tolerant boundaries).
    const fedex = hay.match(/(?<![A-Za-z0-9])\d-\d{3}-\d{5}(?![A-Za-z0-9])/);
    if (fedex) return fedex[0];

    // 2. APUS-247442 / INV12928 style alphanumeric ID — case-SENSITIVE prefix:
    //    real invoice IDs are uppercase; case-insensitivity would match scan
    //    filenames like "Benny_09092026" (a date).
    const alpha = hay.match(/(?<![A-Za-z0-9])[A-Z]{2,6}[-_]?\d{4,8}(?![A-Za-z0-9])/);
    if (alpha) return alpha[0];

    // 3. Keyword form anywhere in subject/filename: "Invoice 135879",
    //    "Inv_150000", "Facture 2025-001".
    const kw = hay.match(/\b(?:invoice|inv|facture|n[ºo])\s*[:#._-]*\s*(\d[A-Za-z0-9-]{2,})/i);
    if (kw) return kw[1];

    return null;
}
