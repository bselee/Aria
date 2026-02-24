/**
 * @file    vendor-memory.ts
 * @purpose Stores and retrieves vendor-specific document handling patterns in Pinecone.
 *          Aria learns how each vendor sends documents and how to process them.
 * @author  Will / Antigravity
 * @created 2026-02-24
 * @updated 2026-02-24
 * @deps    @pinecone-database/pinecone, openai
 * @env     PINECONE_API_KEY, PINECONE_INDEX, OPENAI_API_KEY
 */

import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

let pc: Pinecone | null = null;
let openai: OpenAI | null = null;

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
}

/**
 * Generate an embedding vector from text using OpenAI.
 */
async function embed(text: string): Promise<number[]> {
    if (!openai) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        dimensions: 1024, // Compact but effective
    });

    return res.data[0].embedding;
}

/**
 * Get or initialize the Pinecone index.
 */
function getIndex() {
    if (!pc) {
        const apiKey = process.env.PINECONE_API_KEY;
        if (!apiKey) throw new Error("PINECONE_API_KEY not set");
        pc = new Pinecone({ apiKey });
    }
    return pc.index(process.env.PINECONE_INDEX || 'email-embeddings');
}

/**
 * Store a vendor document pattern in Pinecone.
 * Called when Aria learns something new about how a vendor sends documents.
 */
export async function storeVendorPattern(pattern: VendorPattern): Promise<void> {
    try {
        const index = getIndex();

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

        const id = `vendor-${pattern.vendorName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

        await index.namespace(NAMESPACE).upsert([{
            id,
            values: vector,
            metadata: {
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
            }
        }]);

        console.log(`🧠 Stored vendor pattern: ${pattern.vendorName} (${pattern.documentType})`);
    } catch (err: any) {
        console.error(`❌ Failed to store vendor pattern: ${err.message}`);
    }
}

/**
 * Retrieve the stored pattern for a specific vendor.
 * Returns null if no pattern is stored.
 */
export async function getVendorPattern(vendorName: string): Promise<VendorPattern | null> {
    try {
        const index = getIndex();
        const id = `vendor-${vendorName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

        const result = await index.namespace(NAMESPACE).fetch([id]);
        const record = result.records?.[id];

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
        const index = getIndex();
        const vector = await embed(documentText.slice(0, 2000));

        const results = await index.namespace(NAMESPACE).query({
            vector,
            topK,
            includeMetadata: true,
        });

        return (results.matches || [])
            .filter(m => (m.score ?? 0) > 0.5)
            .map(m => {
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
            vendorName: 'AAACooper',
            documentType: 'STATEMENT',
            pattern: 'Sends multi-page documents labeled as "statements" where each page is actually an individual invoice. Not a typical account statement with aging.',
            handlingRule: 'Split each page into a separate PDF. Each page is one invoice. Extract invoice # from each page. Email each individual invoice PDF to bill.com.',
            invoiceBehavior: 'multi_page_split',
            forwardTo: 'buildasoilap@bill.com',
            exampleFilenames: ['ACT_STMD_ID_2409.PDF'],
            learnedFrom: 'manual',
            confidence: 0.95,
        },
        // DECISION(2026-02-24): Default pattern for most vendors.
        // Most vendors send individual invoice PDFs same day as shipment.
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
    ];

    console.log('🌱 Seeding vendor patterns...');
    for (const pattern of knownPatterns) {
        await storeVendorPattern(pattern);
    }
    console.log(`✅ Seeded ${knownPatterns.length} vendor patterns.`);
}
