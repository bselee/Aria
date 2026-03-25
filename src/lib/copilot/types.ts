/**
 * @file    src/lib/copilot/types.ts
 * @purpose Shared type definitions for the copilot layer.
 *          Backed by copilot_artifacts and copilot_action_sessions tables.
 */

// ── Status enums ──────────────────────────────────────────────────────────────

export type ArtifactStatus = "pending" | "ready" | "expired";

export type ArtifactSourceType =
    | "telegram_photo"
    | "telegram_document"
    | "dashboard_upload"
    | "sandbox_drop";

/** Result of a read tool invocation */
export type ReadToolStatus = "success" | "no_result" | "failed" | "retryable";

/** Result of a write action */
export type ActionStatus = "success" | "needs_confirmation" | "failed" | "partial_success";

/** Lifecycle state of a durable action session */
export type ActionSessionStatus = "pending" | "confirmed" | "cancelled" | "expired";

/** Copilot channel identifiers */
export type CopilotChannel = "telegram" | "dashboard";

// ── Core shapes ───────────────────────────────────────────────────────────────

/**
 * Normalized artifact — single shape regardless of channel origin.
 * Stored in copilot_artifacts table.
 */
export interface CopilotArtifact {
    artifactId:     string;
    threadId:       string;
    channel:        CopilotChannel;
    sourceType:     ArtifactSourceType;
    filename:       string;
    mimeType:       string;
    status:         ArtifactStatus;
    rawText?:       string;
    /** Short human-readable description with extracted entities and action candidates */
    summary?:       string;
    /** Extracted structured data (e.g. ULINE cart items: [{sku, qty, unitPrice}]) */
    structuredData?: Record<string, unknown>;
    tags?:          string[];
    createdAt:      string;   // ISO-8601
}

/**
 * Durable pending action session — survives pm2 restart.
 * Stored in copilot_action_sessions table.
 * Replaces in-memory pendingDropships / po-sender state.
 */
export interface CopilotActionSession {
    sessionId:          string;
    channel:            CopilotChannel;
    actionType:         string;   // "po_send" | "po_review" | "reconcile_approve" | ...
    payload:            Record<string, unknown>;
    status:             ActionSessionStatus;
    telegramMessageId?: number;
    telegramChatId?:    string;
    createdAt:          string;   // ISO-8601
    expiresAt:          string;   // ISO-8601
}

/** Structured result returned by every action service */
export interface ActionResult {
    status:        ActionStatus;
    userMessage:   string;
    logMessage:    string;
    retryAllowed:  boolean;
    safeToRetry:   boolean;
    actionRef?:    string;
    details?:      Record<string, unknown>;
}

/** Compact artifact reference included in context (no rawText payload) */
export interface ArtifactRef {
    artifactId: string;
    summary:    string;
    sourceType: ArtifactSourceType;
    createdAt:  string;
}
