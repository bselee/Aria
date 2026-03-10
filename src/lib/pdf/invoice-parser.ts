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

export async function parseInvoice(rawText: string, tables?: string[][]): Promise<InvoiceData> {
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
