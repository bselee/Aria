/**
 * @file    memory.ts
 * @purpose General-purpose memory system for Aria using Pinecone + OpenAI embeddings.
 *          Stores and retrieves ANY operational context: vendor patterns, follow-ups,
 *          Slack requests, conversation details, preferences, action items.
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

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type MemoryCategory =
    | 'vendor_pattern'      // How a vendor sends documents
    | 'follow_up'           // Action items, things to check on
    | 'preference'          // Will's preferences, how he likes things done
    | 'product_note'        // Notes about specific products/SKUs
    | 'contact'             // Vendor contacts, reps, account managers
    | 'process'             // How a business process works at BuildASoil
    | 'decision'            // Key decisions made and why
    | 'slack_request'       // Things requested via Slack
    | 'conversation'        // Key facts from conversations
    | 'general';            // Catch-all

export interface Memory {
    id?: string;                // Auto-generated if not provided
    category: MemoryCategory;
    content: string;            // The actual memory text
    tags?: string[];            // Searchable tags
    source?: string;            // Where this came from: "telegram", "slack", "email", "manual"
    relatedTo?: string;         // Vendor name, product SKU, person name, etc.
    priority?: 'low' | 'normal' | 'high' | 'critical';
    expiresAt?: string;         // ISO date if this memory should expire
}

export interface MemorySearchResult extends Memory {
    score: number;              // Relevance score 0-1
    storedAt: string;           // When it was stored
}

// ──────────────────────────────────────────────────
// CORE FUNCTIONS
// ──────────────────────────────────────────────────

/**
 * Generate an embedding vector from text using OpenAI.
 */
async function embed(text: string): Promise<number[]> {
    if (!openai) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8000),
        dimensions: 1024,
    });

    return res.data[0].embedding;
}

/**
 * Get the Pinecone index.
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
 * Store a memory in Pinecone.
 * Every interaction can create memories — vendor patterns, follow-ups, preferences.
 */
export async function remember(memory: Memory): Promise<string> {
    const index = getIndex();

    // Generate a deterministic ID if not provided
    const id = memory.id || `${memory.category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Build embedding text from all fields
    const embeddingText = [
        memory.content,
        memory.relatedTo ? `Related to: ${memory.relatedTo}` : '',
        memory.tags?.length ? `Tags: ${memory.tags.join(', ')}` : '',
        `Category: ${memory.category}`,
    ].filter(Boolean).join('\n');

    const vector = await embed(embeddingText);

    await index.namespace('aria-memory').upsert([{
        id,
        values: vector,
        metadata: {
            category: memory.category,
            content: memory.content,
            tags: (memory.tags || []).join(','),
            source: memory.source || 'unknown',
            relatedTo: memory.relatedTo || '',
            priority: memory.priority || 'normal',
            expiresAt: memory.expiresAt || '',
            stored_at: new Date().toISOString(),
        }
    }]);

    console.log(`🧠 Remembered [${memory.category}]: ${memory.content.slice(0, 80)}...`);
    return id;
}

/**
 * Search memories by semantic similarity.
 * Returns the most relevant memories for a given query.
 */
export async function recall(query: string, options?: {
    category?: MemoryCategory;
    topK?: number;
    minScore?: number;
}): Promise<MemorySearchResult[]> {
    const index = getIndex();
    const vector = await embed(query);

    const filter: Record<string, any> = {};
    if (options?.category) {
        filter.category = { $eq: options.category };
    }

    const results = await index.namespace('aria-memory').query({
        vector,
        topK: options?.topK || 5,
        includeMetadata: true,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    const minScore = options?.minScore ?? 0.4;

    return (results.matches || [])
        .filter(m => (m.score ?? 0) >= minScore)
        .map(m => {
            const meta = m.metadata as Record<string, any>;
            return {
                id: m.id,
                score: m.score ?? 0,
                category: meta.category as MemoryCategory,
                content: meta.content,
                tags: meta.tags ? String(meta.tags).split(',').filter(Boolean) : [],
                source: meta.source,
                relatedTo: meta.relatedTo || undefined,
                priority: meta.priority,
                storedAt: meta.stored_at,
            };
        });
}

/**
 * Recall memories specifically about a vendor.
 */
export async function recallVendor(vendorName: string): Promise<MemorySearchResult[]> {
    return recall(`vendor ${vendorName} document invoice pattern`, {
        category: 'vendor_pattern',
        topK: 3,
        minScore: 0.5,
    });
}

/**
 * Recall active follow-ups and action items.
 */
export async function recallFollowUps(): Promise<MemorySearchResult[]> {
    return recall('follow up action item todo check on', {
        category: 'follow_up',
        topK: 10,
        minScore: 0.3,
    });
}

/**
 * Format memories as context for LLM conversations.
 * Injected into system prompt so Aria knows what she remembers.
 */
export async function getRelevantContext(userMessage: string): Promise<string> {
    const memories = await recall(userMessage, { topK: 5, minScore: 0.45 });

    if (memories.length === 0) return '';

    let context = '\n\n--- ARIA\'S MEMORIES (relevant context) ---\n';
    for (const mem of memories) {
        const age = timeSince(mem.storedAt);
        context += `• [${mem.category}] ${mem.content} (${age} ago, ${(mem.score * 100).toFixed(0)}% relevant)\n`;
    }
    context += '--- END MEMORIES ---\n';

    return context;
}

/**
 * Seed initial memories from known operational knowledge.
 */
export async function seedMemories(): Promise<void> {
    console.log('🌱 Seeding Aria\'s memory...');

    const seeds: Memory[] = [
        {
            category: 'vendor_pattern',
            content: 'AAACooper sends multi-page documents labeled as "statements" (e.g. ACT_STMD_ID_2409.PDF) where each page is actually an individual invoice. Not a typical account statement with aging. Each page should be split into a separate PDF and emailed individually to buildasoilap@bill.com.',
            tags: ['aaacooper', 'invoice', 'statement', 'split', 'bill.com'],
            relatedTo: 'AAACooper',
            source: 'manual',
            priority: 'high',
        },
        {
            category: 'vendor_pattern',
            content: 'Most vendors send individual single-page invoice PDFs via email the same day as shipment. One invoice per PDF. Forward as-is to buildasoilap@bill.com.',
            tags: ['invoice', 'default', 'bill.com'],
            relatedTo: '_default_vendor',
            source: 'manual',
            priority: 'normal',
        },
        {
            category: 'process',
            content: 'All vendor invoices must be forwarded as PDF attachments to buildasoilap@bill.com for processing in Bill.com. The PDF must be attached — bill.com cannot process inline content.',
            tags: ['bill.com', 'invoice', 'accounts-payable'],
            source: 'manual',
            priority: 'high',
        },
        {
            category: 'preference',
            content: 'Will prefers concise, actionable responses. No fluff. Focus on what matters for purchasing and inventory decisions.',
            tags: ['communication', 'style'],
            relatedTo: 'Will',
            source: 'manual',
        },
    ];

    for (const seed of seeds) {
        await remember(seed);
    }
    console.log(`✅ Seeded ${seeds.length} memories.`);
}

// ──────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────

function timeSince(isoDate: string): string {
    const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}
