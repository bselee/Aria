/**
 * @file    invoice-overlay.ts
 * @purpose Stamp a reliable invoice number onto a PDF copy before it is
 *          forwarded to Bill.com. Bill.com's OCR routinely reads AAA Cooper's
 *          CUSTOMER/account number ("1159492", "3746570") instead of the
 *          PRO NUMBER, producing bills keyed on the wrong identifier.
 *
 *          The stamped number is drawn as real embedded HelveticaBold text
 *          (the scanned AAA Cooper PDFs have ZERO text layer — the stamp is
 *          the only machine-readable text in the document). Placement is
 *          template-aware: for AAA Cooper it sits immediately right of the
 *          "INVOICE" title in the header band, sized to look like it belongs
 *          (Bill, 2026-08-18: "next to invoice at the top, looks like it was
 *          meant to be there").
 *
 *          WHY NOT JUST RENAME: the filename does not influence Bill.com's
 *          PDF content extraction; only the page content does.
 * @author  Hermia
 * @created 2026-08-18
 * @deps    pdf-lib
 * @env     none
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Senders whose PDFs get the invoice# stamp (matched against the raw From
 * header). AAA Cooper is the known offender: subject carries the real Pro#
 * ("Invoice Stmt - Cust 0001159492 Pro#: 64058435") but the scanned PDF body
 * OCRs to the customer/account number. Add other vendors here if their PDFs
 * mis-OCR.
 */
export const STAMP_INVOICE_SENDER_PATTERNS: RegExp[] = [/aaacooper/i];

/** Where to draw the stamp on page 1 (pdf-lib origin = bottom-left). */
interface StampPlacement {
    /** Left edge of the text, in points from the page left edge. */
    x: number;
    /** Baseline, in points measured DOWN from the page top edge. */
    yFromTop: number;
    /** Font size in points. */
    size: number;
    /** Text prefix before the number. Templates whose own title already says
     *  "INVOICE" only need "# "; generic placement self-labels. */
    prefix: string;
}

/**
 * Per-sender template placements. Measured deterministically at 600 DPI on the
 * real AAA Cooper header (614.39 x 781.2 pt page): the "INVOICE" title ink
 * band runs x≈398.9-467.4, y≈0.2-13.1 from top (baseline ≈13-14.5). The
 * stamp sits right of it at the same baseline, 14pt — same weight as the
 * title — reading "INVOICE # 64058435" as one line (title + "# <num>").
 */
const STAMP_PLACEMENTS: Array<{ match: RegExp; placement: StampPlacement }> = [
    {
        match: /aaacooper/i,
        placement: { x: 473, yFromTop: 14.5, size: 14, prefix: "# " },
    },
];

/** Fallback: top-right corner of page 1 — safe, out of any header content. */
const DEFAULT_PLACEMENT: StampPlacement = { x: 0, yFromTop: 30, size: 12, prefix: "INVOICE # " };

function placementForSender(from: string | null | undefined): StampPlacement {
    const f = String(from || "").toLowerCase();
    for (const entry of STAMP_PLACEMENTS) {
        if (entry.match.test(f)) return entry.placement;
    }
    return DEFAULT_PLACEMENT;
}

/** Stamp content for one invoice. */
export interface InvoiceStamp {
    invoiceNumber: string;
    vendorName?: string | null;
}

/**
 * True when this sender's PDF should be stamped before the Bill.com forward.
 * Requires BOTH a known stamp vendor AND a clean invoice number — never stamp
 * an invoice number we are not sure about.
 *
 * @param from           raw Gmail From header
 * @param invoiceNumber  subject-derived invoice number ("" when unknown)
 */
export function shouldStampInvoice(
    from: string | null | undefined,
    invoiceNumber?: string | null,
): boolean {
    const f = String(from || "").toLowerCase();
    if (!STAMP_INVOICE_SENDER_PATTERNS.some((re) => re.test(f))) return false;
    const inv = String(invoiceNumber || "").trim();
    return inv.length > 0 && !/^(unknown|n\/?a|na|none)$/i.test(inv);
}

/**
 * Clean attachment name for a stamped invoice: "<inv#>_<vendor>.pdf".
 * Keeps humans and downstream filename readers on the right number.
 */
export function buildStampedFilename(
    invoiceNumber: string,
    vendorName?: string | null,
): string {
    const inv = String(invoiceNumber || "").replace(/[^\w.-]+/g, "_").slice(0, 60);
    const vendor = String(vendorName || "invoice").replace(/[^\w.-]+/g, "_").slice(0, 40);
    return `${inv}_${vendor}.pdf`;
}

/**
 * Stamp the invoice number onto page 1 of a copy of the PDF.
 *
 * Text reads "INVOICE # <number>" in one string so any extractor (text-layer
 * or OCR of the rendered page) sees the canonical label+value pair. Placement
 * is per-sender (AAA Cooper: right of the "INVOICE" title in the header
 * band). Returns a NEW buffer; the input is untouched.
 *
 * On any load/save failure the caller should forward the ORIGINAL buffer —
 * a stamp must never block a bill from reaching Bill.com.
 *
 * @param buffer  original PDF bytes
 * @param stamp   invoice number (required), vendor (used for the filename)
 * @param from    raw From header — selects the placement template
 * @returns stamped PDF bytes
 */
export async function stampInvoicePdf(
    buffer: Buffer,
    stamp: InvoiceStamp,
    from?: string | null,
): Promise<Buffer> {
    const pdf = await PDFDocument.load(buffer);
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const pages = pdf.getPages();
    if (pages.length === 0) return buffer;
    const page = pages[0];
    const { width, height } = page.getSize();
    const placement = placementForSender(from);

    const text = `${placement.prefix}${stamp.invoiceNumber.trim()}`;
    const textWidth = font.widthOfTextAtSize(text, placement.size);
    // DEFAULT_PLACEMENT.x === 0 → right-align in the top-right corner.
    const x = placement.x > 0 ? placement.x : Math.max(10, width - textWidth - 12);
    const y = height - placement.yFromTop;

    page.drawText(text, {
        x,
        y,
        size: placement.size,
        font,
        color: rgb(0, 0, 0),
    });

    const bytes = await pdf.save();
    return Buffer.from(bytes);
}
