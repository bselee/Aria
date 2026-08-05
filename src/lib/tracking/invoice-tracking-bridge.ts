/**
 * @file    invoice-tracking-bridge.ts
 * @purpose Workstream 2 (2026-08-05): Bridge tracking numbers found in invoice
 *          PDF/email OCR text to shipments linked to open POs.
 *
 *          vendor_invoices stays the money ledger; shipments stays the movement
 *          ledger. This module only writes to `shipments` via
 *          upsertShipmentEvidence, tagging evidence with the invoice source so
 *          Active Purchases can show a trustworthy PO → tracking → invoice story.
 *
 * @design  Plan: docs/plans/2026-08-05-po-tracking-invoice-correlation.md (WS2)
 *          1. extractTrackingNumbers(ocrText) + LTL carrier detect from text
 *          2. Resolve PO: prefer args.poNumber → extract from OCR → null
 *             (null PO still stores tracking; Active Purchases shows unlinked)
 *          3. For each hit: upsertShipmentEvidence with source tag
 *             (ap_invoice | default_paid_invoice | bol_pdf), confidence
 *             0.92 when PO linked, 0.75 when orphan.
 * @deps    @/lib/carriers/tracking-service (extractTrackingNumbers, detectLTLCarrier)
 *          @/lib/tracking/shipment-intelligence (upsertShipmentEvidence)
 */

import {
    extractTrackingNumbers,
    detectLTLCarrier,
} from "@/lib/carriers/tracking-service";
import {
    upsertShipmentEvidence,
    normalizePoString,
} from "@/lib/tracking/shipment-intelligence";

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type InvoiceTrackingSource = "ap_invoice" | "default_paid_invoice" | "bol_pdf";

export interface BridgeInvoiceTrackingArgs {
    /** Full OCR/body text from the invoice PDF or email. */
    ocrText: string;
    /** PO number parsed from the invoice (may be null). Preferred over OCR extraction. */
    poNumber: string | null;
    vendorName: string | null;
    invoiceNumber: string | null;
    source: InvoiceTrackingSource;
    /** Gmail message id or vendor_invoice id — provenance for the evidence ref. */
    sourceRef: string;
}

export interface BridgeInvoiceTrackingResult {
    /** Number of shipment rows upserted (one per unique tracking hit). */
    upserted: number;
    /** Tracking numbers upserted (LTL encoded as Carrier:::PRO). */
    trackingNumbers: string[];
}

const PO_CONFIDENCE = 0.92;
const NO_PO_CONFIDENCE = 0.75;

// ──────────────────────────────────────────────────
// PO EXTRACTION (OCR fallback)
// ──────────────────────────────────────────────────

/**
 * Extract a PO number from free OCR text. Mirrors email-tracking-ingest's
 * extractPONumbersFromText conventions: standard "PO #124833" / "PO-124833" /
 * "Purchase Order 124833" refs first, then Finale vendor-ref format
 * "71473626-1124833" (last 6 digits = PO).
 */
export function extractPONumberFromText(text: string): string | null {
    if (!text) return null;

    const poRef = text.match(
        /(?:PO|P\.?\s*O\.?|Purchase\s+Order|ORDER)\s*[-#:.]*\s*(\d{5,7})\b/i,
    );
    if (poRef) return poRef[1];

    // Finale vendor-ref: "71473626-1124833" → PO 124833
    const vendorRef = text.match(/\b\d{7,10}-(\d{6})\b/);
    if (vendorRef) return vendorRef[1];

    return null;
}

// ──────────────────────────────────────────────────
// LTL ENCODING
// ──────────────────────────────────────────────────

/** True when a tracking hit is LTL-shaped (PRO / freight digits, optional dash suffix). */
export function isLtlShapedNumber(trackingNumber: string): boolean {
    return /^\d{7,15}$/.test(trackingNumber) || /^\d{6,15}-\d{1,3}$/.test(trackingNumber);
}

// ──────────────────────────────────────────────────
// MAIN BRIDGE
// ──────────────────────────────────────────────────

/**
 * Bridge tracking numbers found in invoice OCR/body text to shipments.
 *
 * Best-effort by design: per-hit failures are logged and skipped; callers
 * wrap the whole call in try/catch so the Bill.com forward path never breaks
 * if this bridge fails.
 */
export async function bridgeInvoiceTrackingToShipments(
    args: BridgeInvoiceTrackingArgs,
): Promise<BridgeInvoiceTrackingResult> {
    const ocrText = (args.ocrText || "").trim();
    if (!ocrText) {
        return { upserted: 0, trackingNumbers: [] };
    }

    // 1. Ranked, context-aware tracking extraction + LTL carrier detection.
    const extracted = extractTrackingNumbers(ocrText);
    const ltlCarrier = detectLTLCarrier(ocrText);

    if (extracted.length === 0) {
        return { upserted: 0, trackingNumbers: [] };
    }

    // 2. Resolve PO: explicit invoice parse wins, then OCR, then null (orphan-safe).
    const poNumber =
        normalizePoString(args.poNumber) ||
        extractPONumberFromText(ocrText) ||
        null;
    const confidence = poNumber ? PO_CONFIDENCE : NO_PO_CONFIDENCE;

    // 3. Upsert each unique hit. When an LTL carrier is detected in the text
    //    AND the number is PRO-shaped, encode "Carrier:::PRO" so carrierUrl /
    //    LTL status scraping work (matches email-tracking-ingest encoding).
    const trackingNumbers: string[] = [];
    let upserted = 0;

    for (const hit of extracted) {
        const trackingNumber =
            ltlCarrier && isLtlShapedNumber(hit.trackingNumber)
                ? `${ltlCarrier}:::${hit.trackingNumber}`
                : hit.trackingNumber;

        try {
            const record = await upsertShipmentEvidence({
                trackingNumber,
                poNumber,
                vendorName: args.vendorName,
                source: args.source,
                sourceRef: args.sourceRef,
                confidence,
            });
            if (record) {
                upserted++;
                trackingNumbers.push(record.tracking_number || trackingNumber);
            }
        } catch (err: any) {
            console.warn(
                `[invoice-tracking-bridge] upsert failed for ${trackingNumber} ` +
                `(source=${args.source} ref=${args.sourceRef}): ${err?.message || err}`,
            );
        }
    }

    if (upserted > 0) {
        console.log(
            `[invoice-tracking-bridge] Linked ${upserted} tracking number(s) ` +
            `[${trackingNumbers.join(", ")}] → PO ${poNumber || "(unlinked)"} ` +
            `(vendor=${args.vendorName || "?"} source=${args.source} ref=${args.sourceRef})`,
        );
    }

    return { upserted, trackingNumbers };
}
