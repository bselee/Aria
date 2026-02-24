import { DocumentType } from "@/types/documents";
import { PDFExtractionResult } from "./extractor";
import { unifiedObjectGeneration } from "../intelligence/llm";
import { z } from "zod";

// Fast keyword-based pre-classifier before expensive LLM call
const KEYWORD_SIGNALS: Record<DocumentType, string[]> = {
    INVOICE: ["invoice", "invoice #", "invoice no", "bill to", "amount due", "payment due", "net 30", "net 60", "remit to"],
    PURCHASE_ORDER: ["purchase order", "p.o. number", "p.o. #", "ship to", "buyer", "requisition", "order confirmation"],
    VENDOR_STATEMENT: ["account statement", "statement of account", "balance forward", "aging", "current balance", "past due"],
    BILL_OF_LADING: ["bill of lading", "b/l", "bol", "consignee", "shipper", "pro number", "freight charges", "carrier"],
    PACKING_SLIP: ["packing slip", "packing list", "ship date", "order number", "qty shipped", "qty ordered"],
    FREIGHT_QUOTE: ["freight quote", "rate quote", "transit time", "estimated transit", "accessorial"],
    REMITTANCE_ADVICE: ["remittance", "payment reference", "check number", "ach", "wire transfer"],
    CREDIT_MEMO: ["credit memo", "credit note", "credit #", "return authorization", "rma"],
    CONTRACT: ["agreement", "terms and conditions", "effective date", "party", "whereas", "hereinafter"],
    PRODUCT_SPEC: ["specifications", "product data sheet", "technical specifications", "properties", "composition"],
    SDS: ["safety data sheet", "sds", "msds", "hazard", "ghs", "signal word", "first aid"],
    COA: ["certificate of analysis", "coa", "lot number", "test results", "specification", "assay"],
    TRACKING_NOTIFICATION: ["tracking number", "shipped", "in transit", "out for delivery", "estimated delivery", "delivered"],
    UNKNOWN: [],
};

const ClassificationSchema = z.object({
    type: z.enum([
        "INVOICE", "PURCHASE_ORDER", "VENDOR_STATEMENT", "BILL_OF_LADING",
        "PACKING_SLIP", "FREIGHT_QUOTE", "REMITTANCE_ADVICE", "CREDIT_MEMO",
        "CONTRACT", "PRODUCT_SPEC", "SDS", "COA", "TRACKING_NOTIFICATION", "UNKNOWN"
    ]),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
});

export async function classifyDocument(extraction: PDFExtractionResult): Promise<{
    type: DocumentType;
    confidence: "high" | "medium" | "low";
    reasoning: string;
}> {
    const text = extraction.rawText.toLowerCase();

    // Fast keyword pre-check
    const scores: Partial<Record<DocumentType, number>> = {};
    for (const [type, keywords] of Object.entries(KEYWORD_SIGNALS)) {
        const hits = keywords.filter(kw => text.includes(kw)).length;
        if (hits > 0) scores[type as DocumentType] = hits;
    }

    const topMatch = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];
    if (topMatch && topMatch[1] >= 2) {
        return {
            type: topMatch[0] as DocumentType,
            confidence: topMatch[1] >= 4 ? "high" : "medium",
            reasoning: `Keyword match: ${topMatch[1]} signals found`,
        };
    }

    // LLM classification for ambiguous documents
    const preview = extraction.rawText.slice(0, 1500);

    try {
        const result = await unifiedObjectGeneration({
            system: `Classify this business document.`,
            prompt: `Document preview:\n${preview}`,
            schema: ClassificationSchema,
            schemaName: "Classification"
        });
        return result as any;
    } catch (err: any) {
        console.error("❌ classifyDocument failed even with fallback:", err.message);
        return { type: "UNKNOWN", confidence: "low", reasoning: "Model failure" };
    }
}
