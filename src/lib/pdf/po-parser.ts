import { z } from "zod";
import { getAnthropicClient } from "../anthropic";

export const POLineItemSchema = z.object({
    lineNumber: z.number(),
    sku: z.string().optional(),
    description: z.string(),
    qtyOrdered: z.number(),
    qtyReceived: z.number().default(0),
    qtyPending: z.number().optional(),
    unit: z.string().optional(),
    unitPrice: z.number(),
    total: z.number(),
    needByDate: z.string().optional(),
    notes: z.string().optional(),
});

export const PurchaseOrderSchema = z.object({
    documentType: z.literal("purchase_order"),
    poNumber: z.string(),
    revision: z.string().optional(),
    status: z.enum(["draft", "sent", "acknowledged", "partial", "received", "closed"]).default("sent"),
    vendorName: z.string(),
    vendorCode: z.string().optional(),
    shipTo: z.string().optional(),
    billTo: z.string().optional(),
    issueDate: z.string(),
    requiredDate: z.string().optional(),
    shipVia: z.string().optional(),
    fob: z.string().optional(),
    paymentTerms: z.string().optional(),
    lineItems: z.array(POLineItemSchema),
    subtotal: z.number(),
    freight: z.number().optional(),
    tax: z.number().optional(),
    total: z.number(),
    notes: z.string().optional(),
    authorizedBy: z.string().optional(),
    confidence: z.enum(["high", "medium", "low"]),
});

export type POData = z.infer<typeof PurchaseOrderSchema>;

export async function parsePurchaseOrder(rawText: string): Promise<POData> {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: `Extract purchase order data. Return only valid JSON. Be precise with line item quantities and prices. Include all line items even if they span multiple pages.`,
        messages: [{
            role: "user",
            content: rawText.slice(0, 8000),
        }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "{}";
    return PurchaseOrderSchema.parse(JSON.parse(text.replace(/```json\n?|\n?```/g, "").trim()));
}
