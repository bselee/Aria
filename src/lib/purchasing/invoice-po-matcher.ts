/**
 * @file    invoice-po-matcher.ts
 * @purpose Match vendor invoices to purchase orders using the local database.
 *          Every invoice lands in vendor_invoices (via AP pipeline OCR).
 *          Every PO lands in purchase_orders (via Finale sync + Gmail ingest).
 *          Matching joins these two tables on vendor name + date + amount.
 *
 *          Flow:
 *            1. Invoice arrives → vendor_invoices row (po_number = NULL)
 *            2. This matcher searches purchase_orders for same vendor
 *            3. Scores candidates: vendor name (40) + date (30) + amount (30)
 *            4. Score ≥80 + exactly one candidate → auto-assign po_number
 *            5. Score ≥50 → show in receivings panel for human approval
 *
 *          The simple case is the common case: 1 PO → 1 invoice.
 *          Deviations (split shipments, price changes) get human review.
 *
 * @author  Hermia
 * @created 2026-07-14
 */

import { createClient } from "@/lib/db";
import { transitionLifecycleState } from "@/lib/purchasing/po-lifecycle";
import { FinaleClient } from "@/lib/finale/client";
import { reconcileInvoiceToPO, applyReconciliation, buildReconciliationIdentityMetadata } from "@/lib/finale/reconciler";

// ── Types ──────────────────────────────────────────────────────────────────

export interface InvoiceToMatch {
    id: string;
    invoiceNumber: string;
    vendorName: string;
    invoiceDate: string;
    subtotal: number;
    freight: number;
    tax: number;
    total: number;
    /** Optional line items from OCR or invoice cache. Used for line-level matching. */
    lineItems?: Array<{ sku?: string; qty?: number; unitPrice?: number; description?: string }>;
}

export interface POCandidate {
    orderId: string;
    vendorName: string;
    orderDate: string;
    total: number;
    status: string;
    score: number;
    reasons: string[];
    isOpen: boolean;
}

export interface MatchResult {
    invoice: InvoiceToMatch;
    candidates: POCandidate[];
    bestMatch: POCandidate | null;
    autoApplyReady: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DATE_WINDOW_DAYS = 60;
const AUTO_APPLY_THRESHOLD = 80;
const MIN_SCORE_FOR_SUGGESTION = 50;

// ── Scoring ────────────────────────────────────────────────────────────────

function scoreVendorName(a: string, b: string): { score: number; reason: string } {
    const al = a.toLowerCase().trim();
    const bl = b.toLowerCase().trim();
    if (al === bl) return { score: 40, reason: "exact vendor match" };
    if (al.includes(bl) || bl.includes(al)) return { score: 30, reason: "vendor substring match" };

    const wa = new Set(al.split(/\s+/).filter(w => w.length > 2));
    const wb = new Set(bl.split(/\s+/).filter(w => w.length > 2));
    const overlap = [...wa].filter(w => wb.has(w)).length;
    if (overlap / Math.max(wa.size, wb.size, 1) >= 0.5) {
        return { score: 25, reason: `vendor word overlap (${overlap})` };
    }
    return { score: 0, reason: "vendor mismatch" };
}

function scoreDateProximity(invDate: string, poDate: string): { score: number; reason: string } {
    // Normalize to YYYY-MM-DD — PO dates may be full ISO timestamps
    const norm = (s: string) => (s || "").slice(0, 10);
    const a = new Date(norm(invDate) + "T12:00:00Z").getTime();
    const b = new Date(norm(poDate) + "T12:00:00Z").getTime();
    if (isNaN(a) || isNaN(b)) return { score: 0, reason: "invalid date" };

    const days = Math.abs((a - b) / 86_400_000);
    if (days <= 7) return { score: 30, reason: `${Math.round(days)}d apart` };
    if (days <= 21) return { score: 22, reason: `${Math.round(days)}d apart` };
    if (days <= 45) return { score: 14, reason: `${Math.round(days)}d apart` };
    if (days <= DATE_WINDOW_DAYS) return { score: 6, reason: `${Math.round(days)}d apart` };
    return { score: 0, reason: `${Math.round(days)}d — outside ${DATE_WINDOW_DAYS}d window` };
}

function scoreAmountProximity(invTotal: number, poTotal: number): { score: number; reason: string } {
    if (invTotal <= 0 || poTotal <= 0) return { score: 0, reason: "missing amount" };
    const pct = Math.abs(invTotal - poTotal) / poTotal;
    if (pct <= 0.02) return { score: 30, reason: `${(pct * 100).toFixed(1)}% variance` };
    if (pct <= 0.05) return { score: 25, reason: `${(pct * 100).toFixed(1)}% variance` };
    if (pct <= 0.10) return { score: 18, reason: `${(pct * 100).toFixed(1)}% variance` };
    if (pct <= 0.20) return { score: 8, reason: `${(pct * 100).toFixed(1)}% variance` };
    return { score: 0, reason: `${(pct * 100).toFixed(1)}% variance` };
}

// ── Main matcher ───────────────────────────────────────────────────────────

/**
 * Extract significant search terms from a vendor name for fallback matching.
 * "Miles Filippelli" → ["Miles", "Filippelli"]
 * "UNKNOWN | Uline" → ["Uline"]
 * "AAA COOPER TRANSPORTATION" → ["COOPER", "TRANSPORTATION"]
 * Filters out common noise words and garbage prefixes.
 */
function extractSearchTerms(vendorName: string): string[] {
    const stopWords = new Set([
        "inc", "llc", "co", "corp", "ltd", "company", "group", "the", "and", "of",
        "a", "an", "transport", "transportation", "services", "logistics", "supply",
    ]);
    // Strip garbage prefixes like "UNKNOWN | " or "Fwd: "
    const cleaned = vendorName
        .replace(/^(?:UNKNOWN\s*[\|\-\/]\s*|Fwd?:\s*|Re:\s*)+/i, "")
        .trim();
    return cleaned
        .split(/[\s,.\/\|\-]+/)
        .map(w => w.trim())
        .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()));
}

/**
 * Find candidate POs for an unmatched invoice by searching the local
 * purchase_orders table. No Finale API calls — the local DB is the hub.
 */
export async function findPOCandidates(invoice: InvoiceToMatch): Promise<MatchResult> {
    const db = createClient();
    const candidates: POCandidate[] = [];

    if (!db) return { invoice, candidates: [], bestMatch: null, autoApplyReady: false };

    // Normalize vendor name: extract significant words for broader matching.
    // "Miles Filippelli" from OCR should match "Miles Nursery LLC" in purchase_orders.
    const searchTerms = extractSearchTerms(invoice.vendorName);

    // Search purchase_orders: try exact ilike first, then word-based if no results
    let { data: pos } = await db
        .from("purchase_orders")
        .select("po_number, vendor_name, issue_date, total_amount, total, status")
        .ilike("vendor_name", `%${invoice.vendorName}%`)
        .order("issue_date", { ascending: false })
        .limit(20);

    // If no direct match, try each significant search term
    if ((!pos || pos.length === 0) && searchTerms.length > 0) {
        for (const term of searchTerms) {
            const { data: termResults } = await db
                .from("purchase_orders")
                .select("po_number, vendor_name, issue_date, total_amount, total, status")
                .ilike("vendor_name", `%${term}%`)
                .order("issue_date", { ascending: false })
                .limit(20);
            if (termResults && termResults.length > 0) {
                pos = termResults;
                break;
            }
        }
    }

    for (const po of (pos || []) as any[]) {
        const vendorScore = scoreVendorName(invoice.vendorName, po.vendor_name || "");
        const dateScore = scoreDateProximity(invoice.invoiceDate, po.issue_date || "");
        const poTotal = Number(po.total_amount || po.total || 0);
        const amountScore = scoreAmountProximity(invoice.total, poTotal);

        let total = vendorScore.score + dateScore.score + amountScore.score;

        // When invoice total is $0 (bad OCR), still surface the match on
        // vendor + date alone if those are strong. Don't auto-apply though.
        const isZeroAmount = invoice.total <= 0;
        if (isZeroAmount && vendorScore.score >= 25 && dateScore.score >= 14) {
            total = Math.max(total, vendorScore.score + dateScore.score);
        }

        // Minimum bar: need at least a vendor match + something else
        if (total < MIN_SCORE_FOR_SUGGESTION) continue;
        // For auto-apply, require non-zero amount match
        const effectiveAutoApply = !isZeroAmount && total >= AUTO_APPLY_THRESHOLD;

        const reasons = [vendorScore, dateScore, amountScore]
            .filter(r => r.score > 0)
            .map(r => r.reason);
        if (isZeroAmount && amountScore.score === 0) {
            reasons.push("amount unknown (OCR may have missed total)");
        }

        candidates.push({
            orderId: po.po_number,
            vendorName: po.vendor_name,
            orderDate: po.issue_date,
            total: poTotal,
            status: po.status || "unknown",
            score: total,
            reasons,
            isOpen: ["open", "partial"].includes((po.status || "").toLowerCase()),
        });
    }

    candidates.sort((a, b) => b.score - a.score);
    const bestMatch = candidates.length > 0 ? candidates[0] : null;
    // Auto-apply requires: single candidate, score ≥80, AND non-zero invoice amount.
    // $0 invoices (bad OCR) always need human review.
    const autoApplyReady = candidates.length === 1
        && bestMatch!.score >= AUTO_APPLY_THRESHOLD
        && invoice.total > 0;

    return { invoice, candidates, bestMatch, autoApplyReady };
}

// ── Batch auto-match (for cron) ────────────────────────────────────────────

export async function batchMatchUnmatchedInvoices(): Promise<{
    autoMatched: Array<{ invoiceId: string; poNumber: string; score: number }>;
    needsReview: number;
}> {
    const db = createClient();
    const autoMatched: Array<{ invoiceId: string; poNumber: string; score: number }> = [];
    let needsReview = 0;

    if (!db) return { autoMatched, needsReview };

    // Find invoices with no PO assigned, ordered by most recent
    const { data: unmatched } = await db
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, invoice_date, subtotal, freight, tax, total, raw_data, line_items")
        .is("po_number", null)
        .order("created_at", { ascending: false })
        .limit(50);

    for (const inv of (unmatched || []) as any[]) {
        const invoice: InvoiceToMatch = {
            id: inv.id,
            invoiceNumber: inv.invoice_number,
            vendorName: inv.vendor_name,
            invoiceDate: inv.invoice_date,
            subtotal: Number(inv.subtotal || 0),
            freight: Number(inv.freight || 0),
            tax: Number(inv.tax || 0),
            total: Number(inv.total || 0),
        };

        const result = await findPOCandidates(invoice);

        if (result.autoApplyReady && result.bestMatch) {
            await db
                .from("vendor_invoices")
                .update({ po_number: result.bestMatch.orderId })
                .eq("id", inv.id);

            await transitionLifecycleState(
                result.bestMatch.orderId,
                'INVOICED',
                'invoice-po-matcher',
                {
                    invoiceId: inv.id,
                    invoiceNumber: inv.invoice_number,
                    score: result.bestMatch.score,
                    reasons: result.bestMatch.reasons,
                }
            );

            // Route through the mature reconciliation engine — single source of truth
            // for freight, line-item prices, and fee adjustments. Handles delta-based
            // freight application, duplicate detection, and disproportion guards.
            try {
                const finale = new FinaleClient();

                // Only trust raw_data if it has the InvoiceData shape we need.
                // Modules / raw email payloads stored as raw_data lack the required
                // fields and would pass nulls/undefineds into the reconciler.
                const rawData = inv.raw_data as Record<string, unknown> | undefined;
                const hasValidRawData =
                    rawData &&
                    typeof rawData.vendorName === 'string' &&
                    typeof rawData.invoiceNumber === 'string' &&
                    typeof rawData.total === 'number';

                const invoiceData = hasValidRawData ? rawData : {
                    vendorName: inv.vendor_name,
                    invoiceNumber: inv.invoice_number,
                    invoiceDate: inv.invoice_date,
                    dueDate: null,
                    total: Number(inv.total || 0),
                    amountDue: Number(inv.total || 0),
                    subtotal: Number(inv.subtotal || 0),
                    freight: Number(inv.freight || 0),
                    tax: Number(inv.tax || 0),
                    poNumber: result.bestMatch.orderId,
                    lineItems: inv.line_items || [],
                    confidence: "medium" as const,
                };

                const reconResult = await reconcileInvoiceToPO(
                    invoiceData as any,
                    result.bestMatch.orderId,
                    finale,
                    'invoice-po-matcher',
                );

                console.log(
                    `[invoice-matcher] Reconciliation ${result.bestMatch.orderId}: ` +
                    `verdict=${reconResult.overallVerdict} impact=$${reconResult.totalDollarImpact.toFixed(2)}`,
                );

                if (reconResult.overallVerdict === 'auto_approve') {
                    const applyResult = await applyReconciliation(reconResult, finale);
                    console.log(
                        `[invoice-matcher] Applied ${applyResult.applied.length} change(s) to PO ${result.bestMatch.orderId}`,
                    );
                    const identity = buildReconciliationIdentityMetadata({
                        invoiceNumber: inv.invoice_number,
                        vendorName: inv.vendor_name,
                        orderId: result.bestMatch.orderId,
                    });
                    await db.from('ap_activity_log').insert({
                        email_from: inv.vendor_name,
                        email_subject: `Auto-match: Invoice ${inv.invoice_number} → PO ${result.bestMatch.orderId}`,
                        intent: 'RECONCILIATION',
                        action_taken: `Auto-applied: ${applyResult.applied.length} changes`,
                        metadata: identity,
                    });
                } else {
                    // Needs human approval — the reconciler already handles logging
                    console.log(
                        `[invoice-matcher] PO ${result.bestMatch.orderId} needs approval (${reconResult.overallVerdict})`,
                    );
                }
            } catch (reconErr: any) {
                console.error(
                    `[invoice-matcher] Reconciliation failed for PO ${result.bestMatch.orderId}: ${reconErr.message}`,
                );
                // Log the failure so it shows on the dashboard
                try {
                    await db.from('ap_activity_log').insert({
                        intent: 'RECONCILIATION_AUTO_APPLY_FAILED',
                        action_taken: `Reconciliation failed for ${inv.invoice_number} → PO ${result.bestMatch.orderId}`,
                        metadata: {
                            invoiceNumber: inv.invoice_number,
                            poNumber: result.bestMatch.orderId,
                            vendorName: inv.vendor_name,
                            score: result.bestMatch.score,
                            error: reconErr?.message || String(reconErr),
                        },
                        email_from: inv.vendor_name || '',
                        email_subject: `Recon failed — ${inv.invoice_number}`,
                    });
                } catch {
                    // Non-critical
                }
            }

            autoMatched.push({
                invoiceId: inv.id,
                poNumber: result.bestMatch.orderId,
                score: result.bestMatch.score,
            });

            console.log(
                `[invoice-matcher] Auto-matched ${inv.invoice_number} → PO ${result.bestMatch.orderId} ` +
                `(score: ${result.bestMatch.score}, ${result.bestMatch.reasons.join(", ")})`,
            );
        } else if (result.candidates.length > 0) {
            needsReview++;
        }
    }

    return { autoMatched, needsReview };
}

// ── Batch freight reconciliation (for cron) ─────────────────────────────────

/**
 * Find already-matched invoices (po_number set, freight > 0) whose freight
 * has never been pushed to Finale, and push it via the reconciliation engine.
 *
 * The 30-min matching cron (batchMatchUnmatchedInvoices) handles NEW matches.
 * This function catches the backlog: invoices matched before the lifecycle
 * engine existed, or where reconciliation was deferred.
 *
 * Only processes invoices whose PO has NOT reached RECONCILED/RECEIVED/COMPLETED.
 * Processes at most `limit` per call to keep cron bounded.
 */
export async function batchReconcileExistingFreight(limit: number = 10): Promise<{
    pushed: Array<{ invoiceId: string; poNumber: string; freight: number }>;
    skipped: number;
    errors: number;
}> {
    const db = createClient();
    const pushed: Array<{ invoiceId: string; poNumber: string; freight: number }> = [];
    let skipped = 0;
    let errors = 0;

    if (!db) return { pushed, skipped, errors };

    // Find matched invoices with freight that haven't been reconciled yet.
    // Join against purchase_orders to exclude POs that are already
    // RECONCILED, RECEIVED, or COMPLETED (freight was already pushed).
    // Also exclude CANCELLED POs.
    const { data: candidates } = await db
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, invoice_date, subtotal, freight, tax, total, po_number, raw_data, line_items")
        .gt("freight", 0)
        .not("po_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(limit * 3); // overfetch — we filter post-query

    if (!candidates || candidates.length === 0) {
        return { pushed, skipped, errors };
    }

    // Pre-load PO lifecycle states in one batch to avoid N+1 queries
    const poNumbers = [...new Set((candidates as any[]).map(c => c.po_number))];
    const { data: pos } = await db
        .from("purchase_orders")
        .select("po_number, lifecycle_state")
        .in("po_number", poNumbers);

    const poStateMap = new Map<string, string>();
    for (const po of (pos || []) as any[]) {
        poStateMap.set(po.po_number, po.lifecycle_state || "");
    }

    // Pre-check: find invoices that already have a RECONCILIATION log entry
    // for this invoice+PO combo (dedup — don't double-reconcile)
    const { data: existingLogs } = await db
        .from("ap_activity_log")
        .select("metadata")
        .eq("intent", "RECONCILIATION")
        .in("metadata->>invoiceNumber", (candidates as any[]).map(c => c.invoice_number))
        .not("metadata->>poNumber", "is", null);

    const reconciledSet = new Set<string>();
    for (const log of (existingLogs || []) as any[]) {
        const m = log.metadata;
        if (m?.invoiceNumber && m?.poNumber) {
            reconciledSet.add(`${m.invoiceNumber}::${m.poNumber}`);
        }
    }

    // Process candidates
    let processed = 0;
    for (const inv of (candidates as any[])) {
        if (processed >= limit) break;

        const state = poStateMap.get(inv.po_number) || "";
        const terminalStates = ["RECONCILED", "RECEIVED", "COMPLETED", "CANCELLED"];

        // Skip if PO is already in a terminal reconciliation state
        if (terminalStates.includes(state)) {
            skipped++;
            continue;
        }

        // Skip if PO doesn't exist in our local mirror (stale data — PO was likely
        // deleted or never synced from Finale)
        if (!poStateMap.has(inv.po_number)) {
            skipped++;
            continue;
        }

        // Skip if already reconciled (dedup via ap_activity_log)
        const dedupKey = `${inv.invoice_number}::${inv.po_number}`;
        if (reconciledSet.has(dedupKey)) {
            skipped++;
            continue;
        }

        processed++;

        try {
            const finale = new FinaleClient();

            const rawData = inv.raw_data as Record<string, unknown> | undefined;
            const hasValidRawData =
                rawData &&
                typeof rawData.vendorName === 'string' &&
                typeof rawData.invoiceNumber === 'string' &&
                typeof rawData.total === 'number';

            const invoiceData = hasValidRawData ? rawData : {
                vendorName: inv.vendor_name,
                invoiceNumber: inv.invoice_number,
                invoiceDate: inv.invoice_date,
                dueDate: null,
                total: Number(inv.total || 0),
                amountDue: Number(inv.total || 0),
                subtotal: Number(inv.subtotal || 0),
                freight: Number(inv.freight || 0),
                tax: Number(inv.tax || 0),
                poNumber: inv.po_number,
                lineItems: inv.line_items || [],
                confidence: "medium" as const,
            };

            const reconResult = await reconcileInvoiceToPO(
                invoiceData as any,
                inv.po_number,
                finale,
                'freight-backfill',
            );

            // Only auto-apply if the reconciler is confident (auto_approve or line_level_ok)
            const autoVerdicts = new Set(['auto_approve', 'line_level_ok']);
            if (autoVerdicts.has(reconResult.overallVerdict)) {
                const applyResult = await applyReconciliation(reconResult, finale);
                pushed.push({
                    invoiceId: inv.id,
                    poNumber: inv.po_number,
                    freight: Number(inv.freight || 0),
                });

                // Transition PO to RECONCILED
                await transitionLifecycleState(
                    inv.po_number,
                    'RECONCILED',
                    'freight-backfill',
                    {
                        invoiceId: inv.id,
                        invoiceNumber: inv.invoice_number,
                        freight: Number(inv.freight || 0),
                        applied: applyResult.applied.length,
                    }
                );

                // Write activity log for dedup
                await db.from('ap_activity_log').insert({
                    intent: 'RECONCILIATION',
                    action_taken: `Freight backfill: push $${Number(inv.freight || 0).toFixed(2)} freight for invoice ${inv.invoice_number} → PO ${inv.po_number}`,
                    metadata: {
                        invoiceNumber: inv.invoice_number,
                        poNumber: inv.po_number,
                        vendorName: inv.vendor_name,
                        freight: Number(inv.freight || 0),
                        verdict: reconResult.overallVerdict,
                    },
                    email_from: inv.vendor_name || '',
                    email_subject: `Freight backfill — ${inv.invoice_number}`,
                });

                // Also mark in reconciledSet to prevent double-processing in this batch
                reconciledSet.add(dedupKey);

                console.log(
                    `[freight-backfill] Pushed $${Number(inv.freight || 0).toFixed(2)} freight: ` +
                    `${inv.invoice_number} → PO ${inv.po_number} (${applyResult.applied.length} changes)`
                );
            } else {
                console.log(
                    `[freight-backfill] PO ${inv.po_number} needs approval for freight push ` +
                    `(${reconResult.overallVerdict}) — skipping`
                );
                skipped++;
            }
        } catch (err: any) {
            errors++;
            console.error(
                `[freight-backfill] Error processing ${inv.invoice_number} → PO ${inv.po_number}: ${err.message}`
            );
        }
    }

    // Don't leave stuck APPROVAL rows from batch-run (they need human review via Telegram)
    // Best-effort — expire any stale approvals older than their expiration
    try {
        await db
            .from("ap_pending_approvals")
            .update({ status: "expired" })
            .eq("status", "pending")
            .lt("expires_at", new Date().toISOString());
    } catch {
        // Non-critical cleanup
    }

    return { pushed, skipped, errors };
}
