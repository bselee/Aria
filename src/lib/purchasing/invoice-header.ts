/**
 * @file    invoice-header.ts
 * @purpose Parse the header block of a vendor invoice PDF (Customer PO No.,
 *          Order No., Payment Terms, Ship Via, Shipping Terms, and the amount
 *          block) and classify who pays freight for that shipment.
 *
 *          Why this exists: vendors such as Stock Bag Depot ship on FEDEX-GND
 *          but the invoice's *Shipping Terms* decides who pays — CIP / "Free
 *          Freight" means the vendor absorbs it (nothing to add), PPD-ADD means
 *          the vendor prepaid and billed it to us (add that Shipping Amount to
 *          the PO as a Freight line), COLLECT means our carrier account pays
 *          (the charge arrives on the carrier bill, not the invoice).
 *
 *          The invoice amount is the authority on what we were charged; the
 *          printed PO number is a hint (a vendor can print the wrong one), so
 *          callers must confirm it against the invoice's goods amount.
 *
 * @author  Hermia
 * @created 2026-10-07
 * @deps    none (pure)
 * @env     none
 */

/** Shipping terms that mean the seller contracts and pays carriage to our door. */
const SELLER_PAYS = /^(CIP|CPT|DAP|DDP|FOB\s*DEST)/i;
/** Prepaid & add: seller prepays carriage and adds it to our invoice. */
const PREPAID_ADD = /(?:^|[^A-Z])PPD[\s-]*ADD|PREPAID\s*(?:AND|&)\s*ADD|FREIGHT\s*ADD/i;
/** Collect / third-party: our account is billed by the carrier. */
const COLLECT = /COLLECT|3RD\s*PARTY|THIRD\s*PARTY|BILL\s*TO\s*(?:3RD|THIRD|RECIPIENT)/i;
/** Vendor line/marker stating freight is free on the shipment. */
const FREE_FREIGHT_MARKER = /F-FREESHIP|FREE\s+FREIGHT|FREE\s+SHIPPING|NO\s+CHARGE/i;

/** Who is expected to pay the carriage on this shipment. */
export type FreightPayer = "vendor_free" | "vendor_charged" | "bas_collect" | "unknown";

/** Fields parsed from the invoice header. Money is USD; 0 when the field is blank. */
export interface VendorInvoiceHeader {
    invoiceNumber: string | null;
    invoiceDate: string | null;
    /** PO number the vendor printed under "Customer PO No." (a hint, may be wrong). */
    statedPo: string | null;
    /** The vendor's own order number (e.g. Stock Bag "Order No. 113434"). */
    orderNumber: string | null;
    paymentTerms: string | null;
    shipVia: string | null;
    shippingTerms: string | null;
    /** Goods amount ("Sales Amount"). */
    salesAmount: number;
    /** Amount the vendor charged us for carriage ("Shipping Amount"); 0 when blank. */
    shippingAmount: number;
    salesTax: number;
    invoiceDiscount: number;
    /** Printed total invoice amount (0 when the vendor leaves it blank). */
    total: number;
    /** True when the invoice prints a free-shipping marker/line. */
    freeFreightMarker: boolean;
    /** The "Order Notes" text, e.g. "CCx 3526 | Card on file / Free Freight to mtch online". */
    orderNotes: string | null;
}

function money(raw: string | undefined): number {
    if (!raw) return 0;
    const n = Number(String(raw).replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : 0;
}

/**
 * Read a labelled money value that may sit on the same line as its label or on
 * the line below it (Stock Bag prints values that way). Returns 0 when blank.
 *
 * @param text  Whitespace-preserving invoice text.
 * @param label Label to look for, e.g. "Shipping Amount".
 */
function labelledMoney(text: string, label: string): number {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Same line: label, then at most a short run of non-digit/non-newline chars, then the value.
    const sameLine = new RegExp(esc + "[^\\n\\d$()]{0,20}(?:\\(?\\s*\\$?\\s*([\\d,]+\\.\\d{2})\\)?)?", "i").exec(text);
    if (sameLine?.[1]) return money(sameLine[1]);
    // Value on the next line(s): take a bounded window after the label and stop
    // at the next known amount label so a blank field cannot pick up a neighbour.
    const idx = text.search(new RegExp(esc, "i"));
    if (idx >= 0) {
        let window = text.slice(idx + label.length, idx + label.length + 140);
        const stop = window.search(/\n[^\n]{0,40}(?:Sales Amount|Invoice Discount|Sales Tax|Shipping Amount|Total Invoice Amount|Payment\/Credit Applied)/i);
        if (stop > 0) window = window.slice(0, stop);
        const m = /\(?\s*\$?\s*([\d,]+\.[\d]{2})\)?/.exec(window);
        if (m) return money(m[1]);
    }
    return 0;
}

/**
 * Parse the header block of a vendor invoice.
 *
 * @param raw Whitespace-preserving text extracted from the invoice PDF.
 * @returns   Parsed header; missing fields are null / 0.
 */
export function parseVendorInvoiceHeader(raw: string): VendorInvoiceHeader {
    const text = raw.replace(/\r/g, "");

    const invoiceNumber =
        /INVOICE\s*#?\s*(\d{5,})/i.exec(text)?.[1] ||
        /Invoice\s*No\.?\s*:?\s*(\d{5,})/i.exec(text)?.[1] ||
        null;
    const invoiceDate = /Invoice\s*Date\s*:?\s*([\d/]{6,10})/i.exec(text)?.[1] || null;

    // The data row under the "Customer PO No. | Payment Terms | Ship Via |
    // Shipping Terms | Order No." header. Vendors print
    // "PO <n>  <payment-terms>  <ship-via>  <shipping-terms>  <order-no>",
    // spaced by columns (wide) or single spaces. Split on column gaps first,
    // then fall back to single spaces.
    // Vendors print our PO as "PO 125014", "PO125014", or "BASPO 123979" (a
    // "BAS" prefix). Anchor on the line and require the digits so the
    // "Customer PO No." label line never matches.
    const rowLine = /^[ \t]*(?:BAS)?[ \t]*PO[ \t]*(\d{5,7})(?!\d)(.*)$/m.exec(text);
    let statedPo: string | null = null;
    let paymentTerms: string | null = null;
    let shipVia: string | null = null;
    let shippingTerms: string | null = null;
    let orderNumber: string | null = null;
    if (rowLine) {
        statedPo = rowLine[1];
        const rest = rowLine[2].trim();
        // Column layout (pdftotext -layout): fields separated by runs of spaces.
        let tokens = rest.split(/[ \t]{2,}/).map((t) => t.trim()).filter(Boolean);
        if (tokens.length < 4) tokens = rest.split(/\s+/).filter(Boolean);
        if (tokens.length >= 3 && /^\d{4,9}$/.test(tokens[tokens.length - 1])) {
            orderNumber = tokens.pop()!;
        }
        if (tokens.length >= 3) {
            paymentTerms = tokens[0] || null;
            shipVia = tokens[1] || null;
            shippingTerms = tokens.slice(2).join(" ").trim() || null;
        } else {
            // Jammed columns (pdf-parse reading order, e.g.
            // "PBS-CARDFEDEX-GNDPPD-ADD113179"): pull each field by its token shape.
            let stem = rest;
            const trailing = /(\d{4,9})\s*$/.exec(stem);
            if (trailing) {
                orderNumber = trailing[1];
                stem = stem.slice(0, trailing.index);
            }
            shipVia = /((?:FEDEX|UPS|USPS|DHL)-[A-Z0-9]{2,10}?(?=PPD|COLLECT|CIP|CPT|DAP|DDP|PREPAID|PREPAY|NET|CARD|\d|$))/i.exec(stem)?.[1]?.toUpperCase() || null;
            if (!shipVia) shipVia = /(OLD\s*DOMIN[A-Z\-]*)/i.exec(stem)?.[1]?.toUpperCase() || null;
            shippingTerms = /(PPD-?ADD|COLLECT|CIP|CPT|DAP|DDP|FOB\s*DEST|PREPAID|PREPAY)/i.exec(stem)?.[1]?.toUpperCase() || null;
            paymentTerms = /(PBS-?CARD|NET\s*\d+|CARD|CREDIT\s*CARD|CC)/i.exec(stem)?.[1] || null;
        }
    }

    const salesAmount = labelledMoney(text, "Sales Amount");
    const shippingAmount = labelledMoney(text, "Shipping Amount");
    const salesTax = labelledMoney(text, "Sales Tax");
    const invoiceDiscount = labelledMoney(text, "Invoice Discount");
    const total = labelledMoney(text, "Total Invoice Amount");

    const freeFreightMarker = FREE_FREIGHT_MARKER.test(text);
    const orderNotes = (/Order\s*Notes\s*:\s*\n?\s*([^\n]+)/i.exec(text)?.[1] || "").trim() || null;

    return {
        invoiceNumber,
        invoiceDate,
        statedPo,
        orderNumber,
        paymentTerms,
        shipVia,
        shippingTerms,
        salesAmount,
        shippingAmount,
        salesTax,
        invoiceDiscount,
        total,
        freeFreightMarker,
        orderNotes,
    };
}

/** Threshold below which a printed shipping figure is a marker, not a real charge. */
export const FREIGHT_CHARGE_FLOOR = 0.5;

/**
 * Decide who pays carriage for the shipment, from the invoice's own fields.
 *
 * `vendor_charged` carries the amount to put on the PO as a Freight line.
 * `vendor_free` and `bas_collect` carry no amount here (0); `bas_collect` is
 * priced later from the carrier bill.
 *
 * The freight figure is derived arithmetically — `total − (sales − discount) −
 * tax` — because the printed "Shipping Amount" column bleeds onto the sales
 * value in some PDF layouts (a blank shipping cell reads back as the sales
 * amount). A raw read that equals or exceeds sales is that artifact, not freight.
 *
 * @param h Parsed invoice header.
 * @returns Who pays, and the amount the invoice itself bills for carriage.
 */
export function classifyInvoiceFreight(h: VendorInvoiceHeader): { payer: FreightPayer; amount: number } {
    const terms = `${h.shippingTerms || ""} ${h.orderNotes || ""}`;
    const collect = COLLECT.test(terms);
    const free = h.freeFreightMarker || SELLER_PAYS.test(h.shippingTerms || "");

    const derived = Math.round((h.total - (h.salesAmount - h.invoiceDiscount) - h.salesTax) * 100) / 100;
    const rawBleed = Math.abs(h.shippingAmount - h.salesAmount) < 0.01 || h.shippingAmount >= h.salesAmount;
    let amount = 0;
    if (!free && !collect) {
        if (derived > FREIGHT_CHARGE_FLOOR) amount = derived;
        else if (!rawBleed && h.shippingAmount > FREIGHT_CHARGE_FLOOR) amount = h.shippingAmount;
    }

    if (PREPAID_ADD.test(terms)) return { payer: "vendor_charged", amount };
    if (collect) return { payer: "bas_collect", amount: 0 };
    if (h.freeFreightMarker || SELLER_PAYS.test(h.shippingTerms || "")) return { payer: "vendor_free", amount: 0 };
    if (amount > 0) return { payer: "vendor_charged", amount };
    return { payer: "unknown", amount: 0 };
}
