/**
 * @file    memory.ts
 * @purpose General-purpose memory system for Aria using Pinecone + shared embeddings.
 *          Stores and retrieves ANY operational context: vendor patterns, follow-ups,
 *          Slack requests, conversation details, preferences, action items.
 * @author  Will / Antigravity
 * @created 2026-02-24
 * @updated 2026-03-06
 * @deps    @pinecone-database/pinecone, ./embedding
 * @env     PINECONE_API_KEY, PINECONE_INDEX
 *
 * DECISION(2026-03-06): Embedding logic extracted to shared embedding.ts.
 * Added TTL enforcement — expired memories are filtered out during recall().
 * All functions degrade gracefully on embedding/Pinecone failures.
 */

import { Pinecone } from '@pinecone-database/pinecone';
import { embed, embedQuery } from './embedding';

let pc: Pinecone | null = null;

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
 * Get the Pinecone index.
 */
function getIndex() {
    if (!pc) {
        const apiKey = process.env.PINECONE_API_KEY;
        if (!apiKey) throw new Error("PINECONE_API_KEY not set");
        pc = new Pinecone({ apiKey });
    }
    // gravity-memory is 1024d — matches text-embedding-3-small dimensions: 1024
    // Explicit host bypasses control-plane lookup on every call
    const indexName = process.env.PINECONE_INDEX || 'gravity-memory';
    const indexHost = process.env.PINECONE_MEMORY_HOST;
    return indexHost ? pc.index(indexName, indexHost) : pc.index(indexName);
}

/**
 * Store a memory in Pinecone.
 * Every interaction can create memories — vendor patterns, follow-ups, preferences.
 * Non-fatal: logs and continues if embedding or Pinecone fails.
 */
export async function remember(memory: Memory): Promise<string> {
    const id = memory.id || `${memory.category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
        const index = getIndex();

        // Build embedding text from all fields
        const embeddingText = [
            memory.content,
            memory.relatedTo ? `Related to: ${memory.relatedTo}` : '',
            memory.tags?.length ? `Tags: ${memory.tags.join(', ')}` : '',
            `Category: ${memory.category}`,
        ].filter(Boolean).join('\n');

        const vector = await embed(embeddingText);

        // DECISION(2026-03-06): If embedding fails (quota/rate limit), skip the upsert
        // rather than crashing. The memory is lost but the calling agent stays alive.
        if (!vector) {
            console.warn(`⚠️ Skipping remember() — embedding unavailable. Content: ${memory.content.slice(0, 60)}...`);
            return id;
        }

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
        const index = getIndex();
        // DECISION(2026-03-13): Use embedQuery() (inputType: 'query') for search,
        // vs embed() (inputType: 'passage') for storage. llama-text-embed-v2 uses
        // asymmetric embedding for optimal retrieval quality.
        const vector = await embedQuery(query);

        // DECISION(2026-03-06): If embedding fails, return empty rather than crash.
        // Agent continues without memory context — better than a hard failure.
        if (!vector) {
            console.warn(`⚠️ recall() skipped — embedding unavailable for query: ${query.slice(0, 60)}...`);
            return [];
        }

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
        const now = new Date();

        const filtered = (results.matches || [])
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
                    expiresAt: meta.expiresAt || undefined,
                    storedAt: meta.stored_at,
                };
            })
            // DECISION(2026-03-06): Filter out expired memories at read time.
            // Stale follow-ups and time-bound decisions shouldn't pollute results.
            .filter(m => {
                if (!m.expiresAt) return true; // No expiry = never expires
                return new Date(m.expiresAt) > now;
            });

        // DECISION(2026-03-09): Refresh last_recalled_at on every vector that makes it
        // through both the score filter and the TTL filter. pruneStaleMemories() in
        // feedback-loop.ts deletes vectors where last_recalled_at is absent AND
        // stored_at > 60d — without this update, any actively-recalled memory would
        // still get pruned on its 60-day birthday.
        // Fire-and-forget: don't block the caller, don't throw on failure.
        if (filtered.length > 0) {
            const ns = index.namespace('aria-memory');
            const recalledAt = new Date().toISOString();
            setImmediate(() => {
                for (const m of filtered) {
                    if (!m.id) continue;
                    ns.update({ id: m.id, metadata: { last_recalled_at: recalledAt } })
                        .catch((err: any) => {
                            console.warn(`⚠️ recall() metadata refresh failed for ${m.id} (non-fatal): ${err.message}`);
                        });
                }
            });
        }

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
 * Seed initial memories from known operational knowledge.
 */
export async function seedMemories(): Promise<void> {
    console.log('🌱 Seeding Aria\'s memory...');

    // DECISION(2026-03-09): Use deterministic IDs so re-seeding upserts
    // over existing records instead of creating duplicates.
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
        // DECISION(2026-03-19): Store email handling preferences so Aria's chat path
        // also knows about auto-archive senders. AP Agent handles these deterministically
        // via VENDOR_ROUTING_RULES, but the LLM classification path checks Pinecone too.
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
