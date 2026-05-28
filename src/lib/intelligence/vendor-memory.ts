/**
 * @file    vendor-memory.ts
 * @purpose Stores and retrieves vendor-specific document handling patterns
 *          in local SQLite (memory-store.ts). Replaces Pinecone vendor-memory namespace.
 * @author  Will / Antigravity / Hermia
 * @created 2026-02-24
 * @updated 2026-05-28
 * @deps    ./embedding, ../storage/memory-store
 *
 * HERMIA(2026-05-28): Migrated from Pinecone to local SQLite.
 * Pinecone index 'gravity-memory' namespace 'vendor-memory' → memory_vectors table.
 *
 * @original-deps @pinecone-database/pinecone (REMOVED)
 */

import { embed, embedQuery } from './embedding';
import {
    upsertVector,
    fetchVector,
    queryVectors,
    type MemorySearchResult as StoreSearchResult,
} from '../storage/memory-store';

const NAMESPACE = 'vendor-memory';

export interface VendorPattern {
    vendorName: string;
    documentType: 'INVOICE' | 'STATEMENT' | 'BOL' | 'COA' | 'SDS' | 'PACKING_SLIP' | 'OTHER';
    pattern: string;           // Human-readable description of how this vendor sends docs
    handlingRule: string;       // What Aria should DO with it
    invoiceBehavior?: 'single_page' | 'multi_page_split' | 'mixed_with_statement';
    forwardTo?: string;         // Email to forward processed docs to
    exampleFilenames?: string[];
    learnedFrom?: string;       // Source: "telegram_upload", "email_attachment", "manual"
    confidence: number;         // 0-1, how confident we are in this pattern
    feeLabelMap?: Record<string, string>;  // H2/M3: vendor-specific fee label → Finale fee type
}

/**
 * Store a vendor document pattern in local SQLite.
 * Called when Aria learns something new about how a vendor sends documents.
 * Non-fatal: logs and continues if embedding or store fails.
 */
export async function storeVendorPattern(pattern: VendorPattern): Promise<void> {
    try {
        // Create a rich text description for embedding
        const embeddingText = [
            `Vendor: ${pattern.vendorName}`,
            `Document type: ${pattern.documentType}`,
            `Pattern: ${pattern.pattern}`,
            `Handling: ${pattern.handlingRule}`,
            pattern.invoiceBehavior ? `Invoice behavior: ${pattern.invoiceBehavior}` : '',
            pattern.forwardTo ? `Forward to: ${pattern.forwardTo}` : '',
        ].filter(Boolean).join('\n');

        const vector = await embed(embeddingText);

        if (!vector) {
            console.warn(`⚠️ Skipping vendor pattern store — embedding unavailable for: ${pattern.vendorName}`);
            return;
        }

        const id = `vendor-${pattern.vendorName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

        const metadata: Record<string, unknown> = {
            vendorName: pattern.vendorName,
            documentType: pattern.documentType,
            pattern: pattern.pattern,
            handlingRule: pattern.handlingRule,
            invoiceBehavior: pattern.invoiceBehavior || 'single_page',
            forwardTo: pattern.forwardTo || 'buildasoilap@bill.com',
            exampleFilenames: (pattern.exampleFilenames || []).join(','),
            learnedFrom: pattern.learnedFrom || 'manual',
            confidence: pattern.confidence,
            text: embeddingText,
            updated_at: new Date().toISOString(),
            feeLabelMap: pattern.feeLabelMap ? JSON.stringify(pattern.feeLabelMap) : '',
        };

        upsertVector(NAMESPACE, id, new Float32Array(vector), metadata);

        console.log(`🧠 Stored vendor pattern: ${pattern.vendorName} (${pattern.documentType})`);
    } catch (err: any) {
        console.error(`❌ Failed to store vendor pattern: ${err.message}`);
    }
}

/**
 * Retrieve the stored pattern for a specific vendor.
 * Returns null if no pattern is stored.
 */
export function getVendorPattern(vendorName: string | null | undefined): VendorPattern | null {
    if (typeof vendorName !== "string" || !vendorName) return null;
    try {
        const id = `vendor-${vendorName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        const record = fetchVector(NAMESPACE, id);

        if (!record?.metadata) return null;

        const meta = record.metadata as Record<string, any>;
        return {
            vendorName: meta.vendorName,
            documentType: meta.documentType,
            pattern: meta.pattern,
            handlingRule: meta.handlingRule,
            invoiceBehavior: meta.invoiceBehavior,
            forwardTo: meta.forwardTo,
            exampleFilenames: meta.exampleFilenames ? String(meta.exampleFilenames).split(',') : [],
            learnedFrom: meta.learnedFrom,
            confidence: meta.confidence,
            feeLabelMap: meta.feeLabelMap ? JSON.parse(String(meta.feeLabelMap)) : undefined,
        };
    } catch (err: any) {
        console.error(`❌ Failed to retrieve vendor pattern: ${err.message}`);
        return null;
    }
}

/**
 * Semantic search for relevant vendor patterns given a document's content.
 * Useful when we don't know the vendor name yet.
 */
export async function findRelevantPatterns(documentText: string, topK: number = 3): Promise<VendorPattern[]> {
    try {
        const vector = await embedQuery(documentText.slice(0, 2000));

        if (!vector) {
            console.warn(`⚠️ findRelevantPatterns() skipped — embedding unavailable.`);
            return [];
        }

        const results = queryVectors(NAMESPACE, new Float32Array(vector), {
            topK,
            minScore: 0.5,
        });

        return results.map((m: StoreSearchResult) => {
            const meta = m.metadata as Record<string, any>;
            return {
                vendorName: meta.vendorName,
                documentType: meta.documentType,
                pattern: meta.pattern,
                handlingRule: meta.handlingRule,
                invoiceBehavior: meta.invoiceBehavior,
                forwardTo: meta.forwardTo,
                exampleFilenames: meta.exampleFilenames ? String(meta.exampleFilenames).split(',') : [],
                learnedFrom: meta.learnedFrom,
                confidence: meta.confidence,
            };
        });
    } catch (err: any) {
        console.error(`❌ Failed to search vendor patterns: ${err.message}`);
        return [];
    }
}

/**
 * Seed initial vendor patterns from known data.
 * Call once to bootstrap Aria's memory with what we know.
 */
export async function seedKnownVendorPatterns(): Promise<void> {
    const knownPatterns: VendorPattern[] = [
        {
            vendorName: 'ULINE',
            documentType: 'INVOICE',
            pattern: 'Sends PDF invoices to ap@buildasoil.com (Net-30 accounts payable) and order confirmations to ' +
                     'bill.selee@buildasoil.com (credit card orders). Subject includes PO# (e.g. "PO# 124541") and ' +
                     'ULINE order number (e.g. "# 47211652"). ' +
                     'PDF LINE ITEM FORMAT — COMPACT, NO SPACES: {qty}{2-letter-UOM}{ULINE-SKU}{description}{unitPrice}{extPrice}. ' +
                     'Example raw text: "48RLS-15625INDUSTRIAL SECURITY TAPE9.50456.00" = qty:48, UOM:RL, SKU:S-15625, unit:$9.50, ext:$456.00. ' +
                     'CRITICAL: descriptions often START WITH DIGITS (box dimensions: "9 X 5 X 5"). The digit at the start of the ' +
                     'description is NOT part of the SKU. Correct parse: "500EAS-40929 X 5 X 5" = qty:500, SKU:S-4092, desc:"9 X 5 X 5" BOXES". ' +
                     'Prices are concatenated with no separator; unit price always ends with exactly 2 decimal digits before ext price begins. ' +
                     'Known SKU cross-references: S-15837B→FJG101, S-13505B→FJG102, S-13506B→FJG103, ' +
                     'S-10748B→FJG104, S-12229→10113, S-4551→ULS455, H-1621→Ho-1621. ' +
                     'All other ULINE catalog numbers can be used as Finale SKUs directly. ' +
                     'UOM codes: RL=roll, CT=carton, EA=each, BX=box, PK=pack, CS=case.',
            handlingRule: 'priceStrategy=per_item. For each line item: apply SKU cross-reference if catalog number is in known list; ' +
                          'for digit-bloated SKUs (description digit absorbed), use the base SKU (trim trailing digits that form a dimension). ' +
                          'invoicedQty is as printed; finalePricePerUnit = invoicedUnitPrice (no UOM conversion — Finale tracks same unit as invoiced). ' +
                          'Add freight (labeled "SHIPPING/HANDLING"). Add tax (labeled "SALES TAX"). ' +
                          'AP invoices forward to Bill.com; credit card invoices do NOT forward to Bill.com.',
            invoiceBehavior: 'single_page',
            forwardTo: '',
            learnedFrom: 'manual',
            confidence: 0.95,
        },
        {
            vendorName: 'Colorful Packaging',
            documentType: 'INVOICE',
            pattern: 'Sends invoice emails to bill.selee@buildasoil.com with a lump-sum product total and separate freight. ' +
                     'PO# appears in subject (e.g. "Packaging Bags #124481" or "PO-124481"). ' +
                     'Does not break out individual SKU prices — one total for all items in the order.',
            handlingRule: 'priceStrategy=lump_sum. Divide (total minus freight minus tax) evenly across all ' +
                          'Finale PO line items weighted by quantity: perUnit = productTotal / totalPOQty. ' +
                          'Update each line item to that per-unit price. Add freight. Credit card paid — never Bill.com.',
            invoiceBehavior: 'single_page',
            forwardTo: '',
            learnedFrom: 'manual',
            confidence: 0.92,
        },
        {
            vendorName: 'Axiom Print',
            documentType: 'INVOICE',
            pattern: 'Sends invoice emails to bill.selee@buildasoil.com for print jobs. ' +
                     'Line items typically map directly to Finale product IDs. ' +
                     'PO# referenced in subject or body.',
            handlingRule: 'priceStrategy=per_item. Finale SKUs match vendor line item identifiers directly. ' +
                          'No UOM conversion needed. Add freight if present. Credit card paid — never Bill.com.',
            invoiceBehavior: 'single_page',
            forwardTo: '',
            learnedFrom: 'manual',
            confidence: 0.88,
        },
        {
            vendorName: 'AAACooper',
            documentType: 'STATEMENT',
            pattern: 'Sends multi-page documents labeled as "statements" (e.g., ACT_STMD_ID_2416.PDF) containing 3-6 individual freight invoices mixed with BOLs, delivery receipts, and a cover letter. Each invoice has a unique PRO number. Not a typical account statement with aging.',
            handlingRule: 'Split the PDF into individual pages. Identify INVOICE pages by PRO number using per-page LLM classification. Name each invoice PDF by its PRO number (e.g., 64471573.pdf). Queue each for Bill.com forwarding. Discard BOL and cover letter pages.',
            invoiceBehavior: 'multi_page_split',
            forwardTo: 'buildasoilap@bill.com',
            exampleFilenames: ['ACT_STMD_ID_2409.PDF', 'ACT_STMD_ID_2416.PDF'],
            learnedFrom: 'manual',
            confidence: 0.95,
        },
        {
            vendorName: '_default',
            documentType: 'INVOICE',
            pattern: 'Most vendors send individual single-page invoice PDFs via email, same day as shipment. One invoice per PDF.',
            handlingRule: 'Forward the entire PDF as-is to bill.com. No splitting needed.',
            invoiceBehavior: 'single_page',
            forwardTo: 'buildasoilap@bill.com',
            learnedFrom: 'manual',
            confidence: 0.8,
        },
        {
            vendorName: 'Toyota',
            documentType: 'INVOICE',
            pattern: 'Sends invoice PDFs for leases but is set up for automatic payment (auto-pay). Often says "DO NOT PAY".',
            handlingRule: 'Do NOT forward to bill.com to prevent double-payment. Log the invoice for reconciliation but skip payment processing.',
            invoiceBehavior: 'single_page',
            forwardTo: '',
            learnedFrom: 'manual',
            confidence: 0.95,
        },
    ];

    console.log('🌱 Seeding vendor patterns...');
    for (const pattern of knownPatterns) {
        await storeVendorPattern(pattern);
    }
    console.log(`✅ Seeded ${knownPatterns.length} vendor patterns.`);
}
