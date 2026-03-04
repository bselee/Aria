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
Pay special attention to:
- Line items: every line including charges, fees, and credits
- Payment terms: exact text as written (Net 30, 2/10 Net 30, Due on Receipt, etc.)
- Any freight, fuel surcharge, or shipping charges as separate line items
- Tariffs, duties, import fees — extract as the "tariff" field
- Labor, handling, or processing charges — extract as the "labor" field
- PO numbers, order numbers, BOL numbers, PRO numbers, tracking numbers
- Ship-to vs bill-to addresses if different
- Due date: calculate from invoice date + terms if not explicitly stated
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
