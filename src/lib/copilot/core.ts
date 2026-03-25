/**
 * @file    src/lib/copilot/core.ts
 * @purpose Shared copilot core — single reasoning path for Telegram and dashboard.
 *
 *          Both channels call runCopilotTurn() for normal Q&A.  Channel adapters
 *          handle their own UI (buttons, callbacks, file ingestion) but delegate
 *          all reasoning to this module.
 *
 *          Provider: unifiedTextGeneration() from llm.ts
 *            - Primary: Claude claude-3-5-sonnet-20241022
 *            - Fallback: GPT-4o
 *
 *          Read path:    direct tool calls
 *          Write path:   not here — route through actions.ts with explicit binding
 */

import { SYSTEM_PROMPT } from "../../config/persona";
import { unifiedTextGeneration } from "../intelligence/llm";
import { buildCopilotContext } from "./context";
import type { CopilotChannel } from "./types";
import type { ArtifactRef } from "./types";

// ── Runtime rules appended to SYSTEM_PROMPT for each turn ───────────────────

const RUNTIME_RULES = `

## LIVE DATA RULE
Memory context is BACKGROUND ONLY.  For prices, costs, stock, PO status, or consumption → ALWAYS call the appropriate tool.  Never answer numeric/status/date data from memory alone.

## BIAS TO ACTION
Never ask clarifying questions when a tool can attempt the task.

## NO HOLLOW FILLER
No "What's next?", "Let me know if you need anything else", etc.

## WRITE GATING
Only execute writes (create PO, approve, send) when you have been explicitly asked AND you have a single concrete target.  If binding is ambiguous, tell the user exactly what is missing.
`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CopilotTurnInput {
    channel:   CopilotChannel;
    text:      string;
    threadId?: string;
    /** Override context inputs — useful for testing without DB */
    contextOverride?: {
        recentArtifacts?: ArtifactRef[];
        recentTurns?: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
    };
}

export interface CopilotTurnResult {
    reply:            string;
    providerUsed:     string;
    toolCalls:        string[];
    actionRefs:       string[];
    /** Artifact bound for this turn (if referential follow-up) */
    boundArtifactId?: string;
}

// ── runCopilotTurn ────────────────────────────────────────────────────────────

export async function runCopilotTurn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    const { channel, text, threadId = "default", contextOverride } = input;

    // Build shared context (conversation window + artifacts)
    const ctx = await buildCopilotContext({
        threadId,
        message: text,
        recentArtifacts: contextOverride?.recentArtifacts,
        recentTurns:     contextOverride?.recentTurns,
    });

    // Assemble the prompt
    const conversationHistory = ctx.turns
        .map(t => `${t.role === "user" ? "User" : "Aria"}: ${t.content}`)
        .join("\n");

    const artifactContext = ctx.artifacts.length > 0
        ? `\n\nRecent artifacts (${ctx.artifacts.length}):\n` +
          ctx.artifacts.map(a => `- [${a.artifactId}] ${a.summary}`).join("\n")
        : "";

    const boundNote = ctx.boundArtifactId
        ? `\n\nBOUND ARTIFACT: ${ctx.boundArtifactId} — the user is referring to this artifact.`
        : "";

    const collapsedNote = ctx.collapsedSummary
        ? `\n\nEarlier context (collapsed): ${ctx.collapsedSummary}`
        : "";

    const prompt = [
        collapsedNote,
        conversationHistory ? `\nConversation so far:\n${conversationHistory}` : "",
        artifactContext,
        boundNote,
        `\nUser (via ${channel}): ${text}`,
    ].filter(Boolean).join("") || text;

    // Call the shared provider chain
    const reply = await unifiedTextGeneration({
        system: SYSTEM_PROMPT + RUNTIME_RULES,
        prompt,
        maxTokens: 1500,
    });

    return {
        reply,
        providerUsed:    "claude-3-5-sonnet / gpt-4o",
        toolCalls:       [],   // Populated when tool routing is wired in (Task 5+)
        actionRefs:      [],
        boundArtifactId: ctx.boundArtifactId,
    };
}
