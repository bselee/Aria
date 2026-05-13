/**
 * @file    eta-extractor.ts
 * @purpose Parse free-text vendor replies for ETA / ship-date hints using
 *          the existing structured-generation LLM stack. Resolves things
 *          like "shipping next Tuesday", "ETA early next week", "PO ships
 *          5/20" into ISO dates that the Active Purchases panel can use.
 *
 * Returns null when no date is mentioned. Confidence reflects how clear
 * the language was.
 */
import { z } from "zod";
import { unifiedObjectGeneration } from "@/lib/intelligence/llm";

export interface ETAExtractionResult {
    etaDate: string | null;        // ISO YYYY-MM-DD — when the customer should expect the order
    shipDate: string | null;       // ISO YYYY-MM-DD — when vendor says they'll ship
    confidence: 'high' | 'medium' | 'low';
    rationale: string;
}

const Schema = z.object({
    etaDate: z.string().nullable().describe('Expected arrival date the vendor implied, ISO YYYY-MM-DD. null if not stated.'),
    shipDate: z.string().nullable().describe('Date the vendor said they would ship, ISO YYYY-MM-DD. null if not stated.'),
    confidence: z.enum(['high', 'medium', 'low']).describe('How explicit the dates were.'),
    rationale: z.string().describe('1-sentence reasoning, quoting the relevant phrase from the email.'),
});

/**
 * Extract ETA / ship date hints from a vendor's reply body. Today is
 * passed in so the LLM can resolve relative phrases ("next Tuesday").
 */
export async function extractETAFromText(input: {
    body: string;
    subject?: string;
    today?: Date;
}): Promise<ETAExtractionResult> {
    const today = (input.today ?? new Date()).toISOString().slice(0, 10);
    const trimmedBody = input.body.replace(/^>\s.+$/gm, '').slice(0, 4000); // strip quoted prior message

    const system = `You extract shipping dates from vendor reply emails. Today is ${today}.
Return etaDate (expected arrival) and shipDate (when vendor says they'll ship) as ISO YYYY-MM-DD.
Resolve relative phrases against today. Examples:
  "shipping next Tuesday"     → shipDate = next Tuesday from today
  "ETA late next week"        → etaDate = a date late in the next calendar week
  "ships 5/20"                → shipDate = 2026-05-20 (use the current year for the same-month context)
  "in stock now, ships today" → shipDate = today
  "will arrive Friday"        → etaDate = upcoming Friday
If only one date is mentioned (e.g. "shipping next week"), set shipDate and leave etaDate null (or vice versa).
If no date language exists, return both as null with confidence='low'.
Confidence is high only when a clear, unambiguous date or weekday is present.`;

    try {
        const result = await unifiedObjectGeneration({
            system,
            prompt: `Subject: ${input.subject ?? '(none)'}\n\n---\n${trimmedBody}`,
            schema: Schema,
            schemaName: 'VendorETA',
            temperature: 0.1,
            // OpenRouter free chain ONLY — no paid fallback. ETA parse is
            // a nice-to-have; if the free quota is out, return null and let
            // the lead-time-median fallback handle the row.
            tier: 'free_only',
        });
        return {
            etaDate: result.etaDate && /^\d{4}-\d{2}-\d{2}$/.test(result.etaDate) ? result.etaDate : null,
            shipDate: result.shipDate && /^\d{4}-\d{2}-\d{2}$/.test(result.shipDate) ? result.shipDate : null,
            confidence: result.confidence,
            rationale: result.rationale,
        };
    } catch (err: any) {
        console.warn('[eta-extractor] LLM failed:', err?.message ?? err);
        return { etaDate: null, shipDate: null, confidence: 'low', rationale: 'extraction failed' };
    }
}
