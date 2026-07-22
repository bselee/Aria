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
        .select("id, vendor_name, invoice_number, invoice_date, subtotal, freight, tax, total")
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

            // Push freight to Finale PO — the database has the correlation,
            // so use it. Freight on the invoice IS the PO's freight.
            const invFreight = Number(inv.freight || 0);
            if (invFreight > 0) {
                try {
                    const finale = new FinaleClient();
                    await finale.updateOrderAdjustmentAmount(
                        result.bestMatch.orderId,
                        'FREIGHT',
                        invFreight,
                        `Freight from invoice ${inv.invoice_number}`,
                    );
                    console.log(
                        `[invoice-matcher] Freight $${invFreight.toFixed(2)} applied to PO ${result.bestMatch.orderId}`,
                    );
                } catch (freightErr: any) {
                    console.warn(
                        `[invoice-matcher] Freight push failed for PO ${result.bestMatch.orderId}: ${freightErr.message}`,
                    );
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
