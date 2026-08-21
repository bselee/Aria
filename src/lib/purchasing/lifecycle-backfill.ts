/**
 * @file    src/lib/purchasing/lifecycle-backfill.ts
 * @purpose Pure, side-effect-free logic for the PO lifecycle corruption
 *          backfill. Determines the correct canonical lifecycle state for a
 *          purchase_orders row from the four competing columns
 *          (lifecycle_state, lifecycle_stage, lifecycle_stage_legacy, status)
 *          plus receipt/invoice evidence, and provides the status<->stage
 *          alignment helper.
 *
 *          BACKGROUND (2026-07-27 unfiltered-PATCH bug):
 *            A dropped predicate in the PostgREST client shipped a PATCH with
 *            no WHERE, stamping purchase_orders.lifecycle_state = 'RECEIVED'
 *            on ~1,122 rows. lifecycle_stage_legacy holds the pre-corruption
 *            snapshot for the 311 rows that were at 'l3_escalated'; the rest
 *            are NULL. This module's determineCorrectStage() un-stamps those
 *            rows using receipt evidence first, then the legacy snapshot, then
 *            the surviving lifecycle_stage value, then invoice/ack/sent
 *            evidence, and finally REVIEW as the safe default.
 *
 * @author  aria-coder
 * @created 2026-08-12
 * @deps    ./po-lifecycle
 */

import {
    normalizeLifecycleStage,
    type POLifecycleState,
    PO_LIFECYCLE_STATES,
} from "./po-lifecycle";

/** Local alias so downstream callers can use the more descriptive name. */
export type POLifecycleStage = POLifecycleState;

/**
 * Normalized row shape consumed by determineCorrectStage(). The caller (CLI)
 * is responsible for pre-computing the receipt-evidence boolean from the
 * concrete signals (receive_date, activity_po_received ledger rows,
 * ap_activity_log PO_RECEIVED intent).
 */
export interface LifecycleBackfillRow {
    poNumber: string;
    /** Finale-synced PO status ('open' | 'closed' | 'received' | ...). */
    status: string | null;
    /** Canonical state-machine column (may be corrupted to RECEIVED). */
    lifecycleState: string | null;
    /** Legacy lifecycle column (may hold non-canonical sub-states). */
    lifecycleStage: string | null;
    /** Pre-corruption snapshot column. */
    lifecycleStageLegacy: string | null;
    /** True when any concrete receipt evidence exists (see caller). */
    hasReceiptEvidence: boolean;
    /** True when an invoice exists for this PO (invoices OR vendor_invoices). */
    hasInvoice: boolean;
    /** vendor_acknowledged_at is set. */
    vendorAcknowledged: boolean;
    /** po_sent_at / po_email_message_id / tracking present. */
    wasSent: boolean;
}

/** Result of determineCorrectStage(). */
export interface LifecycleBackfillDecision {
    poNumber: string;
    stage: POLifecycleStage;
    /** Human-readable reasons for the decision (ordered by precedence). */
    evidence: string[];
    /** Whether the decision differs from the current lifecycle_state. */
    changed: boolean;
    /** True when the row was un-stamping a corrupted RECEIVED. */
    isCorruptionFix: boolean;
}

/**
 * Evidence-only fallback used when no column holds a usable canonical value.
 * Precedence: invoice -> INVOICED, vendor ack -> ACKNOWLEDGED, sent -> SENT,
 * else REVIEW.
 */
function evidenceFallback(row: LifecycleBackfillRow): POLifecycleStage {
    if (row.hasInvoice) return "INVOICED";
    if (row.vendorAcknowledged) return "ACKNOWLEDGED";
    if (row.wasSent) return "SENT";
    return "REVIEW";
}

/**
 * Determine the correct canonical lifecycle stage for a PO row.
 *
 * Precedence (highest wins):
 *   1. Receipt evidence                -> RECEIVED
 *   2. Finale closed / legacy cancelled-> CANCELLED
 *   3. Corrupted RECEIVED (no receipt) -> restore from legacy -> stage -> evidence
 *   4. Canonical lifecycle_state       -> keep
 *   5. Canonical lifecycle_stage       -> use
 *   6. Evidence fallback               -> INVOICED/ACKNOWLEDGED/SENT/REVIEW
 *
 * @param row - Normalized row (see LifecycleBackfillRow).
 * @returns Decision with stage, evidence, and corruption flag.
 */
export function determineCorrectStage(row: LifecycleBackfillRow): LifecycleBackfillDecision {
    const evidence: string[] = [];
    let stage: POLifecycleStage;
    let isCorruptionFix = false;

    const currentState = normalizeLifecycleStage(row.lifecycleState);

    // ── 0. Terminal states are STICKY ─────────────────────────────────────
    // COMPLETED and CANCELLED are terminal — never downgrade or "un-cancel"
    // them, even if a lower-precedence signal (receipt / closed) disagrees.
    // This protects the shipped 3-way-match COMPLETED gate (t_7ada1a45).
    if (currentState === "COMPLETED" || currentState === "CANCELLED") {
        evidence.push(`existing terminal state '${currentState}' (sticky, kept)`);
        stage = currentState;
    }
    // ── 1. Cancelled (Finale closed OR legacy lifecycle_stage CANCELLED) ──
    // Precedes receipt: a Finale-closed PO is terminal even if a receive_date
    // was also recorded (mirrors analyze-po-state-backfill.ts precedence).
    else if (
        String(row.status || "").toLowerCase() === "closed" ||
        normalizeLifecycleStage(row.lifecycleStage) === "CANCELLED"
    ) {
        evidence.push(
            String(row.status || "").toLowerCase() === "closed"
                ? "Finale status='closed' (cancelled/terminal)"
                : "lifecycle_stage already CANCELLED"
        );
        stage = "CANCELLED";
    }
    // ── 2. Receipt evidence (physical goods received) ──
    else if (row.hasReceiptEvidence) {
        evidence.push("receipt evidence present (receive_date / status='received' / activity_po_received / PO_RECEIVED)");
        stage = "RECEIVED";
    }
    // ── 3. Corrupted RECEIVED: a RECEIVED stamp with no receipt evidence ──
    else if (
        currentState === "RECEIVED" ||
        normalizeLifecycleStage(row.lifecycleStage) === "RECEIVED"
    ) {
        isCorruptionFix = true;
        const legacy = normalizeLifecycleStage(row.lifecycleStageLegacy);
        const stageNorm = normalizeLifecycleStage(row.lifecycleStage);

        // 3a. Restore from the pre-corruption snapshot (l3_escalated -> SENT).
        if (legacy && legacy !== "RECEIVED" && legacy !== "CANCELLED") {
            evidence.push(`un-stamped RECEIVED (no receipt) -> restored from lifecycle_stage_legacy '${row.lifecycleStageLegacy}'`);
            stage = legacy;
        }
        // 3b. Restore from the surviving lifecycle_stage value.
        else if (stageNorm && stageNorm !== "RECEIVED" && stageNorm !== "CANCELLED") {
            evidence.push(`un-stamped RECEIVED (no receipt) -> restored from lifecycle_stage '${row.lifecycleStage}'`);
            stage = stageNorm;
        }
        // 3c. No usable snapshot — fall back to evidence.
        else {
            evidence.push("un-stamped RECEIVED (no receipt, no legacy/stage snapshot) -> evidence fallback");
            stage = evidenceFallback(row);
        }
    }
    // ── 4. Canonical lifecycle_state (already correct, keep it) ──
    else if (currentState) {
        evidence.push(`existing lifecycle_state='${currentState}' (canonical, kept)`);
        stage = currentState;
    }
    // ── 5. Canonical lifecycle_stage ──
    else if (normalizeLifecycleStage(row.lifecycleStage)) {
        evidence.push(`lifecycle_state NULL/non-canonical -> lifecycle_stage='${normalizeLifecycleStage(row.lifecycleStage)}'`);
        stage = normalizeLifecycleStage(row.lifecycleStage) as POLifecycleStage;
    }
    // ── 6. Evidence fallback ──
    else {
        evidence.push("no canonical state or stage -> evidence fallback");
        stage = evidenceFallback(row);
    }

    const changed = currentState !== stage;
    return { poNumber: row.poNumber, stage, evidence, changed, isCorruptionFix };
}

/** Canonical stage set (for callers that want to validate output). */
export const CANONICAL_LIFECYCLE_STAGES = PO_LIFECYCLE_STATES;
