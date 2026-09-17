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
 * A white-out region on page 1 (top-left origin). Used to redact the
 * CUSTOMER NUMBER (account/customer id) that Bill.com's OCR otherwise reads
 * as the invoice number. Bill.com keys on the labeled "CUSTOMER NUMBER" field
 * — even after the invoice# stamp is added — so the contaminant number must be
 * physically removed. Each box is drawn as a solid white rectangle.
 */
interface RedactionBox {
    /** Left edge, points from the page left edge. */
    x1: number;
    /** Top edge, points measured DOWN from the page top edge. */
    yTop1: number;
    /** Right edge, points from the page left edge. */
    x2: number;
    /** Bottom edge, points measured DOWN from the page top edge. */
    yTop2: number;
}

export type { RedactionBox };

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

/**
 * Per-sender white-out boxes (top-left origin, points) for the CUSTOMER
 * NUMBER / account id that Bill.com's OCR mis-reads as the invoice number.
 * Measured deterministically via tesseract at 600 DPI on the real AAA Cooper
 * header (614.39 x 781.2 pt page). The customer number "1159492" appears in
 * FOUR places — the header "CUSTOMER NUMBER" cell, the "BILL TO" block, the
 * footer "Stmt Id:DLO…01159492" line, and the bottom tracking code. All four
 * must be whited out so Bill.com keys on the stamped invoice# instead.
 *
 * Never touch the Pro# "64058449" — it appears in the INVOICE # stamp
 * (x≈485-546, yTop≈4-15), the PRO NUMBER cell (x≈490-529, yTop≈35-42), and
 * the footer PRO NUMBER (x≈440-479, yTop≈746-753); the boxes below are clear
 * of all three.
 */
const REDACTION_BOXES: Array<{ match: RegExp; boxes: RedactionBox[] }> = [
    {
        match: /aaacooper/i,
        boxes: [
            // Header "CUSTOMER NUMBER" value 1159492
            { x1: 356, yTop1: 31, x2: 400, yTop2: 45 },
            // "BILL TO" customer number 1159492 (left of the merged "1159492DATE")
            { x1: 492, yTop1: 54, x2: 538, yTop2: 68 },
            // Footer "Stmt Id:DLO…01159492" numeric tail
            { x1: 247, yTop1: 765, x2: 342, yTop2: 777 },
            // Bottom tracking code "0001159492" tail ("159492" segment)
            { x1: 53, yTop1: 773, x2: 73, yTop2: 782 },
        ],
    },
];

function redactionBoxesForSender(from: string | null | undefined): RedactionBox[] {
    const f = String(from || "").toLowerCase();
    for (const entry of REDACTION_BOXES) {
        if (entry.match.test(f)) return entry.boxes;
    }
    return [];
}

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
    opts?: {
        /** OCR-located contaminant boxes (plan 4.3) — merged with the static template boxes. */
        extraRedactionBoxes?: RedactionBox[];
    },
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

    // Redact the customer/account number first so Bill.com's OCR can't read it
    // as the invoice number. White boxes are drawn before the stamp text.
    // OCR-located boxes (anchor-relative, plan 4.3) are drawn alongside the
    // static template boxes — belt and suspenders: a template shift that moves
    // the contaminant out from under the static boxes is still covered by the
    // OCR hit, and a missed OCR hit is still covered by the static template.
    const dynamicBoxes = opts?.extraRedactionBoxes ?? [];
    for (const box of [...dynamicBoxes, ...redactionBoxesForSender(from)]) {
        page.drawRectangle({
            x: box.x1,
            y: height - box.yTop2,
            width: box.x2 - box.x1,
            height: box.yTop2 - box.yTop1,
            color: rgb(1, 1, 1),
            borderColor: rgb(1, 1, 1),
            borderWidth: 0,
        });
    }

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
