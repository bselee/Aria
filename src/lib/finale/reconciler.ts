/**
 * @file    reconciler.ts
 * @purpose Core invoice → PO reconciliation engine.
 *          Compares parsed invoice data against Finale PO details,
 *          identifies price/fee changes, applies safety guardrails,
 *          and orchestrates Finale writes (or flags for human review).
 * @author  Aria (Antigravity)
 * @created 2026-02-26
 * @updated 2026-02-26
 * @deps    finale/client, pdf/invoice-parser, supabase
 *
 * DECISION(2026-02-26): Price update safety guardrails:
 *   1. ≤3% variance → auto-approve, apply, Telegram notify
 *   2. >3% but <10x → flag for Telegram bot approval before applying
 *   3. >10x magnitude shift → REJECT outright (likely decimal error)
 *   4. Total PO impact >$500 delta → require manual approval regardless
 * 
 * These thresholds prevent catastrophic pricing errors like $2.60 → $26,000
 * which can happen from OCR misreads, decimal slips, or unit-of-measure confusion.
 */

import { FinaleClient } from "./client";
import { InvoiceData } from "../pdf/invoice-parser";
import { createClient } from "../supabase";

// ──────────────────────────────────────────────────
// PENDING APPROVAL STORE
// ──────────────────────────────────────────────────

/**
 * In-memory store for reconciliation results awaiting Telegram bot approval.
 * Keyed by a unique approval ID (e.g., "approval_<orderId>_<timestamp>").
 * Entries expire after 24 hours.
 *
 * DECISION(2026-02-26): Using Telegram bot (not Slack) for approvals per Will.
 * In-memory is acceptable because:
 *   - Volume is low (a few invoices per day)
 *   - If process restarts, unapproved items simply re-process next cycle
 *   - No persistent side-effects until explicitly approved
 */
export interface PendingApproval {
    id: string;
    result: ReconciliationResult;
    client: FinaleClient;
    createdAt: number;
    status: "pending" | "approved" | "rejected" | "expired";
}

const pendingApprovals = new Map<string, PendingApproval>();

/** Store a reconciliation result for bot approval */
export function storePendingApproval(result: ReconciliationResult, client: FinaleClient): string {
    const id = `recon_${result.orderId}_${Date.now()}`;
    pendingApprovals.set(id, {
        id,
        result,
        client,
        createdAt: Date.now(),
        status: "pending",
    });

    // Auto-expire after 24h
    setTimeout(() => {
        const entry = pendingApprovals.get(id);
        if (entry && entry.status === "pending") {
            entry.status = "expired";
            pendingApprovals.delete(id);
        }
    }, 24 * 60 * 60 * 1000);

    return id;
}

/** Retrieve a pending approval by ID */
export function getPendingApproval(id: string): PendingApproval | undefined {
    return pendingApprovals.get(id);
}

/** Mark a pending approval as approved and apply changes */
export async function approvePendingReconciliation(id: string): Promise<{
    success: boolean;
    applied: string[];
    errors: string[];
    message: string;
}> {
    const entry = pendingApprovals.get(id);
    if (!entry) {
        return { success: false, applied: [], errors: [], message: "Approval not found or expired." };
    }
    if (entry.status !== "pending") {
        return { success: false, applied: [], errors: [], message: `Already ${entry.status}.` };
    }

    // Approve ALL needs_approval price items
    const approvedPriceItems = entry.result.priceChanges
        .filter(pc => pc.verdict === "needs_approval")
        .map(pc => pc.productId);

    // Approve ALL needs_approval fee items
    const approvedFeeTypes = entry.result.feeChanges
        .filter(fc => fc.verdict === "needs_approval")
        .map(fc => fc.feeType);

    const applyResult = await applyReconciliation(
        entry.result, entry.client, approvedPriceItems, approvedFeeTypes
    );
    entry.status = "approved";
    pendingApprovals.delete(id);

    // Write RECONCILIATION entry to ap_activity_log for duplicate detection.
    // Future re-processes of this invoice+PO combo will hit checkDuplicateReconciliation().
    try {
        const supabase = createClient();
        if (supabase) {
            await supabase.from("ap_activity_log").insert({
                email_from: entry.result.vendorName,
                email_subject: `Invoice ${entry.result.invoiceNumber} → PO ${entry.result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: `Approved via Telegram: ${applyResult.applied.length} applied, ${applyResult.errors.length} errors`,
                metadata: {
                    invoiceNumber: entry.result.invoiceNumber,
                    orderId: entry.result.orderId,
                    approvalId: id,
                    applied: applyResult.applied,
                    errors: applyResult.errors,
                },
            });
        }
    } catch (logErr: any) {
        console.warn(`⚠️ Failed to log approval to activity log: ${logErr.message}`);
    }

    return {
        success: true,
        applied: applyResult.applied,
        errors: applyResult.errors,
        message: `✅ Applied ${applyResult.applied.length} change(s) to PO ${entry.result.orderId}.`,
    };
}

/** Reject a pending reconciliation */
export async function rejectPendingReconciliation(id: string): Promise<string> {
    const entry = pendingApprovals.get(id);
    if (!entry) return "Approval not found or expired.";
    if (entry.status !== "pending") return `Already ${entry.status}.`;

    entry.status = "rejected";
    pendingApprovals.delete(id);

    // Write to ap_activity_log so checkDuplicateReconciliation() catches future
    // re-processing of the same invoice — rejections must be "sticky".
    try {
        const supabase = createClient();
        if (supabase) {
            await supabase.from("ap_activity_log").insert({
                email_from: entry.result.vendorName,
                email_subject: `Invoice ${entry.result.invoiceNumber} → PO ${entry.result.orderId}`,
                intent: "RECONCILIATION",
                action_taken: "Rejected via Telegram — no changes applied",
                metadata: {
                    invoiceNumber: entry.result.invoiceNumber,
                    orderId: entry.result.orderId,
                    approvalId: id,
                    verdict: "rejected",
                },
            });
        }
    } catch (logErr: any) {
        console.warn(`⚠️ Failed to log rejection to activity log: ${logErr.message}`);
    }

    return `❌ Rejected changes to PO ${entry.result.orderId}. No updates applied.`;
}

// ──────────────────────────────────────────────────
// DUPLICATE DETECTION
// ──────────────────────────────────────────────────

/**
 * Check whether this invoice+PO combination has already been reconciled.
 * Queries ap_activity_log for a prior RECONCILIATION entry with matching
 * invoiceNumber and orderId in the metadata JSONB column.
 *
 * DECISION(2026-02-26): Fail-open on Supabase errors — if the check itself
 * fails we proceed rather than blocking a legitimate first-time reconciliation.
 * The trade-off: occasional double-process is safer than permanent blockage.
 *
 * NOTE: Approvals via Telegram (approvePendingReconciliation) also write here
 * so that they are caught on any subsequent re-processing of the same email.
 */
async function checkDuplicateReconciliation(
    invoiceNumber: string,
    orderId: string
): Promise<{ isDuplicate: boolean; processedAt?: string; actionTaken?: string }> {
    try {
        const supabase = createClient();
        if (!supabase) return { isDuplicate: false };

        const { data, error } = await supabase
            .from("ap_activity_log")
            .select("created_at, action_taken")
            .eq("intent", "RECONCILIATION")
            .filter("metadata->>invoiceNumber", "eq", invoiceNumber)
            .filter("metadata->>orderId", "eq", orderId)
            .order("created_at", { ascending: false })
            .limit(1);

        if (error || !data || data.length === 0) return { isDuplicate: false };

        const entry = data[0];
        const processedAt = new Date(entry.created_at).toLocaleDateString("en-US", {
            month: "2-digit",
            day: "2-digit",
            year: "numeric",
        });

        return { isDuplicate: true, processedAt, actionTaken: entry.action_taken };
    } catch (err: any) {
        console.warn(`⚠️ Duplicate check failed, proceeding anyway: ${err.message}`);
        return { isDuplicate: false };
    }
}

// ──────────────────────────────────────────────────
// CONFIGURATION — Safety thresholds
// ──────────────────────────────────────────────────

/**
 * DECISION(2026-02-26): Safety thresholds for price changes.
 * These are intentionally conservative — better to ask than to auto-apply
 * a catastrophic price change to Finale.
 */
const RECONCILIATION_CONFIG = {
    /** ≤3% price change → auto-approve without human review */
    AUTO_APPROVE_PERCENT: 0.03,

    /**
     * Maximum multiplier before outright rejection.
     * If new_price / old_price > 10 or < 0.1, the price change is
     * assumed to be a decimal error (e.g., $2.60 → $26,000).
     * These are NEVER auto-applied — they require explicit correction.
     */
    MAGNITUDE_CEILING: 10,

    /**
     * If total PO dollar impact exceeds this, require manual approval
     * regardless of per-line percentage.
     * Example: 100 units × $0.50 price increase = $50 (auto-OK)
     *          100 units × $10.00 price increase = $1000 (needs approval)
     */
    TOTAL_IMPACT_CAP_DOLLARS: 500,

    /**
     * Maximum individual line item price we'll ever auto-approve a change for.
     * Anything above this unit price gets manual review no matter the % change.
     * Prevents silent updates on high-value items.
     */
    HIGH_VALUE_THRESHOLD: 5000,

    /**
     * Maximum fee/charge (freight, tariff, labor, tax) that can be auto-applied
     * without Telegram approval. Prevents a $50,000 tariff from being silently
     * written to Finale. The delta (invoice fee - existing PO fee) is what's measured.
     */
    FEE_AUTO_APPROVE_CAP_DOLLARS: 250,

    /**
     * Jaccard word-overlap threshold for fuzzy vendor name matching.
     * 0.5 = at least half the unique words appear in both names.
     * Below this, correlation falls back to PO# reference and SKU overlap.
     */
    VENDOR_FUZZY_THRESHOLD: 0.5,
} as const;

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type ReconciliationVerdict =
    | "auto_approve"      // ≤3% change, safe to apply automatically
    | "needs_approval"    // >3% change, send to Telegram for approval
    | "rejected"          // Magnitude error detected, do NOT apply
    | "duplicate"         // Invoice already reconciled — do not re-apply
    | "no_change"         // Prices match, nothing to do
    | "no_match";         // Could not find matching line item

export interface PriceChange {
    productId: string;
    description: string;
    poPrice: number;
    invoicePrice: number;
    quantity: number;
    percentChange: number;
    dollarImpact: number;       // (invoicePrice - poPrice) × quantity
    verdict: ReconciliationVerdict;
    reason: string;
}

export interface FeeChange {
    feeType: keyof typeof FinaleClient.FINALE_FEE_TYPES;
    amount: number;
    description: string;
    existingAmount: number;     // 0 if new fee
    isNew: boolean;
    verdict: "auto_approve" | "needs_approval";
    reason: string;
}

export interface TrackingUpdate {
    trackingNumbers: string[];
    shipDate?: string;
    carrierName?: string;
}

export interface ReconciliationResult {
    orderId: string;
    invoiceNumber: string;
    vendorName: string;
    priceChanges: PriceChange[];
    feeChanges: FeeChange[];
    trackingUpdate: TrackingUpdate | null;
    overallVerdict: ReconciliationVerdict;
    summary: string;
    totalDollarImpact: number;
    autoApplicable: boolean;    // True only if ALL changes are auto_approve or no_change
    warnings: string[];         // Non-blocking issues (vendor fuzzy match, low-confidence match, etc.)
    vendorNote?: string;        // Set when vendor correlation used non-name signal to confirm
}

// ──────────────────────────────────────────────────
// CORE RECONCILIATION
// ──────────────────────────────────────────────────

/**
 * Compare an invoice against a Finale PO and determine what needs updating.
 * Does NOT mutate Finale — only produces a reconciliation plan.
 *
 * Guard sequence (fast-fail order):
 *   0. Duplicate detection   — already reconciled? Stop immediately.
 *   1. Vendor correlation    — does this invoice belong to this PO?
 *   2. Quantity overbill     — per-line check inside reconcileLineItems()
 *   3. Fee threshold         — per-fee check inside reconcileFees()
 *   4. Price % + magnitude   — existing guardrails in evaluatePriceChange()
 *   5. Total impact cap      — aggregate dollar check
 *
 * @param invoice   - Parsed invoice data from the LLM extractor
 * @param orderId   - The Finale PO orderId to reconcile against
 * @param client    - FinaleClient instance for reading PO data
 * @returns ReconciliationResult with detailed change plan and safety verdicts
 */
export async function reconcileInvoiceToPO(
    invoice: InvoiceData,
    orderId: string,
    client: FinaleClient
): Promise<ReconciliationResult> {
    const warnings: string[] = [];

    // ── Guard 0: Duplicate detection ──────────────────────────────────────────
    // Fast-fail before any Finale reads. If this invoice+PO combo was already
    // reconciled, stop cold and alert loudly — do not re-apply anything.
    const dupeCheck = await checkDuplicateReconciliation(invoice.invoiceNumber, orderId);
    if (dupeCheck.isDuplicate) {
        const dupeSummary =
            `🔁 DUPLICATE INVOICE: Invoice #${invoice.invoiceNumber} was already ` +
            `reconciled against PO ${orderId} on ${dupeCheck.processedAt}. ` +
            `No changes applied.\nPrior action: ${dupeCheck.actionTaken}`;
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "duplicate",
            summary: dupeSummary,
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: [],
        };
    }

    // ── Fetch PO ───────────────────────────────────────────────────────────────
    const poSummary = await client.getOrderSummary(orderId);
    if (!poSummary) {
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "no_match",
            summary: `⚠️ Could not fetch PO ${orderId} from Finale`,
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: [],
        };
    }

    // ── Guard 1: Vendor correlation ────────────────────────────────────────────
    // Verify the invoice vendor plausibly matches this PO's supplier.
    // Falls back to PO# reference and SKU overlap when names diverge.
    const vendorCorrelation = validateVendorCorrelation(invoice, poSummary, orderId);
    let vendorNote: string | undefined;

    if (!vendorCorrelation.pass) {
        // Low confidence — no name, PO#, or SKU evidence. Escalate for human review.
        return {
            orderId,
            invoiceNumber: invoice.invoiceNumber,
            vendorName: invoice.vendorName,
            priceChanges: [],
            feeChanges: [],
            trackingUpdate: null,
            overallVerdict: "needs_approval",
            summary: buildReconciliationSummary(
                orderId, invoice, [], [], null, 0, "needs_approval",
                [vendorCorrelation.note]
            ),
            totalDollarImpact: 0,
            autoApplicable: false,
            warnings: [vendorCorrelation.note],
            vendorNote: vendorCorrelation.note,
        };
    } else if (vendorCorrelation.confidence !== "high") {
        // Medium confidence — proceed but surface the mismatch in the summary
        warnings.push(vendorCorrelation.note);
        vendorNote = vendorCorrelation.note;
    }

    // 1. Compare line item prices (includes Guard 2: overbill check)
    const priceChanges = reconcileLineItems(invoice, poSummary);

    // 2. Compare fees (includes Guard 3: fee dollar threshold)
    const feeChanges = reconcileFees(invoice, poSummary);

    // 3. Check for tracking info
    const trackingUpdate = reconcileTracking(invoice);

    // 4. Calculate total dollar impact
    const totalDollarImpact =
        priceChanges.reduce((sum, pc) => sum + Math.abs(pc.dollarImpact), 0) +
        feeChanges.reduce((sum, fc) => sum + Math.abs(fc.amount - fc.existingAmount), 0);

    // 5. Apply total-impact safety check
    //    Even if individual lines are ≤3%, if aggregate PO impact > $500, escalate
    if (totalDollarImpact > RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS) {
        for (const pc of priceChanges) {
            if (pc.verdict === "auto_approve") {
                pc.verdict = "needs_approval";
                pc.reason += ` | Total PO impact $${totalDollarImpact.toFixed(2)} exceeds $${RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS} cap`;
            }
        }
    }

    // 6. Determine overall verdict — fee verdicts now count alongside price verdicts
    const priceVerdicts = priceChanges.map(pc => pc.verdict);
    const feeVerdicts = feeChanges.map(fc => fc.verdict);
    let overallVerdict: ReconciliationVerdict = "no_change";

    if (priceVerdicts.includes("rejected")) {
        overallVerdict = "rejected";
    } else if (priceVerdicts.includes("needs_approval") || feeVerdicts.includes("needs_approval")) {
        overallVerdict = "needs_approval";
    } else if (priceVerdicts.includes("auto_approve") || feeChanges.length > 0 || trackingUpdate) {
        overallVerdict = "auto_approve";
    }

    const autoApplicable = overallVerdict === "auto_approve" || overallVerdict === "no_change";

    // 7. Build summary
    const summary = buildReconciliationSummary(
        orderId, invoice, priceChanges, feeChanges, trackingUpdate,
        totalDollarImpact, overallVerdict, warnings
    );

    return {
        orderId,
        invoiceNumber: invoice.invoiceNumber,
        vendorName: invoice.vendorName,
        priceChanges,
        feeChanges,
        trackingUpdate,
        overallVerdict,
        summary,
        totalDollarImpact,
        autoApplicable,
        warnings,
        vendorNote,
    };
}

// ──────────────────────────────────────────────────
// VENDOR CORRELATION
// ──────────────────────────────────────────────────

/**
 * Jaccard word-overlap similarity between two strings (0.0–1.0).
 * Normalizes to lowercase, strips punctuation, splits on whitespace.
 * "BuildASoil Organics" vs "BuildASoil Organics LLC" → ~0.67
 */
function wordOverlapSimilarity(a: string, b: string): number {
    const normalize = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);

    const wordsA = new Set(normalize(a));
    const wordsB = new Set(normalize(b));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const w of wordsA) { if (wordsB.has(w)) overlap++; }

    const union = new Set([...wordsA, ...wordsB]).size;
    return overlap / union;
}

/**
 * Validate that the invoice vendor plausibly belongs to this Finale PO.
 * Uses a three-signal waterfall:
 *   1. Vendor name similarity ≥ VENDOR_FUZZY_THRESHOLD  →  HIGH confidence
 *   2. Invoice PO# matches orderId                       →  MEDIUM confidence
 *   3. ≥50% of invoice SKUs found on PO lines           →  MEDIUM confidence
 *   None match                                           →  LOW → block auto-apply
 *
 * Returning pass:false means the reconciliation becomes "needs_approval" so
 * Will sees the mismatch before anything touches Finale.
 */
function validateVendorCorrelation(
    invoice: InvoiceData,
    poSummary: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>,
    orderId: string
): { pass: boolean; confidence: "high" | "medium" | "low"; note: string } {
    // Signal 1: Name similarity
    const similarity = wordOverlapSimilarity(invoice.vendorName, poSummary.supplier);
    if (similarity >= RECONCILIATION_CONFIG.VENDOR_FUZZY_THRESHOLD) {
        return {
            pass: true,
            confidence: "high",
            note: `Vendor matched: "${invoice.vendorName}" ↔ "${poSummary.supplier}" (${(similarity * 100).toFixed(0)}% word overlap)`,
        };
    }

    // Signal 2: PO number on invoice explicitly references this order
    const invoicePORef = (invoice.poNumber ?? "").trim().toLowerCase();
    const orderIdNorm = orderId.trim().toLowerCase();
    if (
        invoicePORef &&
        (invoicePORef === orderIdNorm ||
            invoicePORef.includes(orderIdNorm) ||
            orderIdNorm.includes(invoicePORef))
    ) {
        return {
            pass: true,
            confidence: "medium",
            note: `⚠️ Vendor name mismatch ("${invoice.vendorName}" vs PO supplier "${poSummary.supplier}") — confirmed via PO# reference on invoice (${invoice.poNumber}).`,
        };
    }

    // Signal 3: SKU overlap — at least half the invoice SKUs appear on this PO
    const poSkus = new Set(poSummary.items.map(i => i.productId.toLowerCase()));
    const invoiceSkus = invoice.lineItems
        .map(l => l.sku?.toLowerCase())
        .filter((s): s is string => Boolean(s));

    if (invoiceSkus.length > 0) {
        const matched = invoiceSkus.filter(s => poSkus.has(s)).length;
        if (matched / invoiceSkus.length >= 0.5) {
            return {
                pass: true,
                confidence: "medium",
                note: `⚠️ Vendor name mismatch ("${invoice.vendorName}" vs PO supplier "${poSummary.supplier}") — confirmed by ${matched}/${invoiceSkus.length} SKU matches.`,
            };
        }
    }

    // No signals matched — block and require manual review
    return {
        pass: false,
        confidence: "low",
        note: `🚨 VENDOR MISMATCH: Invoice vendor "${invoice.vendorName}" does not correlate with PO supplier "${poSummary.supplier}". No PO# or SKU evidence to confirm. Manual review required.`,
    };
}

// ──────────────────────────────────────────────────
// LINE ITEM PRICE COMPARISON
// ──────────────────────────────────────────────────

function reconcileLineItems(
    invoice: InvoiceData,
    po: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>
): PriceChange[] {
    const changes: PriceChange[] = [];

    for (const invLine of invoice.lineItems) {
        // Try to match by SKU first, then by fuzzy description
        const poLine = findMatchingPOLine(invLine, po.items);

        if (!poLine) {
            // Invoice has a line item not found in PO — info only, don't block
            changes.push({
                productId: invLine.sku || "UNKNOWN",
                description: invLine.description,
                poPrice: 0,
                invoicePrice: invLine.unitPrice,
                quantity: invLine.qty,
                percentChange: 100,
                dollarImpact: invLine.total,
                verdict: "no_match",
                reason: "Invoice line item not found in PO — may be a new item or SKU mismatch",
            });
            continue;
        }

        const priceDelta = invLine.unitPrice - poLine.unitPrice;
        const percentChange = poLine.unitPrice > 0
            ? Math.abs(priceDelta) / poLine.unitPrice
            : (invLine.unitPrice > 0 ? 1 : 0);

        const dollarImpact = priceDelta * invLine.qty;

        // Run through price safety checks
        let { verdict: pVerdict, reason: pReason } = evaluatePriceChange(
            poLine.unitPrice,
            invLine.unitPrice,
            percentChange,
            dollarImpact
        );

        // Guard 2: Quantity overbill — never auto-approve if invoice qty > PO qty.
        // Even a tiny price change is suspicious when the vendor is billing for
        // more units than were ordered.
        if (invLine.qty > poLine.quantity && pVerdict === "auto_approve") {
            pVerdict = "needs_approval";
            pReason += ` | ⚠️ OVERBILL: Invoice qty ${invLine.qty} > PO qty ${poLine.quantity} — may be billed for more units than ordered.`;
        }

        changes.push({
            productId: poLine.productId,
            description: invLine.description,
            poPrice: poLine.unitPrice,
            invoicePrice: invLine.unitPrice,
            quantity: invLine.qty,
            percentChange,
            dollarImpact,
            verdict: pVerdict,
            reason: pReason,
        });
    }

    return changes;
}

/**
 * Core safety evaluation for a single price change.
 * 
 * DECISION(2026-02-26): Multi-layer guardrail approach per Will's requirement:
 *   "We can't have $2.60 turn into $26,000.00"
 * 
 * Layer 1: Magnitude check (catches decimal shifts, OCR errors)
 * Layer 2: High-value item check (extra caution on expensive items)
 * Layer 3: Percentage threshold (3% auto / >3% manual)
 * Layer 4: Total impact cap (applied at the PO level, not here)
 */
function evaluatePriceChange(
    poPrice: number,
    invoicePrice: number,
    percentChange: number,
    dollarImpact: number
): { verdict: ReconciliationVerdict; reason: string } {
    // No change — nothing to do
    if (Math.abs(poPrice - invoicePrice) < 0.01) {
        return { verdict: "no_change", reason: "Prices match" };
    }

    // Layer 1: Magnitude check — catch decimal errors
    // $2.60 → $26.00 is a 10x shift, $2.60 → $260.00 is a 100x shift
    if (poPrice > 0 && invoicePrice > 0) {
        const ratio = invoicePrice / poPrice;
        if (ratio > RECONCILIATION_CONFIG.MAGNITUDE_CEILING || ratio < (1 / RECONCILIATION_CONFIG.MAGNITUDE_CEILING)) {
            return {
                verdict: "rejected",
                reason: `🚨 MAGNITUDE ERROR: Price changed from $${poPrice.toFixed(2)} → $${invoicePrice.toFixed(2)} (${ratio.toFixed(1)}x). This looks like a decimal error. NOT applied — requires manual correction.`,
            };
        }
    }

    // Layer 1b: Zero to non-zero (PO had $0, invoice has a real price)
    if (poPrice === 0 && invoicePrice > 0) {
        return {
            verdict: "needs_approval",
            reason: `PO had $0.00 price, invoice shows $${invoicePrice.toFixed(2)}. May be a placeholder PO line.`,
        };
    }

    // Layer 2: High-value items always need manual review
    if (invoicePrice > RECONCILIATION_CONFIG.HIGH_VALUE_THRESHOLD) {
        return {
            verdict: "needs_approval",
            reason: `High-value item ($${invoicePrice.toFixed(2)}/unit) — requires manual review regardless of % change.`,
        };
    }

    // Layer 3: Percentage threshold
    if (percentChange <= RECONCILIATION_CONFIG.AUTO_APPROVE_PERCENT) {
        const direction = dollarImpact > 0 ? "increase" : "decrease";
        return {
            verdict: "auto_approve",
            reason: `${(percentChange * 100).toFixed(1)}% price ${direction} ($${poPrice.toFixed(2)} → $${invoicePrice.toFixed(2)}) — within ${RECONCILIATION_CONFIG.AUTO_APPROVE_PERCENT * 100}% auto-threshold.`,
        };
    }

    // >3% but within magnitude limits — needs human approval
    const direction = dollarImpact > 0 ? "increase" : "decrease";
    return {
        verdict: "needs_approval",
        reason: `${(percentChange * 100).toFixed(1)}% price ${direction} ($${poPrice.toFixed(2)} → $${invoicePrice.toFixed(2)}, impact: $${Math.abs(dollarImpact).toFixed(2)}) — exceeds ${RECONCILIATION_CONFIG.AUTO_APPROVE_PERCENT * 100}% auto-threshold.`,
    };
}

/**
 * Find the matching PO line item for an invoice line.
 * Tries exact SKU match first, then fuzzy description match.
 */
function findMatchingPOLine(
    invLine: { sku?: string; description: string; unitPrice: number },
    poItems: Array<{ productId: string; unitPrice: number; quantity: number; description: string }>
): { productId: string; unitPrice: number; quantity: number } | null {
    // Strategy 1: Exact SKU match (case-insensitive)
    if (invLine.sku) {
        const skuLower = invLine.sku.toLowerCase();
        const match = poItems.find(item => item.productId.toLowerCase() === skuLower);
        if (match) return match;

        // Strategy 1b: SKU as substring (vendor may add prefixes/suffixes)
        const substringMatch = poItems.find(item =>
            item.productId.toLowerCase().includes(skuLower) ||
            skuLower.includes(item.productId.toLowerCase())
        );
        if (substringMatch) return substringMatch;
    }

    // Strategy 2: Description similarity (first 20 chars, case-insensitive)
    if (invLine.description) {
        const descLower = invLine.description.toLowerCase().slice(0, 30);
        const descMatch = poItems.find(item =>
            item.description.toLowerCase().includes(descLower) ||
            descLower.includes(item.description.toLowerCase().slice(0, 30))
        );
        if (descMatch) return descMatch;
    }

    // Strategy 3: Price match (if only 1 item matches the price exactly)
    const priceMatches = poItems.filter(item =>
        Math.abs(item.unitPrice - invLine.unitPrice) < 0.01
    );
    if (priceMatches.length === 1) return priceMatches[0];

    return null;
}

// ──────────────────────────────────────────────────
// FEE COMPARISON
// ──────────────────────────────────────────────────

function reconcileFees(
    invoice: InvoiceData,
    po: NonNullable<Awaited<ReturnType<FinaleClient["getOrderSummary"]>>>
): FeeChange[] {
    const changes: FeeChange[] = [];

    // Map invoice charges to Finale fee types
    const feeMapping: Array<{
        invoiceField: keyof InvoiceData;
        feeType: keyof typeof FinaleClient.FINALE_FEE_TYPES;
        label: string;
    }> = [
            { invoiceField: "freight", feeType: "FREIGHT", label: "Freight" },
            { invoiceField: "tax", feeType: "TAX", label: "Tax" },
            { invoiceField: "tariff", feeType: "TARIFF", label: "Duties/Tariff" },
            { invoiceField: "labor", feeType: "LABOR", label: "Labor" },
            { invoiceField: "fuelSurcharge", feeType: "SHIPPING", label: "Fuel Surcharge" },
        ];

    for (const mapping of feeMapping) {
        const invoiceAmount = invoice[mapping.invoiceField] as number | undefined;
        if (!invoiceAmount || invoiceAmount <= 0) continue;

        // Check if PO already has this fee type
        const existingFee = po.adjustments.find(adj =>
            adj.description.toLowerCase().includes(mapping.label.toLowerCase())
        );

        const existingAmount = existingFee?.amount || 0;

        // Only add if it's new or materially different
        if (Math.abs(invoiceAmount - existingAmount) > 0.01) {
            // Guard 3: Fee threshold — delta above cap requires Telegram approval.
            // The delta (not the full fee amount) is what matters: a $300 freight
            // charge on a PO that already has $280 freight is only a $20 change.
            const feeDelta = Math.abs(invoiceAmount - existingAmount);
            const verdict: "auto_approve" | "needs_approval" =
                feeDelta > RECONCILIATION_CONFIG.FEE_AUTO_APPROVE_CAP_DOLLARS
                    ? "needs_approval"
                    : "auto_approve";
            const reason = verdict === "needs_approval"
                ? `Fee delta $${feeDelta.toFixed(2)} exceeds $${RECONCILIATION_CONFIG.FEE_AUTO_APPROVE_CAP_DOLLARS} auto-approve cap — requires approval`
                : `Fee delta $${feeDelta.toFixed(2)} within $${RECONCILIATION_CONFIG.FEE_AUTO_APPROVE_CAP_DOLLARS} auto-approve cap`;

            changes.push({
                feeType: mapping.feeType,
                amount: invoiceAmount,
                description: mapping.label,
                existingAmount,
                isNew: existingAmount === 0,
                verdict,
                reason,
            });
        }
    }

    return changes;
}

// ──────────────────────────────────────────────────
// TRACKING
// ──────────────────────────────────────────────────

function reconcileTracking(invoice: InvoiceData): TrackingUpdate | null {
    const trackingNumbers = invoice.trackingNumbers?.filter(t => t.trim()) || [];
    if (trackingNumbers.length === 0 && !invoice.shipDate) return null;

    return {
        trackingNumbers,
        shipDate: invoice.shipDate,
        carrierName: invoice.carrierName,
    };
}

// ──────────────────────────────────────────────────
// APPLY CHANGES TO FINALE
// ──────────────────────────────────────────────────

/**
 * Apply auto-approved changes to Finale.
 * Only applies changes with verdict "auto_approve" or fee additions.
 * Returns a log of what was applied and what was skipped.
 * 
 * IMPORTANT: This should only be called after reconcileInvoiceToPO()
 * and verifying that autoApplicable is true OR after receiving
 * manual Slack approval for needs_approval items.
 */
export async function applyReconciliation(
    result: ReconciliationResult,
    client: FinaleClient,
    approvedItems?: string[],  // productIds that were manually approved
    approvedFeeTypes?: string[] // feeTypes that were manually approved
): Promise<{
    applied: string[];
    skipped: string[];
    errors: string[];
}> {
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    // 1. Apply price changes
    for (const pc of result.priceChanges) {
        const isApproved = pc.verdict === "auto_approve" ||
            (pc.verdict === "needs_approval" && approvedItems?.includes(pc.productId));

        if (!isApproved) {
            skipped.push(`${pc.productId}: ${pc.reason}`);
            continue;
        }

        try {
            await client.updateOrderItemPrice(result.orderId, pc.productId, pc.invoicePrice);
            applied.push(`${pc.productId}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)}`);
        } catch (err: any) {
            errors.push(`${pc.productId}: Failed — ${err.message}`);
        }
    }

    // 2. Apply fee changes — gated on per-fee verdict
    // auto_approve fees apply immediately; needs_approval fees only apply
    // if the user explicitly approved them via Telegram button.
    for (const fc of result.feeChanges) {
        const feeApproved = fc.verdict === "auto_approve" ||
            (fc.verdict === "needs_approval" && approvedFeeTypes?.includes(fc.feeType));

        if (!feeApproved) {
            skipped.push(`Fee: ${fc.description} $${fc.amount.toFixed(2)} — ${fc.reason}`);
            continue;
        }

        try {
            if (fc.isNew) {
                await client.addOrderAdjustment(
                    result.orderId,
                    fc.feeType,
                    fc.amount,
                    fc.description
                );
                applied.push(`Fee: ${fc.description} $${fc.amount.toFixed(2)}`);
            } else {
                // TODO(will)[2026-03-15]: Handle fee updates (not just additions).
                // For now we skip updating existing fees — only add new ones.
                skipped.push(`Fee: ${fc.description} already exists ($${fc.existingAmount.toFixed(2)}), invoice has $${fc.amount.toFixed(2)}`);
            }
        } catch (err: any) {
            errors.push(`Fee ${fc.description}: Failed — ${err.message}`);
        }
    }

    // 3. Apply tracking updates (with deduplication)
    if (result.trackingUpdate) {
        try {
            // Phase 4: Dedup tracking numbers against Supabase before writing
            const newTrackingNumbers = await deduplicateTrackingNumbers(
                result.trackingUpdate.trackingNumbers,
                result.invoiceNumber
            );

            if (newTrackingNumbers.length === 0 && !result.trackingUpdate.shipDate) {
                skipped.push("Tracking: All tracking numbers already recorded in Supabase");
            } else {
                const poDetails = await client.getOrderDetails(result.orderId);
                const shipUrls = poDetails.shipmentUrlList || [];

                if (shipUrls.length > 0) {
                    const firstShipment = shipUrls[0];
                    const updates: any = {};

                    if (newTrackingNumbers.length > 0) {
                        updates.trackingCode = newTrackingNumbers[0];
                    }
                    if (result.trackingUpdate.shipDate) {
                        updates.shipDate = result.trackingUpdate.shipDate;
                    }
                    if (result.trackingUpdate.carrierName) {
                        updates.privateNotes = `Carrier: ${result.trackingUpdate.carrierName}`;
                    }

                    await client.updateShipmentTracking(firstShipment, updates);
                    applied.push(`Tracking: ${newTrackingNumbers.join(", ") || "ship date updated"}`);

                    // Save tracking numbers to Supabase for future dedup
                    await saveTrackingNumbers(newTrackingNumbers, result.invoiceNumber);
                } else {
                    skipped.push("Tracking: No shipment found on PO to attach tracking to");
                }
            }
        } catch (err: any) {
            errors.push(`Tracking update failed: ${err.message}`);
        }
    }

    return { applied, skipped, errors };
}

// ──────────────────────────────────────────────────
// TRACKING NUMBER DEDUPLICATION
// ──────────────────────────────────────────────────

/**
 * Check which tracking numbers are new (not yet stored in Supabase).
 * Prevents writing duplicate tracking info to Finale shipments.
 *
 * DECISION(2026-02-26): Dedup at the Supabase level because:
 *   - Multiple invoices may reference the same tracking number
 *   - Finale doesn't have a clean way to check existing tracking
 *   - We need an audit trail of which invoice provided which tracking#
 */
async function deduplicateTrackingNumbers(
    trackingNumbers: string[],
    _invoiceNumber: string   // passed for call-site clarity; dedup uses the numbers only
): Promise<string[]> {
    if (trackingNumbers.length === 0) return [];

    try {
        const supabase = createClient();
        if (!supabase) return trackingNumbers; // No Supabase → skip dedup, write all

        // Check which tracking numbers already exist in any invoice record
        const { data: existingInvoices } = await supabase
            .from("invoices")
            .select("tracking_numbers")
            .overlaps("tracking_numbers", trackingNumbers);

        if (!existingInvoices || existingInvoices.length === 0) {
            return trackingNumbers; // All are new
        }

        // Flatten existing tracking numbers into a Set
        const existingSet = new Set<string>();
        for (const inv of existingInvoices) {
            for (const tn of inv.tracking_numbers || []) {
                existingSet.add(tn.trim().toUpperCase());
            }
        }

        // Filter to only new tracking numbers
        const newNumbers = trackingNumbers.filter(
            tn => !existingSet.has(tn.trim().toUpperCase())
        );

        if (newNumbers.length < trackingNumbers.length) {
            const dupeCount = trackingNumbers.length - newNumbers.length;
            console.log(`   📋 Tracking dedup: ${dupeCount} duplicate(s) filtered, ${newNumbers.length} new`);
        }

        return newNumbers;
    } catch (err: any) {
        console.warn(`⚠️ Tracking dedup failed, writing all: ${err.message}`);
        return trackingNumbers;
    }
}

/**
 * Save tracking numbers to the invoice record in Supabase.
 * Uses array append so multiple invoices can contribute tracking info.
 */
async function saveTrackingNumbers(
    trackingNumbers: string[],
    invoiceNumber: string
): Promise<void> {
    if (trackingNumbers.length === 0) return;

    try {
        const supabase = createClient();
        if (!supabase) return;

        // Update the invoice record with tracking numbers
        await supabase
            .from("invoices")
            .update({ tracking_numbers: trackingNumbers })
            .eq("invoice_number", invoiceNumber);
    } catch (err: any) {
        console.warn(`⚠️ Failed to save tracking numbers: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────
// SUMMARY FORMATTING
// ──────────────────────────────────────────────────

function buildReconciliationSummary(
    orderId: string,
    invoice: InvoiceData,
    priceChanges: PriceChange[],
    feeChanges: FeeChange[],
    trackingUpdate: TrackingUpdate | null,
    totalDollarImpact: number,
    overallVerdict: ReconciliationVerdict,
    warnings: string[] = []
): string {
    const lines: string[] = [];

    // Header
    const emoji = overallVerdict === "auto_approve" ? "✅"
        : overallVerdict === "rejected" ? "🚨"
            : overallVerdict === "duplicate" ? "🔁"
                : overallVerdict === "needs_approval" ? "⚠️"
                    : "ℹ️";

    lines.push(`${emoji} **Invoice Reconciliation: ${invoice.invoiceNumber} → PO ${orderId}**`);
    lines.push(`Vendor: ${invoice.vendorName} | Invoice Total: $${invoice.total.toFixed(2)}`);
    lines.push("");

    // Warnings (vendor mismatch, overbill, etc.)
    if (warnings.length > 0) {
        lines.push("**⚠️ Warnings:**");
        for (const w of warnings) {
            lines.push(`  ${w}`);
        }
        lines.push("");
    }

    // Duplicate — short-circuit the rest
    if (overallVerdict === "duplicate") {
        lines.push("🔁 **DUPLICATE:** This invoice+PO combination has already been reconciled. No changes applied.");
        return lines.join("\n");
    }

    // Price changes
    const meaningful = priceChanges.filter(pc => pc.verdict !== "no_change" && pc.verdict !== "no_match");
    if (meaningful.length > 0) {
        lines.push("**Price Changes:**");
        for (const pc of meaningful) {
            const icon = pc.verdict === "auto_approve" ? "✅"
                : pc.verdict === "rejected" ? "🚨"
                    : "⚠️";
            lines.push(`${icon} ${pc.productId}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)} (${(pc.percentChange * 100).toFixed(1)}%, $${Math.abs(pc.dollarImpact).toFixed(2)} impact)`);
            // Surface overbill / reason details in summary
            if (pc.reason.includes("OVERBILL")) {
                lines.push(`  ⚠️ ${pc.reason.split("|").pop()?.trim()}`);
            }
        }
        lines.push("");
    }

    // Unmatched invoice lines
    const unmatched = priceChanges.filter(pc => pc.verdict === "no_match");
    if (unmatched.length > 0) {
        lines.push("**Unmatched Invoice Lines:**");
        for (const pc of unmatched) {
            lines.push(`❓ ${pc.productId || pc.description.slice(0, 40)}: $${pc.invoicePrice.toFixed(2)} × ${pc.quantity}`);
        }
        lines.push("");
    }

    // Fee changes — now showing per-fee verdict
    if (feeChanges.length > 0) {
        lines.push("**Fee/Charge Updates:**");
        for (const fc of feeChanges) {
            const feeIcon = fc.verdict === "auto_approve" ? "✅" : "⚠️";
            const label = fc.isNew ? "NEW" : `was $${fc.existingAmount.toFixed(2)}`;
            lines.push(`${feeIcon} ${fc.description}: $${fc.amount.toFixed(2)} (${label})`);
            if (fc.verdict === "needs_approval") {
                lines.push(`  ⚠️ ${fc.reason}`);
            }
        }
        lines.push("");
    }

    // Tracking
    if (trackingUpdate) {
        lines.push("**Tracking:**");
        if (trackingUpdate.trackingNumbers.length > 0) {
            lines.push(`🚚 ${trackingUpdate.trackingNumbers.join(", ")}`);
        }
        if (trackingUpdate.shipDate) {
            lines.push(`📅 Ship date: ${trackingUpdate.shipDate}`);
        }
        lines.push("");
    }

    // Total impact
    lines.push(`**Total Dollar Impact:** $${totalDollarImpact.toFixed(2)}`);

    // Verdict
    if (overallVerdict === "auto_approve") {
        lines.push("✅ All changes within auto-approval thresholds. Applying automatically.");
    } else if (overallVerdict === "rejected") {
        lines.push("🚨 **BLOCKED:** Magnitude error detected. Manual correction required.");
    } else if (overallVerdict === "needs_approval") {
        lines.push("⚠️ **Awaiting approval.** Some changes exceed auto-approval thresholds.");
    }

    return lines.join("\n");
}
