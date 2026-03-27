import { z } from "zod";
import { unifiedObjectGeneration } from "../intelligence/llm";

export const LineItemSchema = z.object({
    lineNumber: z.coerce.number().nullable().optional(),
    sku: z.string().nullable().optional(),
    description: z.string().catch(""),
    qty: z.coerce.number().catch(0),
    unit: z.string().nullable().optional(),   // "EA", "LB", "BAG", "PALLET"
    unitPrice: z.coerce.number().catch(0),
    discount: z.coerce.number().nullable().optional(),
    total: z.coerce.number().catch(0),
    poLineRef: z.string().nullable().optional(),  // Reference back to PO line
});

export const InvoiceSchema = z.object({
    documentType: z.literal("invoice").default("invoice"),
    // .catch() on required fields: if model returns wrong type/value, use fallback instead of throw
    invoiceNumber: z.string().catch("UNKNOWN"),
    poNumber: z.string().nullable().optional(),
    orderNumber: z.string().nullable().optional(),
    vendorName: z.string().catch("UNKNOWN"),
    vendorAddress: z.string().nullable().optional(),
    vendorPhone: z.string().nullable().optional(),
    vendorEmail: z.string().nullable().optional(),
    vendorWebsite: z.string().nullable().optional(),
    billTo: z.string().nullable().optional(),
    shipTo: z.string().nullable().optional(),
    invoiceDate: z.string().catch(new Date().toISOString().split("T")[0]),  // YYYY-MM-DD
    dueDate: z.string().nullable().optional(),
    shipDate: z.string().nullable().optional(),
    paymentTerms: z.string().nullable().optional(),  // "Net 30", "2/10 Net 30", etc.
    lineItems: z.array(LineItemSchema).catch([]),
    subtotal: z.coerce.number().catch(0),
    freight: z.coerce.number().nullable().optional(),
    fuelSurcharge: z.coerce.number().nullable().optional(),
    tax: z.coerce.number().nullable().optional(),
    tariff: z.coerce.number().nullable().optional(),         // Duties, tariffs, import fees
    labor: z.coerce.number().nullable().optional(),          // Labor, handling, processing fees
    discount: z.coerce.number().nullable().optional(),
    total: z.coerce.number().catch(0),
    amountPaid: z.coerce.number().nullable().optional(),
    amountDue: z.coerce.number().catch(0),
    currency: z.string().nullable().optional(),
    trackingNumbers: z.array(z.string()).nullable().optional(),
    proNumber: z.string().nullable().optional(),  // LTL PRO number
    bolNumber: z.string().nullable().optional(),
    carrierName: z.string().nullable().optional(),
    remitTo: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    // Models sometimes return "HIGH"/"CERTAIN"/etc — catch maps any invalid value to "medium"
    confidence: z.enum(["high", "medium", "low"]).catch("medium"),
});

export type InvoiceData = z.infer<typeof InvoiceSchema>;

const INVOICE_SYSTEM_PROMPT = `You are a precise invoice data extractor for a purchasing and logistics system.
Extract ALL fields from the invoice with exact values — do not round or interpret amounts.

## Fee field mapping

**freight** — any freight, shipping, or delivery charge. Labels include: "Freight", "Frt", "Frt Chg", "Shipping", "Ship Chg", "S&H", "Delivery", "Delivery Charge", "Drayage", "Liftgate", "Residential Delivery", "Carrier Charge", "Alan to BAS". Sum all matching lines into the single freight field.

**fuelSurcharge** — any fuel or energy surcharge. Labels include: "Fuel Surcharge", "Fuel Adj", "Fuel Charge", "Energy Surcharge". If a fuel/energy charge is listed separately from freight, place it in fuelSurcharge; otherwise fold it into freight.

**tax** — any sales or use tax. Labels include: "Sales Tax", "CA Tax", "CO Tax", "State Tax", "Local Tax", "Use Tax", "VAT", "GST", "HST". Sum all tax lines into one value.

**tariff** — any import duty or tariff. Labels include: "Tariff", "Duties", "Import Fee", "Import Duty", "Customs", "CBP Fee", "Section 301", "Trade Duty", "HazMat", "Cold Chain Fee".

**labor** — any labor, handling, or processing charge. Labels include: "Labor", "Labour", "Handling", "Handling Charge", "Processing Fee", "Admin Fee", "Setup Charge", "Assembly Fee", "Palletizing", "Repack Fee".

**discount** — any order-wide discount, rebate, or credit. Labels include: "Discount", "Rebate", "Credit", "Volume Discount", "Promo", "Early Pay Discount", "Cash Discount", "Allowance". Extract as a positive number — the system will negate it when writing to Finale.

## Line item rules

**lineItems[].unitPrice** — always extract the FINAL unit price after any line-level discounts or promotions. If a line shows "Organic Compost $10.00/bag — Discount $1.00 → $9.00", extract unitPrice as 9.00, not 10.00. The invoice-level "discount" field is for order-wide discounts only.

**lineItems[].unit** — extract exactly as printed on the invoice. Common values: EA, EACH, LB, KG, G, OZ, CS, CASE, CASE/12, CASE/24, BAG, BAG/40, BAG/50, PALLET. If the unit implies a package size (e.g., "case of 12"), capture as "CASE/12". Always populate this field when a unit is visible.

## Other fields

- Payment terms: exact text as written (Net 30, 2/10 Net 30, Due on Receipt, etc.)
- PO numbers, order numbers, BOL numbers, PRO numbers, tracking numbers
- Ship-to vs bill-to addresses if different
- Due date: calculate from invoice date + terms if not explicitly stated

## Validation

After extraction, mentally verify: sum(lineItems[i].qty * lineItems[i].unitPrice) + freight + tax + tariff + labor + fuelSurcharge - discount should approximately equal total. If they do not balance, double-check your fee extractions before returning.
`;

// ── ULINE compact line-item parser (regex, zero LLM cost) ────────────────────
//
// ULINE PDFs use a compact format with no spaces between fields:
//   {qty}{2-letter-UOM}{SKU}{description}{unitPrice}{extPrice}
// e.g. "48RLS-15625INDUSTRIAL SECURITY TAPE9.50456.00"
//
// The description often starts with a number (box dimensions like "9 X 5 X 5"),
// which causes LLMs to absorb that digit into the SKU (e.g. S-4092 + "9..." → "S-40929").
//
// Strategy:
//   1. Anchor on item starts: /^\d+(RL|CT|EA|...)(S|H)-\d+/ at start of line
//   2. Collect the text block for each item (handles multi-line descriptions)
//   3. Extract extendedPrice from the end of the block (last decimal number)
//   4. unitPrice = extendedPrice / qty  (always exact — integer division)
//   5. LLM still handles header fields (invoice#, PO#, dates, totals)

const ULINE_UOM_RE = /^(\d+)(RL|CT|EA|BX|PK|CS|DZ|LB|PR|ST|BG|BD|CG|KT|SE)\s*((?:S|H)-(\d+))/i;
const ULINE_ITEM_START_RE = /^\d+(?:RL|CT|EA|BX|PK|CS|DZ|LB|PR|ST|BG|BD|CG|KT|SE)\s*(?:S|H)-\d+/i;

// Known ULINE-SKU → Finale-SKU cross-references for this account.
// Keyed by ULINE canonical SKU (e.g. "S-4551").
// resolveUlineSku() also tries progressively shorter digit prefixes, so you only
// need to list the canonical form — not every possible digit-bleed variant.
const ULINE_SKU_MAP: Record<string, string> = {
    "S-4551":   "ULS455",   // 30x15x15" corrugated box
    "S-15837B": "FJG101",
    "S-13505B": "FJG102",
    "S-13506B": "FJG103",
    "S-10748B": "FJG104",
    "S-12229":  "10113",
    "H-1621":   "Ho-1621",
};

/**
 * Resolve a (potentially digit-bloated) ULINE SKU to a Finale SKU.
 *
 * ULINE compact format glues qty+UOM+SKU+description with no spaces.
 * When a description starts with a digit (e.g. box dimensions "30 X 15 X 15"),
 * the greedy SKU regex absorbs those leading digits:
 *   S-4551 + "30..." → captured as S-455130
 *
 * Strategy: try progressively shorter digit prefixes until a ULINE_SKU_MAP entry
 * is found.  If nothing maps, return the raw (bloated) SKU — the reconciler's
 * substring Strategy 1b handles it for POs that already carry the correct SKU.
 */
function resolveUlineSku(rawSku: string): string {
    if (ULINE_SKU_MAP[rawSku]) return ULINE_SKU_MAP[rawSku];
    const prefix = rawSku.match(/^(?:S|H)-/)?.[0];
    if (!prefix) return rawSku;
    const digits = rawSku.slice(prefix.length);
    for (let len = digits.length - 1; len >= 3; len--) {
        const shorter = prefix + digits.slice(0, len);
        if (ULINE_SKU_MAP[shorter]) return ULINE_SKU_MAP[shorter];
    }
    return rawSku;
}

/**
 * Split the concatenated price block at the end of a ULINE line item.
 *
 * ULINE prints unit price and extended price in separate columns; the PDF
 * extractor concatenates them with no separator:
 *   "9.50456.00"   → unit=9.50,   ext=456.00
 *   ".51255.00"    → unit=0.51,   ext=255.00   (leading-decimal unit price)
 *   "1.993,980.00" → unit=1.99,   ext=3980.00  (thousands comma in ext)
 *   ".00 .00"      → unit=0.00,   ext=0.00     (free item, space-separated)
 *
 * Both prices always have exactly 2 decimal digits.  The split point is always
 * immediately after the first decimal's two decimal digits.
 */
function splitUlinePrices(priceBlock: string): { unitPrice: number; extendedPrice: number } {
    const s = priceBlock.trim();
    const dot1 = s.indexOf(".");
    if (dot1 === -1) return { unitPrice: 0, extendedPrice: 0 };
    const end1 = dot1 + 3;                              // dot + exactly 2 decimal digits
    const unitStr = s.slice(0, end1).trim();
    const extStr  = s.slice(end1).trim().replace(/,/g, "");
    return {
        unitPrice:     parseFloat(unitStr) || 0,
        extendedPrice: parseFloat(extStr)  || 0,
    };
}

function parseUlineLineItems(rawText: string): Array<{ sku: string; quantity: number; unitPrice: number; extendedPrice: number; description: string }> | null {
    // Only run for ULINE invoices
    if (!rawText.includes("uline.com") && !rawText.includes("ULINE")) return null;

    const lines = rawText.split("\n").map(l => l.trim()).filter(Boolean);

    // Collect item blocks: each block starts at a ULINE_ITEM_START_RE line
    // and ends just before the next such line (or SUB-TOTAL / AMOUNT DUE)
    const blocks: string[] = [];
    let current: string[] = [];
    let inItems = false;

    for (const line of lines) {
        const isItemStart = ULINE_ITEM_START_RE.test(line);
        const isEnd = /^(?:SUB-TOTAL|AMOUNT DUE|SUBTOTAL)/i.test(line);

        if (isItemStart) {
            if (current.length) blocks.push(current.join(" "));
            current = [line];
            inItems = true;
        } else if (inItems) {
            if (isEnd) {
                if (current.length) blocks.push(current.join(" "));
                break;
            }
            current.push(line);
        }
    }
    if (current.length && inItems) blocks.push(current.join(" "));
    if (!blocks.length) return null;

    const items: Array<{ sku: string; quantity: number; unitPrice: number; extendedPrice: number; description: string }> = [];

    for (const block of blocks) {
        const headMatch = block.match(ULINE_UOM_RE);
        if (!headMatch) continue;

        const qty    = parseInt(headMatch[1], 10);
        const rawSku = headMatch[3].toUpperCase();
        const sku    = resolveUlineSku(rawSku);

        // Price block: trailing run of digits, dots, commas, and spaces (handles ".51255.00" and ".00 .00")
        const priceBlockRaw = block.match(/([.\d, ]+)\s*$/)?.[1]?.trim();
        if (!priceBlockRaw) continue;
        const { unitPrice, extendedPrice } = splitUlinePrices(priceBlockRaw);

        // Description: text between end of SKU match and start of price block
        const afterSku    = block.slice(headMatch[0].length);
        const priceStart  = afterSku.lastIndexOf(priceBlockRaw);
        const description = (priceStart > 0 ? afterSku.slice(0, priceStart) : afterSku).trim();

        items.push({ sku, quantity: qty, unitPrice, extendedPrice, description });
    }

    return items.length ? items : null;
}

export async function parseInvoice(rawText: string, tables?: string[][]): Promise<InvoiceData> {
    // Pre-extract ULINE line items with regex before the LLM call (zero extra cost).
    // The LLM call below still handles all header fields.
    const ulineItems = parseUlineLineItems(rawText);

    // Provide both raw text and any extracted tables for best accuracy
    const tableContext = tables?.length
        ? `\n\nExtracted tables:\n${tables.map(t => t.join(" | ")).join("\n")}`
        : "";

    try {
        const data = await unifiedObjectGeneration({
            system: INVOICE_SYSTEM_PROMPT,
            prompt: `Invoice text:\n${rawText.slice(0, 20000)}${tableContext}`,
            schema: InvoiceSchema,
            schemaName: "Invoice"
        });

        // Override LLM line items with regex-parsed ones when available (more accurate)
        if (ulineItems) {
            (data as InvoiceData).lineItems = ulineItems.map(i => ({
                sku: i.sku,
                description: i.description,
                qty: i.quantity,
                unitPrice: i.unitPrice,
                total: i.extendedPrice,
            }));
        }

        return data as InvoiceData;
    } catch (err: any) {
        console.error("❌ parseInvoice failed even with fallback:", err.message);
        // Fallback to empty structure if everything fails
        return {
            documentType: "invoice",
            invoiceNumber: "error",
            vendorName: "error",
            invoiceDate: new Date().toISOString().split('T')[0],
            lineItems: [],
            subtotal: 0,
            total: 0,
            amountDue: 0,
            confidence: "low"
        } as unknown as InvoiceData;
    }
}
