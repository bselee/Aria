/**
 * @file    src/lib/copilot/artifacts.ts
 * @purpose Shared artifact normalization for Telegram and dashboard.
 *
 *          Both channels produce the same CopilotArtifact shape so that
 *          context assembly, referential binding, and tool routing are
 *          channel-agnostic.
 *
 *          This module handles only normalization (shape creation and
 *          in-memory state).  Persistence to copilot_artifacts is the
 *          caller's responsibility to keep this module testable without DB.
 */

import { randomUUID } from "crypto";
import type { ArtifactSourceType, ArtifactStatus, CopilotArtifact, CopilotChannel } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function channelFromSourceType(sourceType: ArtifactSourceType): CopilotChannel {
    if (sourceType === "dashboard_upload") return "dashboard";
    return "telegram";
}

// ── normalizeArtifact ─────────────────────────────────────────────────────────

export interface NormalizeArtifactInput {
    sourceType:      ArtifactSourceType;
    mimeType:        string;
    filename:        string;
    threadId:        string;
    summary?:        string;
    rawText?:        string;
    structuredData?: Record<string, unknown>;
    tags?:           string[];
    /** Override the generated artifactId (useful for idempotent re-normalization) */
    artifactId?:     string;
    /** Override the initial status (default: "pending") */
    status?:         ArtifactStatus;
}

/**
 * Create a normalized CopilotArtifact from any channel origin.
 * Pure function — no I/O.  Call the Supabase upsert separately.
 */
export async function normalizeArtifact(input: NormalizeArtifactInput): Promise<CopilotArtifact> {
    const {
        sourceType,
        mimeType,
        filename,
        threadId,
        summary,
        rawText,
        structuredData,
        tags,
        artifactId = randomUUID(),
        status     = "pending",
    } = input;

    return {
        artifactId,
        threadId,
        channel:    channelFromSourceType(sourceType),
        sourceType,
        filename,
        mimeType,
        status,
        rawText,
        summary,
        structuredData,
        tags,
        createdAt: new Date().toISOString(),
    };
}
