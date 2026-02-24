import { z } from "zod";
import { unifiedObjectGeneration } from "../intelligence/llm";

export const LineItemSchema = z.object({
    lineNumber: z.number().optional(),
    sku: z.string().optional(),
    description: z.string(),
    qty: z.number(),
    unit: z.string().optional(),         // "EA", "LB", "BAG", "PALLET"
    unitPrice: z.number(),
    discount: z.number().optional(),
    total: z.number(),
    poLineRef: z.string().optional(),         // Reference back to PO line
});

export const InvoiceSchema = z.object({
    documentType: z.literal("invoice"),
    invoiceNumber: z.string(),
    poNumber: z.string().optional(),
    orderNumber: z.string().optional(),
    vendorName: z.string(),
    vendorAddress: z.string().optional(),
    vendorPhone: z.string().optional(),
    vendorEmail: z.string().optional(),
    vendorWebsite: z.string().optional(),
    billTo: z.string().optional(),
    shipTo: z.string().optional(),
    invoiceDate: z.string(),               // YYYY-MM-DD
    dueDate: z.string().optional(),
    shipDate: z.string().optional(),
    paymentTerms: z.string().optional(),    // "Net 30", "2/10 Net 30", etc.
    lineItems: z.array(LineItemSchema),
    subtotal: z.number(),
    freight: z.number().optional(),
    fuelSurcharge: z.number().optional(),
    tax: z.number().optional(),
    discount: z.number().optional(),
    total: z.number(),
    amountPaid: z.number().optional(),
    amountDue: z.number(),
    currency: z.string().default("USD"),
    trackingNumbers: z.array(z.string()).optional(),
    proNumber: z.string().optional(),     // LTL PRO number
    bolNumber: z.string().optional(),
    carrierName: z.string().optional(),
    remitTo: z.string().optional(),
    notes: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
});

export type InvoiceData = z.infer<typeof InvoiceSchema>;

const INVOICE_SYSTEM_PROMPT = `You are a precise invoice data extractor for a purchasing and logistics system.
Extract ALL fields from the invoice with exact values — do not round or interpret amounts.
Pay special attention to:
- Line items: every line including charges, fees, and credits
- Payment terms: exact text as written (Net 30, 2/10 Net 30, Due on Receipt, etc.)
- Any freight, fuel surcharge, or shipping charges as separate line items
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
            prompt: `Invoice text:\n${rawText.slice(0, 8000)}${tableContext}`,
            schema: InvoiceSchema,
            schemaName: "Invoice"
        });
        return data;
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
        } as InvoiceData;
    }
}
