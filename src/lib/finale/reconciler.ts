/**
 * @file    reconciler.ts
 * @purpose Core invoice → PO reconciliation engine.
 *          Compares parsed invoice data against Finale PO details,
 *          identifies price/fee changes, applies safety guardrails,
 *          and orchestrates Finale writes (or flags for human review).
 * @author  Aria (Antigravity)
 * @created 2026-02-26
 * @updated 2026-02-26
 * @deps    finale/client, pdf/invoice-parser
 *
 * DECISION(2026-02-26): Price update safety guardrails:
 *   1. ≤3% variance → auto-approve, apply, Slack notify
 *   2. >3% but <10x → flag for Slack approval before applying
 *   3. >10x magnitude shift → REJECT outright (likely decimal error)
 *   4. Total PO impact >$500 delta → require manual approval regardless
 * 
 * These thresholds prevent catastrophic pricing errors like $2.60 → $26,000
 * which can happen from OCR misreads, decimal slips, or unit-of-measure confusion.
 */

import { FinaleClient } from "./client";
import { InvoiceData } from "../pdf/invoice-parser";

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
} as const;

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type ReconciliationVerdict =
    | "auto_approve"      // ≤3% change, safe to apply automatically
    | "needs_approval"    // >3% change, send to Slack for approval
    | "rejected"          // Magnitude error detected, do NOT apply
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
}

// ──────────────────────────────────────────────────
// CORE RECONCILIATION
// ──────────────────────────────────────────────────

/**
 * Compare an invoice against a Finale PO and determine what needs updating.
 * Does NOT mutate Finale — only produces a reconciliation plan.
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
        };
    }

    // 1. Compare line item prices
    const priceChanges = reconcileLineItems(invoice, poSummary);

    // 2. Compare fees (freight, tax, tariff, labor)
    const feeChanges = reconcileFees(invoice, poSummary);

    // 3. Check for tracking info
    const trackingUpdate = reconcileTracking(invoice);

    // 4. Calculate total dollar impact
    const totalDollarImpact =
        priceChanges.reduce((sum, pc) => sum + Math.abs(pc.dollarImpact), 0) +
        feeChanges.reduce((sum, fc) => sum + Math.abs(fc.amount - fc.existingAmount), 0);

    // 5. Apply total-impact safety check
    //    Even if individual lines are ≤3%, if total impact > $500, escalate
    if (totalDollarImpact > RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS) {
        for (const pc of priceChanges) {
            if (pc.verdict === "auto_approve") {
                pc.verdict = "needs_approval";
                pc.reason += ` | Total PO impact $${totalDollarImpact.toFixed(2)} exceeds $${RECONCILIATION_CONFIG.TOTAL_IMPACT_CAP_DOLLARS} cap`;
            }
        }
    }

    // 6. Determine overall verdict
    const verdicts = priceChanges.map(pc => pc.verdict);
    let overallVerdict: ReconciliationVerdict = "no_change";

    if (verdicts.includes("rejected")) {
        overallVerdict = "rejected";
    } else if (verdicts.includes("needs_approval")) {
        overallVerdict = "needs_approval";
    } else if (verdicts.includes("auto_approve") || feeChanges.length > 0 || trackingUpdate) {
        overallVerdict = "auto_approve";
    }

    const autoApplicable = overallVerdict === "auto_approve" || overallVerdict === "no_change";

    // 7. Build summary
    const summary = buildReconciliationSummary(
        orderId, invoice, priceChanges, feeChanges, trackingUpdate, totalDollarImpact, overallVerdict
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

        // Run through safety checks
        const verdict = evaluatePriceChange(
            poLine.unitPrice,
            invLine.unitPrice,
            percentChange,
            dollarImpact
        );

        changes.push({
            productId: poLine.productId,
            description: invLine.description,
            poPrice: poLine.unitPrice,
            invoicePrice: invLine.unitPrice,
            quantity: invLine.qty,
            percentChange,
            dollarImpact,
            ...verdict,
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
            changes.push({
                feeType: mapping.feeType,
                amount: invoiceAmount,
                description: mapping.label,
                existingAmount,
                isNew: existingAmount === 0,
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
    approvedItems?: string[]  // productIds that were manually approved
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

    // 2. Apply fee changes (fees are always applied — they're additive)
    for (const fc of result.feeChanges) {
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

    // 3. Apply tracking updates
    if (result.trackingUpdate) {
        try {
            const poDetails = await client.getOrderDetails(result.orderId);
            const shipUrls = poDetails.shipmentUrlList || [];

            if (shipUrls.length > 0) {
                const firstShipment = shipUrls[0];
                const updates: any = {};

                if (result.trackingUpdate.trackingNumbers.length > 0) {
                    updates.trackingCode = result.trackingUpdate.trackingNumbers[0];
                }
                if (result.trackingUpdate.shipDate) {
                    updates.shipDate = result.trackingUpdate.shipDate;
                }
                if (result.trackingUpdate.carrierName) {
                    updates.privateNotes = `Carrier: ${result.trackingUpdate.carrierName}`;
                }

                await client.updateShipmentTracking(firstShipment, updates);
                applied.push(`Tracking: ${result.trackingUpdate.trackingNumbers.join(", ") || "ship date updated"}`);
            } else {
                skipped.push("Tracking: No shipment found on PO to attach tracking to");
            }
        } catch (err: any) {
            errors.push(`Tracking update failed: ${err.message}`);
        }
    }

    return { applied, skipped, errors };
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
    overallVerdict: ReconciliationVerdict
): string {
    const lines: string[] = [];

    // Header
    const emoji = overallVerdict === "auto_approve" ? "✅"
        : overallVerdict === "rejected" ? "🚨"
            : overallVerdict === "needs_approval" ? "⚠️"
                : "ℹ️";

    lines.push(`${emoji} **Invoice Reconciliation: ${invoice.invoiceNumber} → PO ${orderId}**`);
    lines.push(`Vendor: ${invoice.vendorName} | Invoice Total: $${invoice.total.toFixed(2)}`);
    lines.push("");

    // Price changes
    const meaningful = priceChanges.filter(pc => pc.verdict !== "no_change" && pc.verdict !== "no_match");
    if (meaningful.length > 0) {
        lines.push("**Price Changes:**");
        for (const pc of meaningful) {
            const icon = pc.verdict === "auto_approve" ? "✅"
                : pc.verdict === "rejected" ? "🚨"
                    : "⚠️";
            lines.push(`${icon} ${pc.productId}: $${pc.poPrice.toFixed(2)} → $${pc.invoicePrice.toFixed(2)} (${(pc.percentChange * 100).toFixed(1)}%, $${Math.abs(pc.dollarImpact).toFixed(2)} impact)`);
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

    // Fee changes
    if (feeChanges.length > 0) {
        lines.push("**Fee/Charge Updates:**");
        for (const fc of feeChanges) {
            const label = fc.isNew ? "NEW" : `was $${fc.existingAmount.toFixed(2)}`;
            lines.push(`📦 ${fc.description}: $${fc.amount.toFixed(2)} (${label})`);
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
        lines.push("⚠️ **Awaiting approval.** Some price changes exceed the 3% auto-threshold.");
    }

    return lines.join("\n");
}
