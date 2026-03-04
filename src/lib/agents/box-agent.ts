import { z } from "zod";
import { unifiedObjectGeneration } from "../intelligence/llm";
import { FinaleClient } from "../finale/client";

export const BoxDetectionSchema = z.object({
    isBoxMention: z.boolean().describe("True if the message is explicitly talking about boxes, box sizes, or box inventory."),
    boxClaims: z.array(z.object({
        rawSizeMention: z.string().describe("The size or name as mentioned in the text, e.g. 9x5x5"),
        physicalCount: z.number().nullable().describe("The on-hand count mentioned, e.g. 0, 500. Null if not explicitly stated."),
        userNotes: z.string().describe("Any notes about who uses it or why it's needed, e.g. 'MFG for case builds'")
    }))
});

export const KNOWN_BOXES = [
    { sku: "S-4092", size: "9x5x5", desc: 'Corrugated Boxes - (9"x5"x5") /25' },
    { sku: "S-4128", size: "12x6x6", desc: 'Corrugated Boxes - (12"x6"x6") /25' },
    { sku: "S-4122", size: "12x12x6", desc: 'Corrugated Boxes - (12"x12"x6") /25' },
    { sku: "S-4125", size: "12x12x12", desc: 'Corrugated Boxes - (12"x12"x12") /25' },
    { sku: "S-4796", size: "22x14x6", desc: 'Corrugated Boxes - (22"x14"x6") /25' },
    { sku: "S-4738", size: "24x14x10", desc: 'Corrugated Boxes - (24"x14"x10") /20' }
];

/**
 * 📦 BoxAgent
 * Specializes in matching real-world box inventory claims against Finale's data.
 * Can detect discrepancies, monitor stock levels, and flag when Finale suggests reorders.
 */
export class BoxAgent {
    private finale: FinaleClient;

    constructor() {
        this.finale = new FinaleClient();
    }

    /**
     * Checks all known box SKUs in Finale and returns a full stock report.
     * Useful for daily checks or manual triggers.
     */
    async getOverallBoxStatus(): Promise<string> {
        let report = `📦 *Box Agent System Status*\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;

        for (const box of KNOWN_BOXES) {
            const profile = await this.finale.getComponentStockProfile(box.sku);
            const stock = profile.onHand || 0;
            const reorder = profile.reorderQuantityToOrder || 0;

            report += `*${box.size}* (\`${box.sku}\`):\n`;
            report += `  On Hand: ${stock} units\n`;

            if (reorder > 0) {
                report += `  ⚠️ Finale suggests ordering: ${reorder} units\n`;
            }
            if (profile.incomingPOs.length > 0) {
                const poStr = profile.incomingPOs.map(po => `PO ${po.orderId}: ${po.quantity} from ${po.supplier}`).join(', ');
                report += `  📦 Incoming: ${poStr}\n`;
            }
            report += `\n`;
        }
        return report;
    }

    /**
     * Analyzes a Slack message to extract physical count claims and compares them to Finale.
     */
    async analyzeSlackMessage(text: string): Promise<string | null> {
        const analysis = await unifiedObjectGeneration({
            system: `You are the Box Agent. Your job is to extract inventory physical counts of shipping/corrugated boxes from text messages. 
Identify the size requested and the physical count claimed by the user on the floor.`,
            prompt: text,
            schema: BoxDetectionSchema,
            schemaName: "BoxDetection",
            temperature: 0.1
        });

        if (!analysis.isBoxMention || analysis.boxClaims.length === 0) return null;

        let report = `📦 *Box Agent Reality Check*\n`;
        report += "Someone reported physical box counts. Here is how they compare against Finale:\n\n";

        let hasDiscrepancy = false;

        for (const claim of analysis.boxClaims) {
            // Find best matching box by stripping non-numeric/x chars
            const claimKey = claim.rawSizeMention.toLowerCase().replace(/[^0-9x]/g, '');
            const match = KNOWN_BOXES.find(b => claimKey.includes(b.size.toLowerCase().replace(/[^0-9x]/g, '')) || b.size.toLowerCase().replace(/[^0-9x]/g, '').includes(claimKey));

            if (!match) continue;

            const profile = await this.finale.getComponentStockProfile(match.sku);
            const physical = claim.physicalCount;
            const finaleStock = profile.onHand || 0;

            let discrepancyText = '';
            if (physical !== null) {
                // Finale uses units, but humans often say "1 pallet" (500 units). 
                // We just do blind unit math here, but display clearly.
                const diff = physical - finaleStock;
                if (diff !== 0) {
                    discrepancyText = ` 🔴 *Mismatch:* Finale says ${finaleStock}, floor says ${physical} (Diff: ${diff})`;
                    hasDiscrepancy = true;
                } else {
                    discrepancyText = ` 🟢 *Matched:* Both agree on ${physical} units.`;
                }
            } else {
                discrepancyText = ` ℹ️ Finale Stock: ${finaleStock}`;
            }

            report += `*${match.size}* (\`${match.sku}\`)\n`;
            report += `   ${discrepancyText}\n`;
            if (claim.userNotes) {
                report += `   _Notes:_ ${claim.userNotes}\n`;
            }
            if (profile.reorderQuantityToOrder && profile.reorderQuantityToOrder > 0) {
                report += `   _Action:_ Finale suggests ordering *${profile.reorderQuantityToOrder}*\n`;
            }
            report += `\n`;
        }

        if (hasDiscrepancy) {
            report += `\n⚠️ *Warning:* Finale's stock is out of sync with physical counts for some items.`;
        }

        return report;
    }
}
