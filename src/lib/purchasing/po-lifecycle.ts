/**
 * @file    src/lib/purchasing/po-lifecycle.ts
 * @purpose PO lifecycle state machine — tracks every PO through
 *          REVIEW → SENT → ACKNOWLEDGED → INVOICED → RECONCILED → RECEIVED → COMPLETED
 *          Plus CANCELLED as a terminal state.
 *          ORDERED is retained as a legacy alias for data compatibility.
 * @author  Hermia
 * @created 2026-06-01
 * @updated 2026-08-11 (3-way gate: real receivedQtys, packMultipliers, return blockReason)
 * @deps    @/lib/db
 *
 * All functions are best-effort (try/catch, never throw) so they can
 * @deps    @/lib/db
 */

import { createClient } from "@/lib/db";
import { getLocalDb } from "@/lib/storage/local-db";
import {
    evaluateCompletionGate,
    extractInvoiceLines,
    type GatePoLine,
} from "./completion-gate";

/** Valid lifecycle states */
export const PO_LIFECYCLE_STATES = [
    "ORDERED",        // legacy — kept for backward-compat with existing data
    "REVIEW",         // draft created in Finale, awaiting human review
    "SENT",           // PO dispatched to vendor via email
    "ACKNOWLEDGED",   // vendor replied confirming receipt
    "INVOICED",       // invoice received and matched
    "RECONCILED",     // invoice lines reconciled against PO
    "RECEIVED",       // goods received (partial or full)
    "COMPLETED",      // all done
    "CANCELLED",      // PO cancelled — terminal
] as const;

export type POLifecycleState = (typeof PO_LIFECYCLE_STATES)[number];

/** Initial state for new POs (replaces legacy ORDERED) */
export const INITIAL_LIFECYCLE_STATE = "REVIEW";

/**
 * Valid state transitions.
 * Backward compatibility: ORDERED maps to same children as REVIEW
 * so existing POs with legacy state can still progress.
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
    // Legacy backward compat
    ORDERED: ["INVOICED", "RECEIVED", "CANCELLED"],
    // Dispatch stages
    REVIEW: ["SENT", "INVOICED", "RECEIVED", "CANCELLED"],
    SENT: ["ACKNOWLEDGED", "INVOICED", "RECEIVED"],
    ACKNOWLEDGED: ["INVOICED", "RECEIVED"],
    // Invoice / fulfillment pipeline
    INVOICED: ["RECONCILED", "RECEIVED", "ACKNOWLEDGED"], // ACKNOWLEDGED = operator unmatch rollback (dashboard-receivings)
    RECONCILED: ["RECEIVED", "COMPLETED"],
    RECEIVED: ["RECONCILED", "COMPLETED"],
    COMPLETED: [], // terminal state
    CANCELLED: [], // terminal state
};

/**
 * HERMIA(2026-07-29): Legacy/lowercase lifecycle values that were written
 * directly to purchase_orders.lifecycle_stage by bypass sites instead of
 * going through transitionLifecycleState(). Evidence: 0 canonical rows,
 * 311 rows on 'l3_escalated', 833 NULL in live DB.
 *
 * Flags/sub-states (moving_with_tracking, ap_follow_up, tracking_unavailable,
 * pending_replacement, urgent_followup_requested, closed_stale, ordered_browser)
 * map to their nearest true stage. The descriptive string is preserved in
 * the metadata argument when transitioning via transitionLifecycleState().
 */
export const LEGACY_STAGE_MAP: Record<string, POLifecycleState> = {
    // Plain case fixes
    sent: "SENT",
    received: "RECEIVED",
    reconciled: "RECONCILED",
    // Already canonical but included for completeness
    ACKNOWLEDGED: "ACKNOWLEDGED",
    // Flags / sub-states that describe a CONDITION, mapped to the true stage
    moving_with_tracking: "SENT",          // sent with tracking numbers
    ap_follow_up: "SENT",                  // follow-up sent, still SENT
    ordered_browser: "SENT",               // dispatched via browser automation
    tracking_unavailable: "SENT",          // sent but no tracking available
    urgent_followup_requested: "SENT",     // urgent follow-up drafted, still SENT
    pending_replacement: "CANCELLED",      // PO being replaced — effectively cancelled
    closed_stale: "CANCELLED",             // stale PO abandoned — effectively cancelled
    // Observed live DB values (beyond the 14 documented bypass sites)
    l3_escalated: "SENT",                  // escalated to L3, still SENT
};

/**
 * Normalize any legacy/lowercase lifecycle value to its canonical
 * UPPERCASE POLifecycleState. Returns null for truly unknown values
 * so callers can decide their own fallback.
 *
 * Examples:
 *   normalizeLifecycleStage("sent")             → "SENT"
 *   normalizeLifecycleStage("moving_with_tracking") → "SENT"
 *   normalizeLifecycleStage("closed_stale")     → "CANCELLED"
 *   normalizeLifecycleStage(null)               → null
 *   normalizeLifecycleStage("bogus")            → null
 */
export function normalizeLifecycleStage(
    raw: string | null
): POLifecycleState | null {
    if (!raw) return null;
    const upper = raw.toUpperCase();
    // Fast path: already canonical (case-insensitive)
    if ((PO_LIFECYCLE_STATES as readonly string[]).includes(upper)) {
        return upper as POLifecycleState;
    }
    // Legacy/rogue map lookup (case-sensitive, all lowercase)
    return LEGACY_STAGE_MAP[raw] ?? null;
}

/** Fallback if state is missing, null, or unknown */
function resolveState(state: string | null): POLifecycleState {
    return normalizeLifecycleStage(state) ?? INITIAL_LIFECYCLE_STATE;
}

/**
 * Map a canonical lifecycle stage to the simple 3-value `status` enum
 * (open / closed / received) that purchase_orders.status uses. Aligns the two
 * enums so dashboard "simple status" views stay consistent with lifecycle.
 *
 *   - RECEIVED                    -> "received"
 *   - CANCELLED / COMPLETED       -> "closed"
 *   - everything else             -> "open"
 */
export function statusForLifecycleStage(
    stage: POLifecycleState | string
): string {
    switch (stage) {
        case "RECEIVED":
            return "received";
        case "CANCELLED":
        case "COMPLETED":
            return "closed";
        default:
            return "open";
    }
}

/**
 * Assert that a state transition is valid.
 * @throws Error if the transition is invalid
 * @internal
 */
export function assertValidTransition(from: string | null, to: string): void {
    const resolved = resolveState(from);
    const allowed = VALID_TRANSITIONS[resolved];
    if (!allowed || !allowed.includes(to)) {
        throw new Error(
            `Invalid PO lifecycle transition: ${resolved} → ${to}. ` +
            `Allowed from ${resolved}: [${(allowed || []).join(", ")}]`
        );
    }
}

/**
 * Get current lifecycle state for a PO.
 * @returns The current state, or REVIEW if no state is recorded
 */
export async function getLifecycleState(
    poNumber: string
): Promise<POLifecycleState | null> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("purchase_orders")
            .select("lifecycle_state")
            .eq("po_number", poNumber)
            .single();

        if (error || !data) return INITIAL_LIFECYCLE_STATE as POLifecycleState;
        return normalizeLifecycleStage(data.lifecycle_state as string | null) ?? INITIAL_LIFECYCLE_STATE;
    } catch (err) {
        console.warn(
            `[po-lifecycle] Failed to get state for PO ${poNumber}:`,
            (err as Error).message
        );
        return null;
    }
}

/**
 * Classify a gate error as transient (DB/network) vs structural (import/type).
 *
 * HERMIA(2026-08-12): the 3-way gate used to fail-open on EVERY error — a
 * broken import or a type error in the gate silently allowed POs through
 * unverified. A transient failure (DB down, timeout) is not evidence the
 * documents disagree, so it stays fail-open. A structural failure means the
 * gate itself is broken, so it fails closed (blocks the transition).
 *
 * @param err The thrown error.
 * @returns true when the error is transient (network/DB) and should fail-open.
 */
export function isTransientGateError(err: unknown): boolean {
    if (!(err instanceof Error)) return false; // non-Error → structural
    const msg = err.message || "";
    if (
        /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EAI_NODATA|network|fetch failed|timed out|timeout|PGRST|connection|aborted|supabase/i.test(
            msg,
        )
    ) {
        return true;
    }
    const status = (err as any).status ?? (err as any).statusCode;
    if (typeof status === "number" && status >= 500) return true;
    return false;
}

/**
 * Transition a PO to a new lifecycle state.
 * Writes to both purchase_orders.lifecycle_state AND po_lifecycle_transitions.
 * Always best-effort — never throws.
 *
 * @param poNumber - Finale PO number
 * @param toState - Target state
 * @param triggeredBy - Who/what triggered this transition (e.g. "ap-agent", "reconciler")
 * @param metadata - Optional extra context (invoice ID, reconciliation verdict, etc.)
 *                   receivedQtys: Record<string, number> — per-SKU actually-received quantities
 *                   packMultipliers: Record<string, number> — per-SKU pack size (invoice UOM → each)
 * @returns { ok: true } if the transition was written, { ok: false, blockReason } if a gate
 *          (e.g. 3-way match) refused the transition.
 */
export async function transitionLifecycleState(
    poNumber: string,
    toState: POLifecycleState,
    triggeredBy: string,
    metadata?: Record<string, unknown>
): Promise<{ ok: boolean; blockReason?: string }> {
    try {
        // Phase 1: Write to local SQLite FIRST — crash-safe write-ahead log
        // If process crashes after this write but before Supabase, the transition
        // is recoverable from local DB on next boot.
        let currentState: string | null = INITIAL_LIFECYCLE_STATE;
        try {
            const db = getLocalDb();
            const existing = db.prepare(
                `SELECT lifecycle_state FROM po_lifecycle_cache WHERE po_number = ?`
            ).get(poNumber) as { lifecycle_state: string } | undefined;
            if (existing) currentState = existing.lifecycle_state;

            // Silent skip: already in the target state
            if (currentState === toState) return { ok: true };

            // Validate transition
            try {
                assertValidTransition(currentState, toState);
            } catch (valErr) {
                console.warn(
                    `[po-lifecycle] ${(valErr as Error).message} — skipping transition`
                );
                return { ok: false, blockReason: (valErr as Error).message };
            }

            // ── HERMIA(2026-08-11): 3-way match gate ─────────────────────────
            // A transition to COMPLETED means the PO, receipt, and invoice are
            // all in; a transition to RECONCILED means the invoice has been
            // matched to the PO. We verify the three documents actually agree
            // before claiming either.
            //
            // This gate is load-bearing: before it existed, both dashboard
            // "Approve" handlers wrote lifecycle_stage='reconciled' to four
            // tables without ever calling Finale, and POs were marked complete
            // before corrections posted, if at all.
            //
            // Gate policy per target state:
            //   - COMPLETED: always gate. FAIL-OPEN when line-item data is
            //     missing (most OCR rows have empty line_items — fail-closed
            //     would brick completion); blocks only on a GENUINE mismatch
            //     once both sides have lines.
            //   - RECONCILED: gate ONLY when a matched invoice AND concrete
            //     receipt evidence both exist. Reconciliation legitimately
            //     precedes physical receipt in the normal AP flow (invoice
            //     arrives before goods), so a missing receipt here is
            //     "incomplete", not a block — the gate simply waits.
            if (toState === "COMPLETED" || toState === "RECONCILED") {
                try {
                // Use createClient() for the 3-way gate — this runs before
                // Phase 2's supabase handle is initialized.
                const gateDb = createClient();
                if (!gateDb) {
                    console.log("[po-lifecycle] 3-way match skipped: DB unavailable");
                } else {
                    // Load PO lines + the matched invoice from vendor_invoices (the
                    // single source of truth for OCR invoice lines) + the receipt
                    // leg from po_receipt_data (Finale shipment receipt items).
                    const [poRes, invRes, receiptRes] = await Promise.all([
                        gateDb
                            .from("purchase_orders")
                            .select("line_items, total, status, receive_date")
                            .eq("po_number", poNumber)
                            .maybeSingle(),
                        gateDb
                            .from("vendor_invoices")
                            .select("line_items, raw_data, total, status")
                            .eq("po_number", poNumber)
                            .order("created_at", { ascending: false })
                            .limit(1)
                            .maybeSingle(),
                        gateDb
                            .from("po_receipt_data")
                            .select("total_received, fully_received, line_items")
                            .eq("po_number", poNumber)
                            .maybeSingle(),
                    ]);

                    const poData = (poRes as any)?.data;
                    const invoiceData = (invRes as any)?.data;
                    const receiptData = (receiptRes as any)?.data;

                    // Concrete receipt evidence: a past receive_date OR actual
                    // receipt quantities from the Finale receipt leg.
                    const poReceiveDatePast =
                        !!(poData as any)?.receive_date &&
                        new Date((poData as any).receive_date).getTime() < Date.now();
                    const hasReceipt =
                        poReceiveDatePast ||
                        (!!receiptData &&
                            (Number(receiptData.total_received) > 0 ||
                                receiptData.fully_received === true));
                    const hasInvoice = !!invoiceData;

                    // RECONCILED gate fires only when BOTH receipt and invoice
                    // exist. Otherwise the verification is genuinely incomplete
                    // (not failed) — skip rather than block.
                    if (toState === "RECONCILED" && !(hasInvoice && hasReceipt)) {
                        console.log(
                            `[po-lifecycle] 3-way match SKIPPED for ${poNumber} → RECONCILED ` +
                                `(receipt=${hasReceipt}, invoice=${hasInvoice}) — incomplete, not failed`,
                        );
                    } else {
                        // Extract received quantities: caller-provided (metadata)
                        // first, then the receipt leg line_items fallback.
                        const receivedQtys: Record<string, number> =
                            (metadata?.receivedQtys as Record<string, number>) ?? {};
                        for (const rl of ((receiptData?.line_items ?? []) as any[])) {
                            if (rl.sku != null && receivedQtys[String(rl.sku)] === undefined) {
                                receivedQtys[String(rl.sku)] = Number(rl.received ?? 0);
                            }
                        }

                        // Pack multipliers: caller-provided > DB-derived (sku_pack_sizes)
                        const metadataPackMultipliers: Record<string, number> =
                            (metadata?.packMultipliers as Record<string, number>) ?? {};

                        const invoiceLines = extractInvoiceLines(invoiceData);
                        const poLines: GatePoLine[] = ((poData?.line_items ?? []) as any[]).map(
                            (pi: any) => ({
                                productId: pi.productId ?? pi.sku ?? pi.description ?? "UNKNOWN",
                                description: pi.description,
                                quantity: Number(pi.quantity ?? 0),
                                unitPrice: Number(pi.unitPrice ?? 0),
                                receivedQty: pi.receivedQty ?? null,
                            }),
                        );

                        // ── Load pack sizes from sku_pack_sizes for UOM normalization ─
                        const dbPackSizes = new Map<string, number>();
                        try {
                            const allSkus = [...new Set([
                                ...poLines.map((l) => l.productId),
                                ...invoiceLines.map((l) => l.sku),
                            ])].filter(Boolean) as string[];
                            if (allSkus.length > 0) {
                                const { getPackSizes } = await import("./pack-size-registry");
                                const sizes = await getPackSizes(allSkus);
                                for (const [sku, rec] of sizes) {
                                    if (rec.unitsPerPack > 1) {
                                        dbPackSizes.set(sku, rec.unitsPerPack);
                                    }
                                }
                            }
                        } catch {
                            // pack sizes are optional — proceed without them
                        }

                        const packMultipliers: Record<string, number> = {};
                        for (const [sku, mult] of dbPackSizes) packMultipliers[sku] = mult;
                        for (const [sku, mult] of Object.entries(metadataPackMultipliers)) {
                            packMultipliers[sku] = mult;
                        }

                        const gateResult = evaluateCompletionGate({
                            orderId: poNumber,
                            hasReceipt,
                            hasInvoice,
                            poLines,
                            invoiceLines,
                            receivedQtys,
                            packMultipliers,
                        });

                        if (!gateResult.ok) {
                            console.warn(
                                `[po-lifecycle] 3-way match BLOCKED → ${toState} for ${poNumber}: ` +
                                    gateResult.blockReason,
                            );
                            return { ok: false, blockReason: gateResult.blockReason };
                        }
                        console.log(
                            `[po-lifecycle] 3-way match PASSED for ${poNumber} → ${toState}: ` +
                                gateResult.summary,
                        );
                    }
                    }
                } catch (gateErr: unknown) {
                    // HERMIA(2026-08-12): distinguish transient failures from
                    // structural ones. A DB-down/network error means the gate
                    // couldn't run — fail-open (log + allow). An import/type
                    // error means the gate itself is broken — fail-closed
                    // (block the transition) so a silently-broken gate can't
                    // stamp POs RECONCILED/COMPLETED unverified.
                    if (isTransientGateError(gateErr)) {
                        console.warn(
                            `[po-lifecycle] 3-way match transient error for ${poNumber} — ` +
                                `allowing transition (belt, not suspenders): ` +
                                `${(gateErr as Error)?.message ?? gateErr}`,
                        );
                    } else {
                        const msg = gateErr instanceof Error ? gateErr.message : String(gateErr);
                        console.error(
                            `[po-lifecycle] 3-way match STRUCTURAL error for ${poNumber} — BLOCKING transition: ${msg}`,
                        );
                        return { ok: false, blockReason: `3-way match gate error: ${msg}` };
                    }
                }
            }

            const now = new Date().toISOString();
            db.prepare(
                `INSERT OR REPLACE INTO po_lifecycle_cache (po_number, lifecycle_state, last_transitioned_at, triggered_by)
                 VALUES (?, ?, ?, ?)`
            ).run(poNumber, toState, now, triggeredBy);
        } catch (localErr) {
            console.warn(
                `[po-lifecycle] Local SQLite write failed for PO ${poNumber}:`,
                (localErr as Error).message
            );
            // Continue to Supabase anyway — local write is best-effort
        }

        // Phase 2: Write to Supabase (durable remote storage)
        const supabase = createClient();
        if (!supabase) {
            console.warn(
                `[po-lifecycle] No Supabase client — skipping transition ${poNumber} → ${toState}`
            );
            return { ok: true }; // Local SQLite write already done above — state is safe
        }

        // Validation already passed in Phase 1 (local SQLite write) — skip duplicate
        const now = new Date().toISOString();

        // Update purchase_orders. Write lifecycle_state AND lifecycle_stage to
        // resolve the column duality (2026-08-12), and keep the simple `status`
        // enum aligned with the stage so an "open" PO can never sit at an
        // impossible stage (RECEIVED/COMPLETED/CANCELLED).
        const { error: updateErr } = await supabase
            .from("purchase_orders")
            .update({
                lifecycle_state: toState,
                lifecycle_stage: toState,
                status: statusForLifecycleStage(toState),
                updated_at: now,
            })
            .eq("po_number", poNumber);

        if (updateErr) {
            console.warn(
                `[po-lifecycle] Failed to update purchase_orders for PO ${poNumber}:`,
                updateErr.message
            );
        }

        // Insert transition audit log
        const resolvedFrom = resolveState(currentState);
        const { error: insertErr } = await supabase
            .from("po_lifecycle_transitions")
            .insert({
                po_number: poNumber,
                from_state: resolvedFrom,
                to_state: toState,
                transitioned_at: now,
                triggered_by: triggeredBy,
                metadata: metadata || null,
                invoice_id: (metadata?.invoiceId as string) || null,
            });

        if (insertErr) {
            console.warn(
                `[po-lifecycle] Failed to log transition for PO ${poNumber}:`,
                insertErr.message
            );
        }

        console.log(
            `[po-lifecycle] ${poNumber}: ${resolvedFrom} → ${toState} (${triggeredBy})`
        );
        return { ok: true };
    } catch (err) {
        console.warn(
            `[po-lifecycle] Unexpected error transitioning PO ${poNumber}:`,
            (err as Error).message
        );
        return { ok: false, blockReason: (err as Error).message };
    }
}

/**
 * Get the last N transition events for a PO.
 */
export async function getPOLifecycleHistory(
    poNumber: string,
    limit: number = 10
): Promise<Array<Record<string, unknown>> | null> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("po_lifecycle_transitions")
            .select("*")
            .eq("po_number", poNumber)
            .order("transitioned_at", { ascending: false })
            .limit(limit);

        if (error) {
            console.warn(
                `[po-lifecycle] Failed to fetch history for PO ${poNumber}:`,
                error.message
            );
            return null;
        }

        return data;
    } catch (err) {
        console.warn(
            `[po-lifecycle] Unexpected error fetching history for PO ${poNumber}:`,
            (err as Error).message
        );
        return null;
    }
}

/**
 * Get a summary of lifecycle states across all POs.
 * Returns counts per state.
 */
export async function getLifecycleSummary(): Promise<
    Record<string, number> | null
> {
    try {
        const supabase = createClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from("purchase_orders")
            .select("lifecycle_state");

        if (error || !data) return null;

        const counts: Record<string, number> = {};
        for (const row of data) {
            const state = normalizeLifecycleStage(row.lifecycle_state as string | null) ?? INITIAL_LIFECYCLE_STATE;
            counts[state] = (counts[state] || 0) + 1;
        }
        return counts;
    } catch (err) {
        console.warn(
            `[po-lifecycle] Failed to get lifecycle summary:`,
            (err as Error).message
        );
        return null;
    }
}