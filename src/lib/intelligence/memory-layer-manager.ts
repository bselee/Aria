/**
 * @file memory-layer-manager.ts
 * @purpose L0-L4 memory taxonomy manager.
 *
 * HERMIA(2026-05-28): Migrated all Pinecone calls to local SQLite memory-store.ts.
 * HERMIA(2026-07-01): Removed all Supabase backup writes. SQLite is the sole store.
 * insight-index, aria-memory, and session-archive namespaces now use memory_vectors table.
 */

import { embed, embedQuery } from "./embedding";
import { upsertVector, queryVectors } from "@/lib/storage/memory-store";
import { getLocalDb } from "@/lib/storage/local-db";

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

// HERMIA(2026-05-28): Pinecone client removed. All vector ops now use memory-store.ts.
// HERMIA(2026-07-01): Supabase backup removed. SQLite is the sole store.

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

            upsertVector("insight-index", `insight-${key}`, new Float32Array(vector), {
                ...metadata,
                key,
                indexed_at: new Date().toISOString(),
            });
        } catch (err: any) {
            console.error("L1 index() failed:", err.message);
        }
    }

    async search(query: string, limit = 5): Promise<SearchResult[]> {
        try {
            const vector = await embedQuery(query);
            if (!vector) return [];

            const results = queryVectors("insight-index", new Float32Array(vector), {
                topK: limit,
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

            upsertVector("aria-memory", key, new Float32Array(vector), {
                category,
                data: typeof data === "string" ? data : JSON.stringify(data),
                expiresAt: expiresAt ?? "",
                stored_at: new Date().toISOString(),
            });
        } catch (err: any) {
            console.error("L2 remember() failed:", err.message);
        }
    }

    async recall(category: string, query: string): Promise<MemoryRecord[]> {
        try {
            const vector = await embedQuery(query);
            if (!vector) return [];

            const results = queryVectors("aria-memory", new Float32Array(vector), {
                topK: 10,
                filter: { category: category },
            });

            const now = new Date();
            return results
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
                upsertVector("session-archive", `session-${sessionId}`, new Float32Array(vector), {
                    sessionId,
                    agentName: summary.agentName,
                    taskType: summary.taskType,
                    inputSummary: summary.inputSummary,
                    outputSummary: summary.outputSummary,
                    status: summary.status,
                    skillId: summary.skillId ?? "",
                    created_at: summary.createdAt,
                });
            }
        } catch (err: any) {
            console.error("L4 archiveSession() failed:", err.message);
        }

        // Also write to local task_history table for durability
        try {
            const db = getLocalDb();
            db.exec(`
                CREATE TABLE IF NOT EXISTS task_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    agent_name TEXT,
                    task_type TEXT,
                    input_summary TEXT,
                    output_summary TEXT,
                    status TEXT,
                    skill_id TEXT,
                    created_at TEXT
                )
            `);
            db.prepare(`
                INSERT INTO task_history (session_id, agent_name, task_type, input_summary, output_summary, status, skill_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                sessionId,
                summary.agentName,
                summary.taskType,
                summary.inputSummary,
                summary.outputSummary,
                summary.status,
                summary.skillId ?? null,
                summary.createdAt,
            );
        } catch (err: any) {
            console.error("L4 archiveSession() task_history insert failed:", err.message);
        }
    }

    async loadRecentSessions(limit = 10): Promise<SessionSummary[]> {
        try {
            const db = getLocalDb();
            db.exec(`
                CREATE TABLE IF NOT EXISTS task_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    agent_name TEXT,
                    task_type TEXT,
                    input_summary TEXT,
                    output_summary TEXT,
                    status TEXT,
                    skill_id TEXT,
                    created_at TEXT
                )
            `);
            const rows = db.prepare(
                "SELECT * FROM task_history ORDER BY created_at DESC LIMIT ?"
            ).all(limit) as Array<{
                id: number;
                session_id: string;
                agent_name: string;
                task_type: string;
                input_summary: string;
                output_summary: string;
                status: string;
                skill_id: string | null;
                created_at: string;
            }>;

            return rows.map((row) => ({
                sessionId: row.session_id,
                agentName: row.agent_name,
                taskType: row.task_type,
                inputSummary: row.input_summary,
                outputSummary: row.output_summary,
                status: row.status as "success" | "failure" | "shadow",
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
