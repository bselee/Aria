/**
 * @file memory-layer-manager.ts
 * @purpose L0-L4 memory taxonomy manager.
 */

import { Pinecone } from "@pinecone-database/pinecone";
import { embed, embedQuery } from "./embedding";
import { getLocalDb } from "@/lib/storage/local-db";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export type MemoryLayer = "L0" | "L1" | "L2" | "L3" | "L4";

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
    status: "success" | "failure" | "shadow";
    skillId?: string;
    createdAt: string;
}

let pc: Pinecone | null = null;

function getPineconeClient(): Pinecone {
    if (!pc) {
        const apiKey = process.env.PINECONE_API_KEY;
        if (!apiKey) throw new Error("PINECONE_API_KEY not set");
        pc = new Pinecone({ apiKey });
    }
    return pc;
}

function getIndex() {
    const client = getPineconeClient();
    const indexName = process.env.PINECONE_INDEX || "gravity-memory";
    const indexHost = process.env.PINECONE_MEMORY_HOST;
    return indexHost ? client.index(indexName, indexHost) : client.index(indexName);
}

function getSupabase() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.warn("Supabase env vars missing, memory-layer writes may fail");
        return null;
    }
    return createSupabaseClient(url, key);
}

export class MemoryLayerManager {
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

            const rows = db.prepare("SELECT id, rule, description, created_at as createdAt FROM meta_rules").all() as {
                id: string;
                rule: string;
                description: string | null;
                createdAt: string;
            }[];

            return rows.map((row) => ({
                id: row.id,
                rule: row.rule,
                description: row.description ?? undefined,
                createdAt: row.createdAt,
            }));
        } catch (err: any) {
            console.error("loadMetaRules() failed:", err.message);
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

    async index(key: string, metadata: Record<string, unknown>): Promise<void> {
        try {
            const vector = await embed((metadata.text as string) ?? JSON.stringify(metadata));
            if (!vector) return;

            await getIndex().namespace("insight-index").upsert([{
                id: `insight-${key}`,
                values: vector,
                metadata: {
                    ...metadata,
                    key,
                    indexed_at: new Date().toISOString(),
                },
            }]);
        } catch (err: any) {
            console.error("L1 index() failed:", err.message);
        }
    }

    async search(query: string, limit = 5): Promise<SearchResult[]> {
        try {
            const vector = await embedQuery(query);
            if (!vector) return [];

            const results = await getIndex().namespace("insight-index").query({
                vector,
                topK: limit,
                includeMetadata: true,
            });

            return (results.matches || []).map((match) => {
                const metadata = match.metadata as Record<string, unknown>;
                return {
                    id: match.id,
                    key: (metadata.key as string) ?? match.id,
                    score: match.score ?? 0,
                    metadata,
                };
            });
        } catch (err: any) {
            console.error("L1 search() failed:", err.message);
            return [];
        }
    }

    async remember(category: string, data: unknown, ttlSeconds?: number): Promise<void> {
        try {
            const vector = await embed(typeof data === "string" ? data : JSON.stringify(data));
            if (!vector) return;

            const key = `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const expiresAt = ttlSeconds
                ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
                : undefined;

            await getIndex().namespace("aria-memory").upsert([{
                id: key,
                values: vector,
                metadata: {
                    category,
                    data,
                    expiresAt: expiresAt ?? "",
                    stored_at: new Date().toISOString(),
                },
            }]);

            const supabase = getSupabase();
            if (supabase) {
                await supabase.from("memories").upsert({
                    id: key,
                    category,
                    data,
                    expires_at: expiresAt,
                    created_at: new Date().toISOString(),
                });
            }
        } catch (err: any) {
            console.error("L2 remember() failed:", err.message);
        }
    }

    async recall(category: string, query: string): Promise<MemoryRecord[]> {
        try {
            const vector = await embedQuery(query);
            if (!vector) return [];

            const results = await getIndex().namespace("aria-memory").query({
                vector,
                topK: 10,
                includeMetadata: true,
                filter: { category: { $eq: category } },
            });

            const now = new Date();
            return (results.matches || [])
                .filter((match) => {
                    const metadata = match.metadata as Record<string, unknown>;
                    const expiresAt = metadata.expiresAt as string | undefined;
                    if (!expiresAt) return true;
                    return new Date(expiresAt) > now;
                })
                .map((match) => {
                    const metadata = match.metadata as Record<string, unknown>;
                    return {
                        layer: "L2" as MemoryLayer,
                        category: metadata.category as string,
                        key: match.id,
                        data: metadata.data,
                        ttlSeconds: metadata.expiresAt
                            ? Math.max(0, Math.floor((new Date(metadata.expiresAt as string).getTime() - now.getTime()) / 1000))
                            : undefined,
                        createdAt: new Date((metadata.stored_at as string | undefined) ?? Date.now()),
                    };
                });
        } catch (err: any) {
            console.error("L2 recall() failed:", err.message);
            return [];
        }
    }

    async archiveSession(sessionId: string, summary: SessionSummary): Promise<void> {
        try {
            const text = [
                `Session: ${sessionId}`,
                `Agent: ${summary.agentName}`,
                `Task: ${summary.taskType}`,
                `Input: ${summary.inputSummary}`,
                `Output: ${summary.outputSummary}`,
                `Status: ${summary.status}`,
            ].join("\n");
            const vector = await embed(text);

            if (vector) {
                await getIndex().namespace("session-archive").upsert([{
                    id: `session-${sessionId}`,
                    values: vector,
                    metadata: {
                        sessionId,
                        agentName: summary.agentName,
                        taskType: summary.taskType,
                        inputSummary: summary.inputSummary,
                        outputSummary: summary.outputSummary,
                        status: summary.status,
                        skillId: summary.skillId ?? "",
                        created_at: summary.createdAt,
                    },
                }]);
            }
        } catch (err: any) {
            console.error("L4 archiveSession() failed:", err.message);
        }

        const supabase = getSupabase();
        if (!supabase) return;

        try {
            await supabase.from("task_history").insert({
                agent_name: summary.agentName,
                task_type: summary.taskType,
                input_summary: summary.inputSummary,
                output_summary: summary.outputSummary,
                status: summary.status,
                skill_id: summary.skillId ?? null,
                created_at: summary.createdAt,
            });
        } catch (err: any) {
            console.error("L4 archiveSession() task_history insert failed:", err.message);
        }
    }

    async loadRecentSessions(limit = 10): Promise<SessionSummary[]> {
        const supabase = getSupabase();
        if (!supabase) return [];

        try {
            const { data, error } = await supabase
                .from("task_history")
                .select("*")
                .order("created_at", { ascending: false })
                .limit(limit);

            if (error) {
                console.error("L4 loadRecentSessions() Supabase error:", error.message);
                return [];
            }

            return (data || []).map((row: any) => ({
                sessionId: row.id,
                agentName: row.agent_name,
                taskType: row.task_type,
                inputSummary: row.input_summary,
                outputSummary: row.output_summary,
                status: row.status,
                skillId: row.skill_id ?? undefined,
                createdAt: row.created_at,
            }));
        } catch (err: any) {
            console.error("L4 loadRecentSessions() failed:", err.message);
            return [];
        }
    }
}

export const memoryLayerManager = new MemoryLayerManager();
