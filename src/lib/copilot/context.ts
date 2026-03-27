/**
 * @file    src/lib/copilot/context.ts
 * @purpose Shared context assembly for the copilot layer.
 *
 *          Owns truncation and budget enforcement so channel adapters never
 *          need to think about prompt size.  Telegram and dashboard both call
 *          buildCopilotContext() before invoking the shared core.
 *
 * Token budget target: 8–10k tokens of pre-tool context.
 *
 * Windows:
 *   - Conversation turns:     last 8, newest verbatim
 *   - Artifacts:              last 3 summaries (no raw payloads unless bound)
 *   - Operational references: last 2 (draft PO, recent invoice/reconciliation)
 *
 * Oversize handling: collapse older turns into a rolling thread summary,
 * keep recent turns verbatim, keep structured artifact summaries only.
 */

import { createClient } from "../supabase";
import type { ArtifactRef } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_TURNS     = 8;
const MAX_ARTIFACTS = 3;
const CHAR_BUDGET   = 32_000;   // ~8k tokens @ ~4 chars/token

// Referential follow-up signal words.  When the current message contains any of
// these, force-bind the latest artifact into context.
const REFERENTIAL_SIGNALS = [
    /\bthis\b/i,
    /\bthat\b/i,
    /\bthese\b/i,
    /\bthose\b/i,
    /\bscreenshot\b/i,
    /\bphoto\b/i,
    /\bimage\b/i,
    /\bthe items\b/i,
    /\badd these\b/i,
    /\badd those\b/i,
    /\bthe cart\b/i,
    /\bthe order\b/i,
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
    role:      "user" | "assistant";
    content:   string;
    createdAt: string;
}

interface OperationalRef {
    type:    "draft_po" | "invoice" | "reconciliation";
    id:      string;
    summary: string;
}

export interface CopilotContextInput {
    threadId:           string;
    message:            string;
    /** Pre-fetched artifact refs — if omitted, fetched from DB */
    recentArtifacts?:   ArtifactRef[];
    /** Pre-fetched conversation turns — if omitted, fetched from DB */
    recentTurns?:       ConversationTurn[];
    /** Pre-fetched operational refs — if omitted, fetched from DB */
    operationalRefs?:   OperationalRef[];
}

export interface CopilotContext {
    threadId:          string;
    currentMessage:    string;
    turns:             ConversationTurn[];
    artifacts:         ArtifactRef[];
    /** Set when current message is referential and at least one artifact exists */
    boundArtifactId?:  string;
    operationalRefs:   OperationalRef[];
    /** Present when older turns were collapsed to fit the budget */
    collapsedSummary?: string;
    estimatedChars:    number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isReferential(message: string): boolean {
    return REFERENTIAL_SIGNALS.some(re => re.test(message));
}

function estimateChars(ctx: Omit<CopilotContext, "estimatedChars">): number {
    return (
        ctx.currentMessage.length +
        ctx.turns.reduce((s, t) => s + t.content.length, 0) +
        ctx.artifacts.reduce((s, a) => s + (a.summary?.length ?? 0), 0) +
        ctx.operationalRefs.reduce((s, r) => s + r.summary.length, 0) +
        (ctx.collapsedSummary?.length ?? 0)
    );
}

function collapseOldTurns(turns: ConversationTurn[]): {
    verbatim:  ConversationTurn[];
    summary:   string | undefined;
} {
    if (turns.length <= MAX_TURNS) return { verbatim: turns, summary: undefined };

    // Keep last MAX_TURNS verbatim; collapse the rest into a one-liner summary
    const verbatim = turns.slice(-MAX_TURNS);
    const collapsed = turns.slice(0, -MAX_TURNS);
    const summary = `[Earlier conversation: ${collapsed.length} turns covering: ${
        collapsed
            .filter(t => t.role === "user")
            .map(t => t.content.slice(0, 60))
            .join("; ")
            .slice(0, 300)
    }...]`;
    return { verbatim, summary };
}

// ── DB fetch helpers ──────────────────────────────────────────────────────────

async function fetchTurnsFromDB(threadId: string): Promise<ConversationTurn[]> {
    try {
        const db = createClient();
        if (!db) return [];
        const { data } = await db
            .from("sys_chat_logs")
            .select("role, content, created_at, metadata")
            .contains("metadata", { thread_id: threadId })
            .order("created_at", { ascending: false })
            .limit(MAX_TURNS * 2);  // fetch extra, trim below

        if (!data) return [];
        return data
            .filter((r: any) => ["user", "assistant"].includes(r.role))
            .map((r: any): ConversationTurn => ({
                role:      r.role as "user" | "assistant",
                content:   r.content,
                createdAt: r.created_at,
            }))
            .reverse();   // oldest first
    } catch {
        return [];
    }
}

async function fetchArtifactsFromDB(threadId: string): Promise<ArtifactRef[]> {
    try {
        const db = createClient();
        if (!db) return [];
        const { data } = await db
            .from("copilot_artifacts")
            .select("artifact_id, summary, source_type, created_at")
            .eq("thread_id", threadId)
            .eq("status", "ready")
            .order("created_at", { ascending: false })
            .limit(MAX_ARTIFACTS);

        if (!data) return [];
        return data.map((r: any): ArtifactRef => ({
            artifactId: r.artifact_id,
            summary:    r.summary ?? "",
            sourceType: r.source_type,
            createdAt:  r.created_at,
        }));
    } catch {
        return [];
    }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function buildCopilotContext(input: CopilotContextInput): Promise<CopilotContext> {
    const {
        threadId,
        message,
        recentArtifacts,
        recentTurns,
        operationalRefs = [],
    } = input;

    // Fetch conversation turns
    const rawTurns: ConversationTurn[] = recentTurns
        ?? await fetchTurnsFromDB(threadId);

    // Collapse oversize conversation window
    const { verbatim: turns, summary: collapsedSummary } = collapseOldTurns(rawTurns);

    // Fetch artifacts
    const rawArtifacts: ArtifactRef[] = recentArtifacts
        ?? await fetchArtifactsFromDB(threadId);

    // Keep most recent MAX_ARTIFACTS, sorted newest-first
    const artifacts = [...rawArtifacts]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, MAX_ARTIFACTS);

    // Referential binding: if the message references prior content, bind newest artifact
    const referential = isReferential(message);
    const boundArtifactId = (referential && artifacts.length > 0)
        ? artifacts[0].artifactId
        : undefined;

    const ctx: Omit<CopilotContext, "estimatedChars"> = {
        threadId,
        currentMessage: message,
        turns,
        artifacts,
        boundArtifactId,
        operationalRefs,
        collapsedSummary,
    };

    return { ...ctx, estimatedChars: estimateChars(ctx) };
}
