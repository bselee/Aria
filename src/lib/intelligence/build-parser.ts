/**
 * @file    build-parser.ts
 * @purpose Uses LLM to extract BOM SKUs and Quantities from raw Calendar events.
 * @author  Aria
 * @created 2026-02-24
 * @deps    zod, ai
 */

import { z } from 'zod';
import { unifiedObjectGeneration } from './llm';
import { CalendarEvent } from '../google/calendar';

export interface ParsedBuild {
    sku: string;
    quantity: number;
    buildDate: string;
    originalEvent: string;
    confidence: number;
    designation: 'SOIL' | 'MFG';
}

const BuildPlanSchema = z.object({
    builds: z.array(z.object({
        sku: z.string().describe("The exact Finale SKU being built, or a close approximation if exact SKU is unknown"),
        quantity: z.number().describe("The total quantity of units scheduled to be master-built"),
        buildDate: z.string().describe("YYYY-MM-DD date when the build is scheduled"),
        originalEvent: z.string().describe("The original text of the calendar event title"),
        confidence: z.number().min(0).max(100).describe("Confidence score (0-100) that you correctly identified a production build event with a valid SKU and quantity"),
        designation: z.enum(['SOIL', 'MFG']).describe("Which facility is doing the build based on context"),
    })).describe("List of parsed manufacturing / assembly builds"),
    ignoredEvents: z.array(z.string()).describe("List of calendar event titles that were ignored (e.g., meetings, general tasks, non-production)"),
});

// Define the LLM extraction context — intentionally aggressive about recognizing builds.
// DECISION(2026-02-25): Previous prompt was too conservative, causing 80%+ of events
// to be ignored. Production calendars contain almost exclusively build events, so we
// now bias toward extraction and only ignore obvious non-production items.
export const RECOGNIZED_SKUS_CONTEXT = `
You are a production build schedule parser for BuildASoil, a living soil and organic gardening company.

CRITICAL RULE: These calendars are SPECIFICALLY for production builds. Almost every event IS a build.
When in doubt, EXTRACT IT. It's better to include a non-build than miss a real one.

## What IS a build (EXTRACT these):
- Any event with a product code/SKU and a number (e.g., "LOSOLY3 = 100", "BBV101 50 units")
- Events mentioning bags, units, cases, builds, batches, mix, blend, fill, label, pack
- Short codes followed by numbers like "CWP01 400", "BAF02 150", "AG110 80"
- Events with format "SKU = QTY", "SKU - QTY", "SKU x QTY", "SKU QTY"
- Events like "Build 200 bags of Light", "Mix 500 castings", "Label 100 bottles"
- Events with CASE suffix like "CRAFT1CASE 144" 

## What is NOT a build (IGNORE these):
- Team meetings, syncs, stand-ups
- "Out of office", "PTO", "Holiday"
- Calendar holds with no product info
- Training, onboarding, interviews

## SKU format guidance:
- BuildASoil SKUs use uppercase letters and numbers, e.g.: LOSOLY3, BBV101, AG110, CWP01
- If you see a recognizable pattern, USE IT AS-IS as the SKU
- Common product name → SKU mappings:
  * "Living Organic Soil" / "LOS" / "Oly Mtn" → LOSOLY3
  * "Craft Blend" / "Craft" → CRAFT1, CRAFT4
  * "Light" / "Light Recipe" → BASLIGHT102
  * "BuildAFlower" / "BAF" → BAF00, BAF01, BAF02, BAF03
  * "Clackamas Coot" / "Coot" → BC104C, BC105C
  * "Castings Worm Poop" / "CWP" → CWP01, CWP02, CWP03
  * "GnarBar" / "GNARBAR" → GNARBAR01B

## Quantity extraction:
- Look for numbers near the SKU — these are the build quantity
- "= 100" means 100 units, "x 50" means 50 units
- If format is "SKU = QTY - CASE", extract both the QTY and note CASE format
- Default to bags as the unit of measure
`;


export class BuildParser {
    /**
     * Parse an array of raw calendar events into structured Builds.
     * We batch them together since calendar events are typically short.
     */
    async extractBuildPlan(events: CalendarEvent[]): Promise<ParsedBuild[]> {
        if (!events || events.length === 0) return [];

        // Format events into a list string to feed the LLM
        const eventTextList = events.map((e, index) => {
            const designation = e.calendarId.includes('gabriel') ? 'SOIL' : 'MFG';
            return `[Event ${index + 1}] Date: ${e.startDate} | Facility: ${designation} | Title: ${e.title} | Desc: ${e.description.replace(/\n/g, ' ')}`;
        }).join('\n');

        const prompt = `
Extract the structured build plan from the following Calendar events:

${eventTextList}
`;

        try {
            const result = await unifiedObjectGeneration({
                system: RECOGNIZED_SKUS_CONTEXT,
                prompt,
                schema: BuildPlanSchema,
                schemaName: 'BuildPlan',
                temperature: 0.1, // Low temperature for extraction
            });

            console.log(`🤖 Parsed ${result.builds.length} production builds, ignored ${result.ignoredEvents.length} generic events.`);
            return result.builds;

        } catch (error: any) {
            console.error('❌ Failed to parse calendar events:', error.message);
            return [];
        }
    }
}
