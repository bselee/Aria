/**
 * @file    memory-layer-manager.ts
 * @purpose L0-L4 memory taxonomy manager.
 *          L0: Meta Rules → SQLite (local-db.ts)
 *          L1: Insight Index → Pinecone (gravity-memory, 1024d, namespace: insight-index)
 *          L2: Global Facts → Pinecone + Supabase
 *          L3: Skills → SkillCrystallizer (handled separately)
 *          L4: Session Archive → Pinecone + task_history table
 */

import { Pinecone } from '@pinecone-database/pinecone';
import { embed, embedQuery } from './embedding';
import { getLocalDb } from '@/lib/storage/local-db';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface MemoryRecord {
    layer: MemoryLayer;
    category: string;
    key: string;
    data: unknown;
    ttlSeconds?: number;
    createdAt: Date;
}

export interface MetaRule {
    id: string;
    rule: string;
    description?: string;
    createdAt: string;
}

export interface SearchResult {
    id: string;
    key: string;
    score: number;
    metadata: Record<string, unknown>;
}

export interface SessionSummary {
    sessionId: string;
    agentName: string;
    taskType: string;
    inputSummary: string;
    outputSummary: string;
    status: 'success' | 'failure' | 'shadow';
    skillId?: string;
    createdAt: string;
}

// ──────────────────────────────────────────────────
// Pinecone helpers
// ──────────────────────────────────────────────────

let pc: Pinecone | null = null;

function getPineconeClient(): Pinecone {
    if (!pc) {
        const apiKey = process.env.PINECONE_API_KEY;
        if (!apiKey) throw new Error('PINECONE_API_KEY not set');
        pc = new Pinecone({ apiKey });
    }
    return pc;
}

function getInsightIndex() {
    const client = getPineconeClient();
    const indexName = process.env.PINECONE_INDEX || 'gravity-memory';
    const indexHost = process.env.PINECONE_MEMORY_HOST;
    return indexHost ? client.index(indexName, indexHost) : client.index(indexName);
}

function getSemanticIndex() {
    const client = getPineconeClient();
    const indexName = process.env.PINECONE_INDEX || 'gravity-memory';
    const indexHost = process.env.PINECONE_MEMORY_HOST;
    return indexHost ? client.index(indexName, indexHost) : client.index(indexName);
}

// ──────────────────────────────────────────────────
// Supabase helper
// ──────────────────────────────────────────────────

function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.warn('⚠️ Supabase env vars missing, L2/L4 operations may fail');
        return null;
    }
    return createSupabaseClient(url, key);
}

// ──────────────────────────────────────────────────
// MemoryLayerManager
// ──────────────────────────────────────────────────

export class MemoryLayerManager {
    // ─── L0: Meta Rules ─────────────────────────────

    async loadMetaRules(): Promise<MetaRule[]> {
        try {
            const db = getLocalDb();
            db.exec(`
                CREATE TABLE IF NOT EXISTS meta_rules (
                    id TEXT PRIMARY KEY,
                    rule TEXT NOT NULL,
                    description TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )
            `);

            const rows = db.prepare('SELECT id, rule, description, created_at as createdAt FROM meta_rules').all() as {
                id: string;
                rule: string;
                description: string | null;
                createdAt: string;
            }[];

            return rows.map(r => ({
                id: r.id,
                rule: r.rule,
                description: r.description ?? undefined,
                createdAt: r.createdAt,
            }));
        } catch (err: any) {
            console.error('⚠️ loadMetaRules() failed:', err.message);
            return [];
        }
    }

    async saveMetaRule(rule: MetaRule): Promise<void> {
        const db = getLocalDb();
        db.prepare(`
            INSERT OR REPLACE INTO meta_rules (id, rule, description, created_at)
            VALUES (?, ?, ?, ?)
        `).run(rule.id, rule.rule, rule.description ?? null, rule.createdAt);
    }

    // ─── L1: Insight Index ──────────────────────────

    async index(key: string, metadata: Record<string, unknown>): Promise<void> {
        try {
            const index = getInsightIndex();
            const id = `insight-${key}`;
            const text = metadata.text as string ?? JSON.stringify(metadata);
            const vector = await embed(text);

            if (!vector) {
                console.warn(`⚠️ L1 index() skipped — embedding unavailable for key: ${key}`);
                return;
            }

            await index.namespace('insight-index').upsert([{
                id,
                values: vector,
                metadata: {
                    ...metadata,
                    key,
                    indexed_at: new Date().toISOString(),
                },
            }]);
        } catch (err: any) {
            console.error('⚠️ L1 index() failed:', err.message);
        }
    }

    async search(query: string, limit = 5): Promise<SearchResult[]> {
        try {
            const index = getInsightIndex();
            const vector = await embedQuery(query);

            if (!vector) {
                return [];
            }

            const results = await index.namespace('insight-index').query({
                vector,
                topK: limit,
                includeMetadata: true,
            });

            return (results.matches || []).map(m => {
                const meta = m.metadata as Record<string, unknown>;
                return {
                    id: m.id,
                    key: (meta.key as string) ?? m.id,
                    score: m.score ?? 0,
                    metadata: meta,
                };
            });
        } catch (err: any) {
            console.error('⚠️ L1 search() failed:', err.message);
            return [];
        }
    }

    // ─── L2: Global Facts ────────────────────────────

    async remember(category: string, data: unknown, ttlSeconds?: number): Promise<void> {
        try {
            const index = getSemanticIndex();
            const key = `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const text = typeof data === 'string' ? data : JSON.stringify(data);
            const vector = await embed(text);

            if (!vector) {
                console.warn(`⚠️ L2 remember() skipped — embedding unavailable for category: ${category}`);
                return;
            }

            const expiresAt = ttlSeconds
                ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
                : undefined;

            await index.namespace('aria-memory').upsert([{
                id: key,
                values: vector,
                metadata: {
                    category,
                    data,
                    expiresAt: expiresAt ?? '',
                    stored_at: new Date().toISOString(),
                },
            }]);

            // Mirror to Supabase if available
            const supabase = getSupabase();
            if (supabase) {
                await supabase.from('memories').upsert({
                    id: key,
                    category,
                    data,
                    expires_at: expiresAt,
                    created_at: new Date().toISOString(),
                }).catch(() => {});
            }
        } catch (err: any) {
            console.error('⚠️ L2 remember() failed:', err.message);
        }
    }

    async recall(category: string, query: string): Promise<MemoryRecord[]> {
        try {
            const index = getSemanticIndex();
            const vector = await embedQuery(query);

            if (!vector) {
                return [];
            }

            const results = await index.namespace('aria-memory').query({
                vector,
                topK: 10,
                includeMetadata: true,
                filter: { category: { $eq: category } },
            });

            const now = new Date();
            return (results.matches || [])
                .filter(m => {
                    const meta = m.metadata as Record<string, unknown>;
                    const expiresAt = meta.expiresAt as string | undefined;
                    if (!expiresAt) return true;
                    return new Date(expiresAt) > now;
                })
                .map(m => {
                    const meta = m.metadata as Record<string, unknown>;
                    return {
                        layer: 'L2' as MemoryLayer,
                        category: meta.category as string,
                        key: m.id,
                        data: meta.data,
                        ttlSeconds: meta.expiresAt
                            ? Math.max(0, Math.floor((new Date(meta.expiresAt as string).getTime() - now.getTime()) / 1000))
                            : undefined,
                        createdAt: new Date(meta.stored_at as string ?? Date.now()),
                    };
                });
        } catch (err: any) {
            console.error('⚠️ L2 recall() failed:', err.message);
            return [];
        }
    }

    // ─── L4: Session Archive ─────────────────────────

    async archiveSession(sessionId: string, summary: SessionSummary): Promise<void> {
        try {
            const index = getSemanticIndex();
            const text = [
                `Session: ${sessionId}`,
                `Agent: ${summary.agentName}`,
                `Task: ${summary.taskType}`,
                `Input: ${summary.inputSummary}`,
                `Output: ${summary.outputSummary}`,
                `Status: ${summary.status}`,
            ].join('\n');
            const vector = await embed(text);

            if (vector) {
                await index.namespace('session-archive').upsert([{
                    id: `session-${sessionId}`,
                    values: vector,
                    metadata: {
                        sessionId,
                        agentName: summary.agentName,
                        taskType: summary.taskType,
                        inputSummary: summary.inputSummary,
                        outputSummary: summary.outputSummary,
                        status: summary.status,
                        skillId: summary.skillId ?? '',
                        created_at: summary.createdAt,
                    },
                }]);
            }

            // Persist to Supabase task_history
            const supabase = getSupabase();
            if (supabase) {
                await supabase.from('task_history').insert({
                    agent_name: summary.agentName,
                    task_type: summary.taskType,
                    input_summary: summary.inputSummary,
                    output_summary: summary.outputSummary,
                    status: summary.status,
                    skill_id: summary.skillId ?? null,
                    created_at: summary.createdAt,
                }).catch(() => {});
            }
        } catch (err: any) {
            console.error('⚠️ L4 archiveSession() failed:', err.message);
        }
    }

    async loadRecentSessions(limit = 10): Promise<SessionSummary[]> {
        const supabase = getSupabase();
        if (!supabase) return [];

        try {
            const { data, error } = await supabase
                .from('task_history')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('⚠️ L4 loadRecentSessions() Supabase error:', error.message);
                return [];
            }

            return (data || []).map((r: any) => ({
                sessionId: r.id,
                agentName: r.agent_name,
                taskType: r.task_type,
                inputSummary: r.input_summary,
                outputSummary: r.output_summary,
                status: r.status,
                skillId: r.skill_id ?? undefined,
                createdAt: r.created_at,
            }));
        } catch (err: any) {
            console.error('⚠️ L4 loadRecentSessions() failed:', err.message);
            return [];
        }
    }
}

export const memoryLayerManager = new MemoryLayerManager();
