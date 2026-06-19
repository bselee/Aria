/**
 * @file    reconciliation-auto-apply.ts
 * @purpose Cron watcher that automatically applies RECONCILIATION results
 *          whose overallVerdict is "auto_approve" or "no_change" to Finale
 *          POs. The reconciliation engine computes the changes and writes the
 *          verdict to ap_activity_log — this watcher executes the writes.
 *
 *          Flow:
 *            1. Load RECONCILIATION rows (last 120d) with
 *               overallVerdict IN ('auto_approve', 'no_change')
 *            2. Filter to ones NOT already processed (RECONCILIATION_AUTO_APPLIED
 *               dedup by orderId::invoiceNumber composite key)
 *            3. For each unprocessed row:
 *               a. Reconstruct ReconciliationResult from stored metadata
 *                  (handles both buildAuditMetadata and enqueueForDashboardReview
 *                  metadata formats)
 *               b. Call applyReconciliation() with ALL items/fees approved
 *               c. If feeChanges include FREIGHT, call finaleClient.completeOrder()
 *               d. Write RECONCILIATION_AUTO_APPLIED activity row
 *               e. On error, write RECONCILIATION_ERROR row
 *
 *          Gated by PO_AUTO_COMPLETE_ENABLED env var (same as po-auto-complete).
 *          When disabled, dry-runs (logs what it WOULD apply, writes nothing).
 */

import { createClient } from "../supabase";
import { type ToolAuditContext } from "../agents/tool-registry";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AutoApplyStats {
    scanned: number;
    applied: number;
    alreadyApplied: number;
    errors: number;
    dryRun: boolean;
}

/** Env flag — when false (default), watcher dry-runs without writing to Finale. */
export function autoCompleteEnabled(): boolean {
    const v = (process.env.PO_AUTO_COMPLETE_ENABLED ?? "false").toLowerCase();
    return v === "true" || v === "1" || v === "on";
}

// ── Already-applied dedup set ──────────────────────────────────────────────

/**
 * Load already-processed orderId+invoiceNumber pairs from ap_activity_log
 * where intent="RECONCILIATION_AUTO_APPLIED". Returns a Set of composite
 * keys ("orderId::invoiceNumber") for O(1) lookup.
 */
async function loadAlreadyAppliedKeys(): Promise<Set<string>> {
    const sb = createClient();
    if (!sb) return new Set();

    const applied = new Set<string>();
    try {
        const { data } = await sb
            .from("ap_activity_log")
            .select("metadata")
            .eq("intent", "RECONCILIATION_AUTO_APPLIED")
            .order("created_at", { ascending: false })
            .limit(1000);

        for (const row of (data ?? []) as any[]) {
            const orderId = row.metadata?.orderId;
            const invoiceNumber = row.metadata?.invoiceNumber;
            if (orderId && invoiceNumber) {
                applied.add(`${orderId}::${invoiceNumber}`);
            }
        }
    } catch (err: any) {
        console.warn(
            `[reconciliation-auto-apply] Failed to load already-applied keys: ${err.message}`,
        );
    }
    return applied;
}

// ── Load RECONCILIATION rows ───────────────────────────────────────────────

/**
 * Load RECONCILIATION rows from ap_activity_log (last 120 days) with
 * overallVerdict IN ('auto_approve', 'no_change').
 *
 * Handles both metadata formats:
 *   - buildAuditMetadata format: stores verdict under key "verdict"
 *   - enqueueForDashboardReview format: stores verdict under key "overallVerdict"
 */
async function loadAutoApprovableRows(): Promise<any[]> {
    const sb = createClient();
    if (!sb) return [];

    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

    try {
        // Query both candidate verdict keys so we catch rows from either
        // metadata format. Supabase JSONB filtering uses `->>` for text.
        const { data } = await sb
            .from("ap_activity_log")
            .select("id, created_at, metadata, reconciliation_report")
            .eq("intent", "RECONCILIATION")
            .gte("created_at", since)
            .or(
                "metadata->>verdict.in.(auto_approve,no_change),metadata->>overallVerdict.in.(auto_approve,no_change)",
            )
            .order("created_at", { ascending: false })
            .limit(500);

        return data ?? [];
    } catch (err: any) {
        console.warn(
            `[reconciliation-auto-apply] Failed to load reconciliation rows: ${err.message}`,
        );
        return [];
    }
}

// ── Metadata normaliser ────────────────────────────────────────────────────

/**
 * Normalise stored metadata back into a shape compatible with
 * applyReconciliation(). Handles two formats:
 *
 *   Format A (buildAuditMetadata — used by ap-agent.ts auto_approve path):
 *     priceChanges: [{ productId, description, from, to, pct, impact, verdict }]
 *     feeChanges:   [{ type, description, from, to, delta, verdict }]
 *     tracking:     { trackingNumbers, carrierName }
 *
 *   Format B (enqueueForDashboardReview — used by reconciler.ts):
 *     priceChanges: [{ productId, poPrice, invoicePrice, quantity, dollarImpact,
 *                      percentChange, verdict, reason, ... }]
 *     feeChanges:   [{ feeType, amount, existingAmount, isNew, description,
 *                      verdict, reason }]
 *     tracking:     { trackingNumbers, shipDate, carrierName }
 *     overallVerdict: "auto_approve" | "no_change"
 *
 * Returns priceChanges and feeChanges in the original ReconciliationResult
 * format (Format B) that applyReconciliation expects.
 */
function normalisePriceChanges(
    raw: any[] | undefined,
): Array<{
    productId: string;
    description: string;
    poPrice: number;
    invoicePrice: number;
    quantity: number;
    dollarImpact: number;
    percentChange: number;
    verdict: string;
    reason: string;
    receivedQty?: number;
    receivingGap?: number;
}> {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    // Detect format by checking for 'from' key (Format A) vs 'poPrice' (Format B)
    const isAuditFormat = "from" in raw[0] && !("poPrice" in raw[0]);

    if (isAuditFormat) {
        // Format A: buildAuditMetadata shape
        return raw.map((pc: any) => ({
            productId: pc.productId ?? "",
            description: pc.description ?? "",
            poPrice: pc.from ?? 0,
            invoicePrice: pc.to ?? 0,
            quantity: pc.quantity ?? 1,
            dollarImpact: pc.impact ?? 0,
            percentChange: (pc.pct ?? 0) / 100, // stored as percentage points
            verdict: pc.verdict ?? "auto_approve",
            reason: "",
        }));
    }

    // Format B: already in ReconciliationResult shape
    return raw.map((pc: any) => ({
        productId: pc.productId ?? "",
        description: pc.description ?? "",
        poPrice: pc.poPrice ?? 0,
        invoicePrice: pc.invoicePrice ?? 0,
        quantity: pc.quantity ?? 1,
        dollarImpact: pc.dollarImpact ?? 0,
        percentChange: pc.percentChange ?? 0,
        verdict: pc.verdict ?? "auto_approve",
        reason: pc.reason ?? "",
        receivedQty: pc.receivedQty,
        receivingGap: pc.receivingGap,
    }));
}

function normaliseFeeChanges(
    raw: any[] | undefined,
): Array<{
    feeType: string;
    amount: number;
    existingAmount: number;
    isNew: boolean;
    description: string;
    verdict: string;
    reason: string;
}> {
    if (!Array.isArray(raw) || raw.length === 0) return [];

    // Detect format by checking for 'type' key (Format A) vs 'feeType' (Format B)
    const isAuditFormat = "type" in raw[0] && !("feeType" in raw[0]);

    if (isAuditFormat) {
        // Format A: buildAuditMetadata shape (uses 'type' and 'from'/'to')
        return raw.map((fc: any) => ({
            feeType: fc.type ?? "",
            amount: fc.to ?? 0,
            existingAmount: fc.from ?? 0,
            isNew: fc.isNew ?? (fc.from === 0 && fc.to > 0),
            description: fc.description ?? "",
            verdict: fc.verdict ?? "auto_approve",
            reason: "",
        }));
    }

    // Format B: already in ReconciliationResult shape
    return raw.map((fc: any) => ({
        feeType: fc.feeType ?? "",
        amount: fc.amount ?? 0,
        existingAmount: fc.existingAmount ?? 0,
        isNew: fc.isNew ?? true,
        description: fc.description ?? "",
        verdict: fc.verdict ?? "auto_approve",
        reason: fc.reason ?? "",
    }));
}

function normaliseTracking(raw: any | null | undefined): {
    trackingNumbers: string[];
    shipDate?: string;
    carrierName?: string;
} | null {
    if (!raw) return null;

    const trackingNumbers = Array.isArray(raw.trackingNumbers)
        ? raw.trackingNumbers
        : Array.isArray(raw.tracking)
          ? raw.tracking
          : [];

    return {
        trackingNumbers,
        shipDate: raw.shipDate ?? undefined,
        carrierName: raw.carrierName ?? undefined,
    };
}

// ── Watcher ────────────────────────────────────────────────────────────────

/**
 * Run one pass of the reconciliation auto-apply watcher.
 *
 * 1. Load RECONCILIATION rows with auto_approve/no_change verdict (last 120d)
 * 2. Filter to ones NOT already processed (dedup by orderId::invoiceNumber)
 * 3. For each unprocessed row, reconstruct the result from metadata and
 *    apply changes to Finale
 * 4. If feeChanges include FREIGHT, re-complete the PO
 * 5. Write RECONCILIATION_AUTO_APPLIED activity row on success,
 *    RECONCILIATION_ERROR on failure
 *
 * Gated by PO_AUTO_COMPLETE_ENABLED. When disabled, dry-runs (logs what
 * would be done but writes nothing to Finale or Supabase).
 */
export async function runReconciliationAutoApply(): Promise<AutoApplyStats> {
    const stats: AutoApplyStats = {
        scanned: 0,
        applied: 0,
        alreadyApplied: 0,
        errors: 0,
        dryRun: !autoCompleteEnabled(),
    };

    if (stats.dryRun) {
        console.warn(
            "[reconciliation-auto-apply] PO_AUTO_COMPLETE_ENABLED is false — DRY-RUN mode (no Finale writes)",
        );
    }

    const [rows, alreadyApplied] = await Promise.all([
        loadAutoApprovableRows(),
        loadAlreadyAppliedKeys(),
    ]);

    stats.scanned = rows.length;
    if (rows.length === 0) {
        console.log("[reconciliation-auto-apply] No auto-applicable RECONCILIATION rows found.");
        return stats;
    }

    const { finaleClient } = await import("../finale/client");
    const { applyReconciliation } = await import("../finale/reconciler");
    const sb = createClient();

    const auditCtx: ToolAuditContext = { agent: "reconciliation-auto-apply" };

    for (const row of rows as any[]) {
        const meta = row.metadata;
        if (!meta) continue;

        // Resolve verdict from whichever key the metadata uses
        const verdict = meta.verdict ?? meta.overallVerdict ?? null;
        if (!verdict || !["auto_approve", "no_change"].includes(verdict)) continue;

        const orderId = meta.orderId ?? meta.poId ?? null;
        const invoiceNumber = meta.invoiceNumber ?? null;

        if (!orderId || !invoiceNumber) {
            console.warn(
                "[reconciliation-auto-apply] Skipping row with missing orderId/invoiceNumber",
            );
            continue;
        }

        // ── Dedup check ──────────────────────────────────────────────
        const key = `${orderId}::${invoiceNumber}`;
        if (alreadyApplied.has(key)) {
            stats.alreadyApplied++;
            continue;
        }

        // ── Reconstruct ReconciliationResult ─────────────────────────
        const priceChanges = normalisePriceChanges(meta.priceChanges);
        const feeChanges = normaliseFeeChanges(meta.feeChanges);
        const trackingUpdate = normaliseTracking(
            meta.tracking ?? meta.trackingUpdate ?? null,
        );
        const vendorName = meta.vendorName ?? meta.vendor ?? "Unknown";

        // Only pass populateItems if the metadata has them (Format B only)
        const populateItems = Array.isArray(meta.populateItems) ? meta.populateItems : undefined;

        const result: any = {
            orderId,
            invoiceNumber,
            vendorName,
            invoiceTotal: meta.total ?? meta.invoiceTotal ?? null,
            priceChanges,
            feeChanges,
            trackingUpdate,
            overallVerdict: verdict,
            summary: meta.summary ?? row.action_taken ?? "",
            totalDollarImpact: meta.totalDollarImpact ?? meta.impact ?? 0,
            autoApplicable: verdict === "auto_approve" || verdict === "no_change",
            warnings: meta.warnings ?? [],
            vendorNote: meta.vendorNote,
            notes: meta.notes,
            report: row.reconciliation_report ?? meta.report ?? null,
            populateItems,
        };

        // Collect all item productIds and fee types for auto-approve
        const allItemIds = priceChanges
            .filter((pc: any) => pc.productId)
            .map((pc: any) => pc.productId);

        const allFeeTypes = feeChanges
            .filter((fc: any) => fc.feeType)
            .map((fc: any) => fc.feeType);

        const hasChanges =
            priceChanges.some((pc: any) => pc.verdict !== "no_change") ||
            feeChanges.length > 0 ||
            !!trackingUpdate;

        // ── Guardrail: PO-level dollar cap ────────────────────────────
        // If totalDollarImpact exceeds $5,000, don't auto-apply — the
        // cumulative changes are large enough that a human should verify.
        const DOLLAR_CAP = 5000;
        const totalImpact = result.totalDollarImpact ?? 0;
        const exceedsDollarCap = hasChanges && totalImpact > DOLLAR_CAP;

        // ── Guardrail: Per-SKU qty sanity ─────────────────────────────
        // Catch absurd quantities (OCR error: 1,000,000 units) or
        // absurd line totals ($1M single line). These are NEVER correct.
        const QTY_SANITY_MAX = 100_000;
        const LINE_TOTAL_SANITY_MAX = 100_000;
        let sanityViolation: string | null = null;
        for (const pc of priceChanges) {
            const qty = pc.quantity ?? 0;
            const lineTotal = qty * (pc.invoicePrice ?? 0);
            if (qty > QTY_SANITY_MAX) {
                sanityViolation = `${pc.productId}: qty ${qty.toLocaleString()} exceeds sanity max (${QTY_SANITY_MAX.toLocaleString()})`;
                break;
            }
            if (lineTotal > LINE_TOTAL_SANITY_MAX) {
                sanityViolation = `${pc.productId}: line total $${lineTotal.toLocaleString()} exceeds sanity max ($${LINE_TOTAL_SANITY_MAX.toLocaleString()})`;
                break;
            }
        }

        // ── Guardrail: block message ──────────────────────────────────
        const guardrailBlocked = exceedsDollarCap || sanityViolation !== null;
        let blockReason: string | null = null;
        if (exceedsDollarCap) {
            blockReason = `Total dollar impact $${totalImpact.toLocaleString()} exceeds auto-apply cap of $${DOLLAR_CAP.toLocaleString()}. Review in dashboard RCV column and approve manually.`;
        } else if (sanityViolation) {
            blockReason = `Quantity sanity check failed: ${sanityViolation}. Review invoice in dashboard RCV column.`;
        }

        // ── Dry-run path ─────────────────────────────────────────────
        if (stats.dryRun) {
            const changeSummary = hasChanges
                ? `prices=${priceChanges.filter((pc: any) => pc.verdict !== "no_change").length}, ` +
                  `fees=${feeChanges.length}${trackingUpdate ? ", tracking=yes" : ""}`
                : "no changes needed";
            console.log(
                `[reconciliation-auto-apply] DRY-RUN would apply to PO ${orderId} ` +
                    `(invoice=${invoiceNumber}, vendor=${vendorName}, ${changeSummary})`,
            );
            continue;
        }

        // ── Guardrail block ── If guardrails trip, write block row instead of applying
        if (guardrailBlocked) {
            console.warn(
                `[reconciliation-auto-apply] BLOCKED PO ${orderId} (${vendorName}): ${blockReason}`,
            );
            stats.errors++;
            try {
                if (sb) {
                    await sb.from("ap_activity_log").insert({
                        email_from: vendorName,
                        email_subject: `PO ${orderId} auto-apply blocked`,
                        intent: "RECONCILIATION_BLOCKED",
                        action_taken: blockReason!,
                        metadata: {
                            orderId,
                            invoiceNumber,
                            vendorName,
                            blockReason,
                            totalDollarImpact: totalImpact,
                            priceChangeCount: priceChanges.length,
                            feeChangeCount: feeChanges.length,
                            sanityViolation,
                        },
                    });
                }
            } catch (logErr: any) {
                console.warn(`[reconciliation-auto-apply] Block row write failed: ${logErr.message}`);
            }
            continue;
        }

        // ── Live path ────────────────────────────────────────────────
        try {
            if (hasChanges) {
                const applyResult = await applyReconciliation(
                    result,
                    finaleClient,
                    allItemIds,
                    allFeeTypes,
                    auditCtx,
                );

                // If feeChanges include FREIGHT, re-complete the PO because
                // adjusting freight may unlock it in Finale.
                const hasFreightChange = feeChanges.some(
                    (fc: any) => fc.feeType === "FREIGHT" && fc.verdict !== "no_change",
                );
                if (hasFreightChange) {
                    try {
                        await finaleClient.completeOrder(orderId);
                        console.log(
                            `[reconciliation-auto-apply] Re-completed PO ${orderId} after freight adjustment`,
                        );
                    } catch (completeErr: any) {
                        console.warn(
                            `[reconciliation-auto-apply] PO ${orderId} freight changes applied, ` +
                                `but re-complete failed: ${completeErr.message}`,
                        );
                        // Non-blocking — the changes are already applied
                    }
                }

                // Write RECONCILIATION_AUTO_APPLIED activity row
                try {
                    if (sb) {
                        await sb.from("ap_activity_log").insert({
                            email_from: vendorName,
                            email_subject: `PO ${orderId} auto-applied`,
                            intent: "RECONCILIATION_AUTO_APPLIED",
                            action_taken:
                                `Auto-applied reconciliation results to PO #${orderId} — ` +
                                `${applyResult.applied.length} applied, ` +
                                `${applyResult.skipped.length} skipped, ` +
                                `${applyResult.errors.length} errors`,
                            metadata: {
                                orderId,
                                invoiceNumber,
                                vendorName,
                                overallVerdict: verdict,
                                priceChangeCount: priceChanges.length,
                                feeChangeCount: feeChanges.length,
                                hasFreightChange,
                                applied: applyResult.applied,
                                skipped: applyResult.skipped,
                                errors: applyResult.errors,
                            },
                        });
                    }
                } catch (logErr: any) {
                    console.warn(
                        `[reconciliation-auto-apply] PO ${orderId} applied but Activity write failed: ${logErr.message}`,
                    );
                }

                stats.applied++;
                console.log(
                    `[reconciliation-auto-apply] Applied ${applyResult.applied.length} changes ` +
                        `to PO ${orderId} (invoice ${invoiceNumber}, vendor ${vendorName})`,
                );
            } else {
                // no_change with no actual changes — still write the audit row
                // so the dedup set catches it on future passes.
                try {
                    if (sb) {
                        await sb.from("ap_activity_log").insert({
                            email_from: vendorName,
                            email_subject: `PO ${orderId} auto-applied (no changes)`,
                            intent: "RECONCILIATION_AUTO_APPLIED",
                            action_taken: `No changes to apply — PO ${orderId} already matches invoice ${invoiceNumber}`,
                            metadata: {
                                orderId,
                                invoiceNumber,
                                vendorName,
                                overallVerdict: "no_change",
                                priceChangeCount: 0,
                                feeChangeCount: 0,
                                hasFreightChange: false,
                                applied: [],
                                skipped: [],
                                errors: [],
                            },
                        });
                    }
                } catch (logErr: any) {
                    console.warn(
                        `[reconciliation-auto-apply] PO ${orderId} no-change log failed: ${logErr.message}`,
                    );
                }

                stats.applied++;
                console.log(
                    `[reconciliation-auto-apply] No changes needed for PO ${orderId} ` +
                        `(invoice ${invoiceNumber}, vendor ${vendorName})`,
                );
            }
        } catch (err: any) {
            stats.errors++;
            console.error(
                `[reconciliation-auto-apply] PO ${orderId} (${invoiceNumber}) failed: ${err.message}`,
            );

            // Write RECONCILIATION_ERROR
            try {
                if (sb) {
                    await sb.from("ap_activity_log").insert({
                        email_from: vendorName,
                        email_subject: `PO ${orderId} auto-apply failed`,
                        intent: "RECONCILIATION_ERROR",
                        action_taken: `Auto-apply failed for PO #${orderId}: ${err.message}`,
                        metadata: {
                            orderId,
                            invoiceNumber,
                            vendorName,
                            error: err.message,
                        },
                    });
                }
            } catch (logErr: any) {
                console.warn(
                    `[reconciliation-auto-apply] Error writing error row: ${logErr.message}`,
                );
            }
        }
    }

    // Summary log
    const mode = stats.dryRun ? "DRY-RUN" : "LIVE";
    console.log(
        `[reconciliation-auto-apply] ${mode} complete: ` +
            `scanned=${stats.scanned}, applied=${stats.applied}, ` +
            `alreadyApplied=${stats.alreadyApplied}, errors=${stats.errors}`,
    );

    return stats;
}