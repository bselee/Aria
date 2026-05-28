/**
 * @file    memory.ts
 * @purpose General-purpose memory system using local SQLite (memory-store.ts).
 *          Stores and retrieves operational context: vendor patterns, follow-ups,
 *          Slack requests, conversation details, preferences, action items.
 * @author  Will / Antigravity / Hermia
 * @created 2026-02-24
 * @updated 2026-05-28
 * @deps    ./embedding, ../storage/memory-store
 *
 * HERMIA(2026-05-28): Migrated from Pinecone to local SQLite (memory-store.ts).
 * Embedding generation still uses OpenAI via embedding.ts. Vector storage and
 * similarity search now happen in aria-local.db (<1ms queries vs Pinecone 50-100ms).
 * Pinecone index 'gravity-memory' namespace 'aria-memory' → memory_vectors table.
 *
 * @original-deps @pinecone-database/pinecone (REMOVED)
 */

import { embed, embedQuery } from './embedding';
import {
    upsertVector,
    queryVectors,
    deleteByFilter,
    countVectors,
    type MemorySearchResult as StoreSearchResult,
} from '../storage/memory-store';

const NAMESPACE = 'aria-memory';

// ──────────────────────────────────────────────────
// TYPES (unchanged public API)
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
 * Store a memory in local SQLite.
 * Every interaction can create memories — vendor patterns, follow-ups, preferences.
 * Non-fatal: logs and continues if embedding fails.
 */
export async function remember(memory: Memory): Promise<string> {
    const id = memory.id || `${memory.category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        // Build embedding text from all fields
        const embeddingText = [
            memory.content,
            memory.relatedTo ? `Related to: ${memory.relatedTo}` : '',
            memory.tags?.length ? `Tags: ${memory.tags.join(', ')}` : '',
            `Category: ${memory.category}`,
        ].filter(Boolean).join('\n');

        const vector = await embed(embeddingText);

        // If embedding fails (quota/rate limit), skip the upsert
        if (!vector) {
            console.warn(`⚠️ Skipping remember() — embedding unavailable. Content: ${memory.content.slice(0, 60)}...`);
            return id;
        }

        const metadata: Record<string, unknown> = {
            category: memory.category,
            content: memory.content,
            tags: (memory.tags || []).join(','),
            source: memory.source || 'unknown',
            relatedTo: memory.relatedTo || '',
            priority: memory.priority || 'normal',
            expiresAt: memory.expiresAt || '',
            stored_at: new Date().toISOString(),
        };

        upsertVector(NAMESPACE, id, new Float32Array(vector), metadata);

        console.log(`🧠 Remembered [${memory.category}]: ${memory.content.slice(0, 80)}...`);
    } catch (err: any) {
        // Non-fatal — log and move on so calling agent doesn't crash
        console.error(`⚠️ remember() failed (non-fatal): ${err.message}`);
    }
    return id;
}

/**
 * Search memories by semantic similarity.
 * Returns the most relevant memories for a given query.
 * Filters out expired memories (TTL enforcement).
 */
export async function recall(query: string, options?: {
    category?: MemoryCategory;
    topK?: number;
    minScore?: number;
}): Promise<MemorySearchResult[]> {
    try {
        const vector = await embedQuery(query);

        if (!vector) {
            console.warn(`⚠️ recall() skipped — embedding unavailable for query: ${query.slice(0, 60)}...`);
            return [];
        }

        const filter: Record<string, any> = {};
        if (options?.category) {
            filter.category = { $eq: options.category };
        }

        const results = queryVectors(NAMESPACE, new Float32Array(vector), {
            topK: options?.topK || 5,
            minScore: options?.minScore ?? 0.4,
            filter: Object.keys(filter).length > 0 ? filter : undefined,
        });

        const now = new Date();

        const filtered = results
            .map((r: StoreSearchResult) => ({
                id: r.id,
                score: r.score,
                category: r.metadata.category as MemoryCategory,
                content: r.metadata.content as string,
                tags: r.metadata.tags ? String(r.metadata.tags).split(',').filter(Boolean) : [],
                source: r.metadata.source as string,
                relatedTo: (r.metadata.relatedTo as string) || undefined,
                priority: r.metadata.priority as Memory['priority'],
                expiresAt: (r.metadata.expiresAt as string) || undefined,
                storedAt: r.metadata.stored_at as string,
            }))
            // Filter out expired memories at read time
            .filter((m: MemorySearchResult) => {
                if (!m.expiresAt) return true;
                return new Date(m.expiresAt) > now;
            });

        return filtered;
    } catch (err: any) {
        // Non-fatal — return empty so calling agent continues without memory
        console.error(`⚠️ recall() failed (non-fatal): ${err.message}`);
        return [];
    }
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
    try {
        const memories = await recall(userMessage, { topK: 5, minScore: 0.45 });

        if (memories.length === 0) return '';

        let context = '\n\n--- ARIA\'S MEMORIES (relevant context) ---\n';
        for (const mem of memories) {
            const age = timeSince(mem.storedAt);
            context += `• [${mem.category}] ${mem.content} (${age} ago, ${(mem.score * 100).toFixed(0)}% relevant)\n`;
        }
        context += '--- END MEMORIES ---\n';

        return context;
    } catch (err: any) {
        // Non-fatal — bot continues without memory context
        console.warn(`⚠️ getRelevantContext() failed (non-fatal): ${err.message}`);
        return '';
    }
}

/**
 * Prune stale memories. Called by feedback-loop housekeeping.
 * Deletes memories where last_recalled_at is absent AND stored_at > 60 days.
 *
 * HERMIA(2026-05-28): Replaced Pinecone list+delete with deleteByFilter().
 */
export async function pruneStaleMemories(): Promise<number> {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
    // deleteByFilter deletes rows where the field is MISSING/empty AND older than threshold
    return deleteByFilter(NAMESPACE, {
        field: 'last_recalled_at',
        value: undefined,
        olderThan: sixtyDaysAgo,
    });
}

/**
 * Get memory store stats.
 */
export function getMemoryStats(): { namespace: string; count: number } {
    return { namespace: NAMESPACE, count: countVectors(NAMESPACE) };
}

/**
 * Seed initial memories from known operational knowledge.
 */
export async function seedMemories(): Promise<void> {
    console.log('🌱 Seeding Aria\'s memory...');

    const seeds: Memory[] = [
        {
            id: 'seed-vendor_pattern-aaacooper',
            category: 'vendor_pattern',
            content: 'AAACooper sends multi-page documents labeled as "statements" (e.g. ACT_STMD_ID_2409.PDF) where each page is actually an individual invoice. Not a typical account statement with aging. Each page should be split into a separate PDF and emailed individually to buildasoilap@bill.com.',
            tags: ['aaacooper', 'invoice', 'statement', 'split', 'bill.com'],
            relatedTo: 'AAACooper',
            source: 'manual',
            priority: 'high',
        },
        {
            id: 'seed-vendor_pattern-default',
            category: 'vendor_pattern',
            content: 'Most vendors send individual single-page invoice PDFs via email the same day as shipment. One invoice per PDF. Forward as-is to buildasoilap@bill.com.',
            tags: ['invoice', 'default', 'bill.com'],
            relatedTo: '_default_vendor',
            source: 'manual',
            priority: 'normal',
        },
        {
            id: 'seed-process-invoice-forwarding',
            category: 'process',
            content: 'All vendor invoices must be forwarded as PDF attachments to buildasoilap@bill.com for processing in Bill.com. The PDF must be attached — bill.com cannot process inline content.',
            tags: ['bill.com', 'invoice', 'accounts-payable'],
            source: 'manual',
            priority: 'high',
        },
        {
            id: 'seed-preference-communication-style',
            category: 'preference',
            content: 'Will prefers concise, actionable responses. No fluff. Focus on what matters for purchasing and inventory decisions.',
            tags: ['communication', 'style'],
            relatedTo: 'Will',
            source: 'manual',
        },
        {
            id: 'seed-preference-email-pioneer-propane',
            category: 'preference',
            content: 'Pioneer Propane emails never need viewing. Mark as read and archive. Not forwarded to Bill.com at this time — recurring utility expense.',
            tags: ['email', 'auto-archive', 'pioneer-propane', 'autopay'],
            relatedTo: 'Pioneer Propane',
            source: 'manual',
            priority: 'normal',
        },
        {
            id: 'seed-preference-email-gorgias',
            category: 'preference',
            content: 'Gorgias (support software) emails never need viewing. Mark as read and archive. Not forwarded to Bill.com — recurring SaaS subscription.',
            tags: ['email', 'auto-archive', 'gorgias', 'software', 'autopay'],
            relatedTo: 'Gorgias',
            source: 'manual',
            priority: 'normal',
        },
        {
            id: 'seed-preference-email-google',
            category: 'preference',
            content: 'Google Workspace and Google Cloud emails never need viewing in AP inbox. Mark as read and archive. Not forwarded to Bill.com — recurring software subscription.',
            tags: ['email', 'auto-archive', 'google', 'software', 'autopay'],
            relatedTo: 'Google',
            source: 'manual',
            priority: 'normal',
        },
        {
            id: 'seed-preference-email-wwex',
            category: 'preference',
            content: 'WWEX / Worldwide Express emails are autopay. Mark as read and archive. Not forwarded to Bill.com to avoid double-payment.',
            tags: ['email', 'auto-archive', 'wwex', 'autopay', 'freight'],
            relatedTo: 'Worldwide Express',
            source: 'manual',
            priority: 'normal',
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
