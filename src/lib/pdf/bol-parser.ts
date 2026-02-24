import { z } from "zod";
import { unifiedObjectGeneration } from "../intelligence/llm";

export const BOLSchema = z.object({
    documentType: z.literal("bill_of_lading"),
    bolNumber: z.string(),
    proNumber: z.string().optional(),
    shipDate: z.string().optional(),
    deliveryDate: z.string().optional(),
    shipperName: z.string().optional(),
    shipperAddress: z.string().optional(),
    consigneeName: z.string().optional(),
    consigneeAddress: z.string().optional(),
    carrierName: z.string(),
    scacCode: z.string().optional(),     // Standard Carrier Alpha Code
    serviceType: z.string().optional(),     // LTL, FTL, etc.
    freightClass: z.string().optional(),
    pieces: z.number().optional(),
    weight: z.number().optional(),
    weightUnit: z.string().optional(),
    poNumbers: z.array(z.string()),
    invoiceNumbers: z.array(z.string()).optional(),
    commodities: z.array(z.object({
        description: z.string(),
        pieces: z.number().optional(),
        weight: z.number().optional(),
        freightClass: z.string().optional(),
        nmfc: z.string().optional(),
    })),
    specialInstructions: z.string().optional(),
    hazmat: z.boolean().default(false),
    confidence: z.enum(["high", "medium", "low"]),
});

export type BillOfLadingData = z.infer<typeof BOLSchema>;

const BOL_SYSTEM_PROMPT = `Extract all Bill of Lading data. Pay attention to:
- Both BOL number and PRO number (they are different — BOL is shipper-assigned, PRO is carrier-assigned)
- SCAC codes for carrier identification
- All PO numbers referenced (often multiple)
- Commodity descriptions and freight class
- Any hazmat declarations
`;

export async function parseBOL(rawText: string): Promise<BillOfLadingData> {
    return await unifiedObjectGeneration({
        system: BOL_SYSTEM_PROMPT,
        prompt: rawText.slice(0, 6000),
        schema: BOLSchema,
        schemaName: "BillOfLading"
    });
}
