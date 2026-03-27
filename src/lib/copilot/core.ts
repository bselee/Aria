/**
 * @file    src/lib/copilot/core.ts
 * @purpose Shared copilot core for Telegram and dashboard normal Q&A.
 */

import { SYSTEM_PROMPT } from "../../config/persona";
import { unifiedToolTextGeneration } from "../intelligence/llm";
import { validateWriteIntent } from "./actions";
import { buildCopilotContext } from "./context";
import { getSharedReadTools } from "./tools";
import type { CopilotChannel, ArtifactRef } from "./types";

const RUNTIME_RULES = `

## LIVE DATA RULE
Memory context is background only. For prices, costs, stock, PO status, invoices, or consumption, call the appropriate read tool. Never answer numeric, status, or date data from memory alone.

## BIAS TO ACTION
Never ask a clarifying question when a read tool can attempt the lookup.

## NO HOLLOW FILLER
No "What's next?", "Let me know if you need anything else", or similar filler.

## READ TOOL HONESTY
This shared core currently has read tools only. Never claim a PO was created, sent, approved, or updated unless an explicit action service confirms it.

## WRITE GATING
If the user is asking for a write action and the target is missing or ambiguous, explain exactly what is missing.
`;

export interface CopilotTurnInput {
    channel: CopilotChannel;
    text: string;
    threadId?: string;
    contextOverride?: {
        recentArtifacts?: ArtifactRef[];
        recentTurns?: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>;
    };
}

export interface CopilotTurnResult {
    reply: string;
    providerUsed: string;
    toolCalls: string[];
    actionRefs: string[];
    boundArtifactId?: string;
}

function resolveCandidateTargets(input: {
    text: string;
    boundArtifactId?: string;
    operationalRefs: Array<{ type: string; id: string }>;
}): string[] {
    const targets = new Set<string>();
    const poRegex = /\b(?:po|order)\s*#?\s*([A-Za-z0-9-]+)\b/gi;

    for (const match of input.text.matchAll(poRegex)) {
        const id = match[1]?.trim();
        if (id) {
            targets.add(`po:${id}`);
        }
    }

    for (const ref of input.operationalRefs) {
        if (ref.id) {
            targets.add(`${ref.type}:${ref.id}`);
        }
    }

    if (input.boundArtifactId && /\b(add|draft|create|update)\b/i.test(input.text)) {
        targets.add(`artifact:${input.boundArtifactId}`);
    }

    return [...targets];
}

export async function runCopilotTurn(input: CopilotTurnInput): Promise<CopilotTurnResult> {
    const { channel, text, threadId = "default", contextOverride } = input;

    const ctx = await buildCopilotContext({
        threadId,
        message: text,
        recentArtifacts: contextOverride?.recentArtifacts,
        recentTurns: contextOverride?.recentTurns,
    });

    const conversationHistory = ctx.turns
        .map(turn => `${turn.role === "user" ? "User" : "Aria"}: ${turn.content}`)
        .join("\n");

    const artifactContext = ctx.artifacts.length > 0
        ? `\n\nRecent artifacts (${ctx.artifacts.length}):\n${ctx.artifacts.map(artifact => `- [${artifact.artifactId}] ${artifact.summary}`).join("\n")}`
        : "";

    const boundNote = ctx.boundArtifactId
        ? `\n\nBOUND ARTIFACT: ${ctx.boundArtifactId} - the user is referring to this artifact.`
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

    const candidateTargets = resolveCandidateTargets({
        text,
        boundArtifactId: ctx.boundArtifactId,
        operationalRefs: ctx.operationalRefs.map(ref => ({ type: ref.type, id: ref.id })),
    });

    const writeIntent = await validateWriteIntent({
        text,
        candidateTargets,
    });

    if (writeIntent.status === "needs_confirmation") {
        return {
            reply: writeIntent.userMessage,
            providerUsed: "write-gating",
            toolCalls: [],
            actionRefs: [],
            boundArtifactId: ctx.boundArtifactId,
        };
    }

    const generation = await unifiedToolTextGeneration({
        system: SYSTEM_PROMPT + RUNTIME_RULES,
        prompt,
        maxTokens: 1500,
        tools: getSharedReadTools({ threadId }),
    });

    return {
        reply: generation.text,
        providerUsed: generation.providerUsed,
        toolCalls: generation.toolCalls,
        actionRefs: [],
        boundArtifactId: ctx.boundArtifactId,
    };
}
