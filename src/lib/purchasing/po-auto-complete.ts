/**
 * @file    po-auto-complete.ts
 * @purpose Watcher that auto-completes Finale POs when all conditions are
 *          satisfied AND the vendor's freight pattern is recognized.
 *
 *          The criteria for completion (Will, 2026-05-15):
 *            1. PO is finale-received
 *            2. Pricing reconciled (verdict in resolved set)
 *            3. Invoice correlated
 *            4. Freight handled per the vendor's known pattern:
 *                 vendor_freight → invoice freight must be on the PO
 *                 bas_freight    → any freight adjustment must be on the PO
 *                 no_freight     → no freight expected
 *            5. PO has been in "complete" state for ≥48h (dwell)
 *
 *          HARD RULE: if invoice.freight > 0 AND no matching freight on
 *          the PO → never auto-complete. Will's "red flag" rule.
 *
 *          Default OFF: gated by PO_AUTO_COMPLETE_ENABLED env. When
 *          disabled, watcher logs what it WOULD complete but writes
 *          nothing to Finale. Activity rows are only written on actual
 *          completion (no chatter for skips or dry-runs).
 */

import { createClient } from "../db";
import { withToolAudit, type ToolAuditContext } from "../agents/tool-registry";
import {
    classifyVendorFreightPattern,
    type PatternEvidence,
    type VendorFreightPatternResult,
} from "./vendor-freight-pattern";

const DWELL_HOURS = 48;

export type EligibilityResult =
    | { eligible: true; pattern: VendorFreightPatternResult }
    | { eligible: false; reason: string; pattern: VendorFreightPatternResult | null };

export interface POForCompletion {
    orderId: string;
    vendorName: string;
    completionState: string;             // "complete" expected
    completionStateSince: string | null; // ISO timestamp the state stabilized
    poFreightAmount: number;             // sum of FREIGHT adjustments on the PO
    invoiceFreight: number;              // 0 if no invoice or invoice has no freight
    hasMatchedInvoice: boolean;
}

/**
 * Per-PO eligibility check. Pure function — all data passed in. Caller
 * (the watcher) is responsible for loading evidence + the PO state.
 */
export function checkAutoCompleteEligibility(
    po: POForCompletion,
    evidence: PatternEvidence[],
    nowMs: number = Date.now(),
): EligibilityResult {
    // Gate 1: PO must already be in "complete" state per derivePOCompletionState.
    if (po.completionState !== "complete") {
        return { eligible: false, reason: `completionState=${po.completionState}`, pattern: null };
    }

    // Gate 2: 48h dwell time. completionStateSince must be at least DWELL_HOURS old.
    if (!po.completionStateSince) {
        return { eligible: false, reason: "no dwell timestamp on file", pattern: null };
    }
    const ageMs = nowMs - new Date(po.completionStateSince).getTime();
    const ageHours = ageMs / (3600 * 1000);
    if (ageHours < DWELL_HOURS) {
        return {
            eligible: false,
            reason: `dwell ${ageHours.toFixed(1)}h < ${DWELL_HOURS}h required`,
            pattern: null,
        };
    }

    // Gate 3: HARD RULE — invoice freight without matching PO freight is
    // ALWAYS a hold, regardless of vendor pattern. Will's red flag.
    if (po.invoiceFreight > 0 && Math.abs(po.invoiceFreight - po.poFreightAmount) > 0.01) {
        return {
            eligible: false,
            reason: `invoice has freight $${po.invoiceFreight.toFixed(2)} but PO freight is $${po.poFreightAmount.toFixed(2)} — red flag, needs correlation`,
            pattern: null,
        };
    }

    // Gate 4: vendor pattern. Classify and check against the requirement.
    const pattern = classifyVendorFreightPattern(po.vendorName, evidence);

    // Only "high" confidence patterns are eligible — that's the allowlist.
    if (pattern.confidence !== "high") {
        return {
            eligible: false,
            reason: `pattern confidence=${pattern.confidence} (need high; sample=${pattern.sampleSize}, dominance=${(pattern.dominance * 100).toFixed(0)}%)`,
            pattern,
        };
    }

    // Pattern-specific freight check.
    if (pattern.pattern === "vendor_freight") {
        // Vendor includes freight on invoice — invoice must have freight AND it must be on the PO.
        if (po.invoiceFreight <= 0) {
            return { eligible: false, reason: "vendor_freight pattern expects invoice freight > 0", pattern };
        }
        // Already checked in Gate 3 that PO freight matches invoice freight, so we're good.
    } else if (pattern.pattern === "bas_freight") {
        // We add freight (FedEx etc) — PO must have a freight adjustment.
        if (po.poFreightAmount <= 0) {
            return { eligible: false, reason: "bas_freight pattern expects PO freight adjustment but none found", pattern };
        }
    } else if (pattern.pattern === "no_freight") {
        // No freight expected — must be true on both sides.
        if (po.poFreightAmount > 0 || po.invoiceFreight > 0) {
            return {
                eligible: false,
                reason: `no_freight pattern but found PO freight $${po.poFreightAmount.toFixed(2)} / invoice freight $${po.invoiceFreight.toFixed(2)}`,
                pattern,
            };
        }
    } else {
        // mixed or insufficient_data — never auto-complete.
        return { eligible: false, reason: `pattern=${pattern.pattern} — manual handling`, pattern };
    }

    // Gate 5: invoice correlated.
    if (!po.hasMatchedInvoice) {
        return { eligible: false, reason: "no matched invoice on file", pattern };
    }

    return { eligible: true, pattern };
}

/** Env flag — when false (default), watcher dry-runs without writing to Finale. */
export function autoCompleteEnabled(): boolean {
    const v = (process.env.PO_AUTO_COMPLETE_ENABLED ?? "false").toLowerCase();
    return v === "true" || v === "1" || v === "on";
}

// ── Watcher ────────────────────────────────────────────────────────────────

/**
 * Run one watcher pass: identify POs that pass every eligibility gate AND
 * call finaleClient.completeOrder() on them. Default OFF behind env;
 * dry-runs log what they WOULD complete without writing.
 *
 * Returns a stats object the cron handler can log:
 *   { scanned, eligible, completed, dryRun, errors }
 */
export interface AutoCompleteRunStats {
    scanned: number;
    eligible: number;
    completed: number;
    skipped: number;
    errors: number;
    dryRun: boolean;
}

export async function runPOAutoCompleteWatcher(): Promise<AutoCompleteRunStats> {
    const sb = createClient();
    if (!sb) {
        return { scanned: 0, eligible: 0, completed: 0, skipped: 0, errors: 0, dryRun: !autoCompleteEnabled() };
    }
    const { finaleClient } = await import("../finale/client");
    const { loadActivePurchases } = await import("./active-purchases");

    const auditCtx: ToolAuditContext = { agent: "po-auto-complete-watcher" };

    const stats: AutoCompleteRunStats = {
        scanned: 0,
        eligible: 0,
        completed: 0,
        skipped: 0,
        errors: 0,
        dryRun: !autoCompleteEnabled(),
    };

    const purchases = await loadActivePurchases(finaleClient, 60);
    const candidates = purchases.filter(p => p.completionState === "complete");
    stats.scanned = candidates.length;
    if (candidates.length === 0) return stats;

    // For dwell-time anchoring, use the latest reconciliation activity row
    // for each candidate PO. Falls back to the PO's receiveDate.
    const poNumbers = candidates.map(p => p.orderId);
    const latestReconAt = new Map<string, string>();
    try {
        const { data } = await sb
            .from("ap_activity_log")
            .select("created_at, metadata")
            .eq("intent", "RECONCILIATION")
            .in("metadata->>orderId", poNumbers)
            .order("created_at", { ascending: false })
            .limit(500);
        for (const row of (data ?? []) as any[]) {
            const id = row.metadata?.orderId;
            if (id && !latestReconAt.has(id)) {
                latestReconAt.set(id, row.created_at);
            }
        }
    } catch (err: any) {
        console.warn(`[po-auto-complete] failed to load reconciliation timestamps: ${err.message}`);
    }

    for (const po of candidates) {
        try {
            // Pull fresh PO details for adjustments (loadActivePurchases doesn't surface them).
            const details = await withToolAudit(
                "finale_get_order_details",
                auditCtx,
                { orderId: po.orderId },
                () => finaleClient.getOrderDetails(po.orderId),
            );
            const adjustments: any[] = details.orderAdjustmentList ?? [];
            const poFreightAmount = adjustments
                .filter(adj => {
                    const url = String(adj.productPromoUrl || "");
                    const desc = String(adj.description || "").toLowerCase();
                    return url.endsWith("/productpromo/10007") || desc.includes("freight");
                })
                .reduce((s, adj) => s + (Number(adj.amount) || 0), 0);

            // Pull the matched invoice (if any) for the invoice-freight value
            // and as the "hasMatchedInvoice" signal.
            const { data: invRows } = await sb
                .from("vendor_invoices")
                .select("invoice_number, freight, raw_payload")
                .eq("po_number", po.orderId)
                .order("invoice_date", { ascending: false })
                .limit(1);
            const invoice = (invRows?.[0] as any) || null;
            const invoiceFreight = invoice
                ? Number(invoice.freight ?? invoice.raw_payload?.freight ?? 0) || 0
                : 0;
            const hasMatchedInvoice = !!invoice;

            // Dwell anchor: latest reconciliation timestamp for this PO,
            // falling back to the PO's receiveDate.
            const completionStateSince =
                latestReconAt.get(po.orderId) ??
                (po as any).receiveDate ??
                null;

            const evidence = await loadVendorEvidence(po.vendorName);
            const elig = checkAutoCompleteEligibility(
                {
                    orderId: po.orderId,
                    vendorName: po.vendorName,
                    completionState: po.completionState,
                    completionStateSince,
                    poFreightAmount,
                    invoiceFreight,
                    hasMatchedInvoice,
                },
                evidence,
            );

            if (!elig.eligible) {
                stats.skipped++;
                // During dry-runs the most useful signal is WHY each candidate
                // was skipped. Live mode stays quiet per Will's "move on
                // quietly" rule — only successful completions emit anything.
                if (stats.dryRun) {
                    console.log(
                        `[po-auto-complete] DRY-RUN skip PO ${po.orderId} (${po.vendorName}): ${elig.reason}`,
                    );
                }
                continue;
            }
            stats.eligible++;

            // Dry-run path: log what we WOULD have done; no Finale write, no Activity row.
            if (stats.dryRun) {
                console.log(
                    `[po-auto-complete] DRY-RUN would complete PO ${po.orderId} ` +
                    `(vendor=${po.vendorName}, pattern=${elig.pattern.pattern}, ` +
                    `confidence=${elig.pattern.confidence}, freight=$${poFreightAmount.toFixed(2)}, ` +
                    `invoice=${invoice?.invoice_number ?? "?"})`,
                );
                continue;
            }

            // Live path: complete the order, then write Activity row.
            await withToolAudit(
                "finale_complete_order",
                auditCtx,
                { orderId: po.orderId, vendor: po.vendorName },
                () => finaleClient.completeOrder(po.orderId),
            );
            stats.completed++;

            try {
                await sb.from("ap_activity_log").insert({
                    email_from: po.vendorName,
                    email_subject: `PO ${po.orderId} auto-completed`,
                    intent: "PO_AUTO_COMPLETED",
                    action_taken:
                        `Auto-completed PO #${po.orderId} from ${po.vendorName} — ` +
                        `pattern=${elig.pattern.pattern}, ` +
                        `freight $${poFreightAmount.toFixed(2)}` +
                        (invoice?.invoice_number ? `, invoice ${invoice.invoice_number}` : ""),
                    metadata: {
                        poId: po.orderId,
                        vendorName: po.vendorName,
                        pattern: elig.pattern.pattern,
                        patternConfidence: elig.pattern.confidence,
                        patternSampleSize: elig.pattern.sampleSize,
                        patternSource: elig.pattern.source,
                        poFreightAmount,
                        invoiceFreight,
                        invoiceNumber: invoice?.invoice_number ?? null,
                        completionStateSince,
                    },
                });
            } catch (err: any) {
                console.warn(`[po-auto-complete] PO ${po.orderId} completed but Activity write failed: ${err.message}`);
            }
        } catch (err: any) {
            stats.errors++;
            console.error(`[po-auto-complete] PO ${po.orderId} failed: ${err.message}`);
        }
    }

    return stats;
}

// ── Evidence loaders ───────────────────────────────────────────────────────
// Pull last N completed POs for a vendor and assemble PatternEvidence.
// Reads from ap_activity_log RECONCILIATION rows + vendor_invoices. Both
// tables already exist; no migration needed.

const EVIDENCE_SAMPLE_SIZE = 20;

export async function loadVendorEvidence(vendorName: string): Promise<PatternEvidence[]> {
    const sb = createClient();
    if (!sb || !vendorName) return [];

    try {
        const { data: invoices } = await sb
            .from("vendor_invoices")
            .select("po_number, freight, raw_payload")
            .ilike("vendor_name", `%${vendorName}%`)
            .not("po_number", "is", null)
            .order("invoice_date", { ascending: false })
            .limit(EVIDENCE_SAMPLE_SIZE * 2); // some POs may dedup down
        const seen = new Set<string>();
        const ev: PatternEvidence[] = [];
        for (const row of (invoices ?? []) as any[]) {
            if (!row.po_number || seen.has(row.po_number)) continue;
            seen.add(row.po_number);
            const invFreight = Number(row.freight ?? row.raw_payload?.freight ?? 0) || 0;
            // PO freight at completion: look at the RECONCILIATION metadata
            const { data: reconRows } = await sb
                .from("ap_activity_log")
                .select("metadata")
                .eq("intent", "RECONCILIATION")
                .filter("metadata->>orderId", "eq", row.po_number)
                .order("created_at", { ascending: false })
                .limit(1);
            const recon = reconRows?.[0] as any;
            const feeChanges: any[] = recon?.metadata?.feeChanges ?? [];
            const freightOnPO = feeChanges
                .filter(fc => fc.feeType === "FREIGHT")
                .reduce((s, fc) => s + (Number(fc.amount) || 0), 0);
            const matched = invFreight > 0 && Math.abs(invFreight - freightOnPO) < 0.01;
            ev.push({
                poId: row.po_number,
                hadFreightOnPO: freightOnPO > 0,
                invoiceFreight: invFreight,
                matched,
            });
            if (ev.length >= EVIDENCE_SAMPLE_SIZE) break;
        }
        return ev;
    } catch (err: any) {
        console.warn(`[po-auto-complete] loadVendorEvidence(${vendorName}) failed: ${err.message}`);
        return [];
    }
}
