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
import {
    normalizeVendorName,
    resolveCanonicalVendor,
    loadVendorAliases,
} from "@/lib/purchasing/vendor-name-normalize";
import { sanitizeOcrPoCandidate } from "@/lib/purchasing/ocr-po-sanitize";

export { sanitizeOcrPoCandidate };

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
    /** Raw OCR-extracted PO number candidate from invoice PDF/email data.
     *  Sanitized by sanitizeOcrPoCandidate for exact-match lookup. */
    ocrPoCandidate?: string | null;
    /** Raw OCR-extracted order reference (alternative PO source, e.g. "orderRef" or "orderNumber"). */
    ocrOrderCandidate?: string | null;
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
    const al = normalizeVendorName(a);
    const bl = normalizeVendorName(b);
    if (!al || !bl) return { score: 0, reason: "vendor name missing" };
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

    // Load vendor aliases and resolve the invoice vendor name to a canonical
    // Finale supplier name. This bridges OCR-vs-Finale name mismatches.
    const aliases = await loadVendorAliases();
    const canonicalName = resolveCanonicalVendor(invoice.vendorName, aliases);

    // ── Load confirmed PO matches ──────────────────────────────────────────
    // Read the full confirmed_po_matches table and index by vendor_name →
    // Set<po_number>. A human-approved vendor+po pair gets a 95-point boost
    // (enough to auto-apply) with a descriptive reason.
    // This is the "fine-tuning" mechanism: when Bill approves a match, the
    // matcher learns and future invoices from the same vendor matching the
    // same PO auto-resolve.
    const confirmedMatchMap = new Map<string, Set<string>>();
    try {
        const { data: confirmedMatches } = await db
            .from("confirmed_po_matches")
            .select("vendor_name, po_number");
        for (const cm of (confirmedMatches || []) as any[]) {
            const vn = (cm.vendor_name || "").toLowerCase().trim();
            if (!vn) continue;
            if (!confirmedMatchMap.has(vn)) {
                confirmedMatchMap.set(vn, new Set());
            }
            confirmedMatchMap.get(vn)!.add((cm.po_number || "").trim());
        }
    } catch {
        // Non-blocking — confirmed matches are an optimization
        console.warn("[invoice-po-matcher] Failed to load confirmed_po_matches");
    }

    // Collect all alias values that map to this canonical vendor. These can be
    // used as ilike search targets — the alias text (e.g. "AutoPot Watering
    // Systems USA") may be a superset of the PO vendor name ("Autopot Watering
    // Systems") and catch matches via substring ILIKE.
    const canonicalAliasValues: string[] = canonicalName
        ? aliases
              .filter(a => a.finale_supplier_name === canonicalName)
              .map(a => a.alias)
        : [];

    const canonicalDiffers =
        canonicalName &&
        normalizeVendorName(canonicalName) !== normalizeVendorName(invoice.vendorName);

    // Build search targets for the alias-derived search: the canonical name
    // itself (if different from original) and all matching alias values.
    const aliasSearchTargets: string[] = [];
    if (canonicalDiffers) aliasSearchTargets.push(canonicalName!);
    // Also try searching by the alias value that matched (if the resolved
    // alias differs from both the canonical and the original vendor name).
    // This handles cases where the alias text is a closer match to the PO
    // name than the canonical name is.
    for (const av of canonicalAliasValues) {
        const nav = normalizeVendorName(av);
        if (nav && nav !== normalizeVendorName(invoice.vendorName) && nav !== normalizeVendorName(canonicalName!)) {
            aliasSearchTargets.push(av);
        }
    }

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

    // If the invoice vendor name resolves to a canonical name (via vendor_aliases),
    // ALSO search for POs matching the canonical name or any of its alias values.
    // This catches cases like invoice "AutoPot USA" → canonical "AutoPot USA" with
    // alias "AutoPot Watering Systems USA" that substring-matches PO vendor name
    // "Autopot Watering Systems" via ILIKE.
    let canonicalPos: any[] | null = null;
    const seenPoNumbers = new Set<string>((pos || []).map((p: any) => p.po_number));
    for (const target of aliasSearchTargets) {
        const { data: cPos } = await db
            .from("purchase_orders")
            .select("po_number, vendor_name, issue_date, total_amount, total, status")
            .ilike("vendor_name", `%${target}%`)
            .order("issue_date", { ascending: false })
            .limit(20);
        if (cPos && cPos.length > 0) {
            for (const cp of cPos) {
                if (!seenPoNumbers.has(cp.po_number)) {
                    if (!canonicalPos) canonicalPos = [];
                    canonicalPos.push(cp);
                    seenPoNumbers.add(cp.po_number);
                }
            }
        }
    }

    // If alias-derived search found new POs, dedup and merge them into the main list
    if (canonicalPos) {
        const merged = [...(pos || []), ...canonicalPos];
        merged.sort((a: any, b: any) => (b.issue_date || "").localeCompare(a.issue_date || ""));
        pos = merged;
    }

    for (const po of (pos || []) as any[]) {
        let vendorScore = scoreVendorName(invoice.vendorName, po.vendor_name || "");
        const dateScore = scoreDateProximity(invoice.invoiceDate, po.issue_date || "");
        const poTotal = Number(po.total_amount || po.total || 0);
        const amountScore = scoreAmountProximity(invoice.total, poTotal);

        // ── Alias-match detection ───────────────────────────────────────────
        // When the invoice vendor name resolves to a canonical Finale supplier
        // via vendor_aliases, check if this PO's vendor name matches that
        // canonical name (or any of its associated aliases). If so, boost the
        // vendor score to 40 (equivalent to exact match) with a descriptive
        // reason so the dashboard shows why the match was made.
        //
        // This handles cases where:
        //   Invoice: "AutoPot Watering Systems USA" (OCR)
        //   Alias:   "Autopot Watering Systems USA" → "AutoPot USA"
        //   PO:      "Autopot Watering Systems"
        //   → "alias match: AutoPot USA via Autopot Watering Systems USA"
        let aliasReason: string | null = null;
        if (canonicalName && vendorScore.score < 40) {
            const poVendorNorm = normalizeVendorName(po.vendor_name || "");
            const canonNorm = normalizeVendorName(canonicalName);

            // Exact normalized match between PO vendor name and canonical name
            if (poVendorNorm === canonNorm) {
                aliasReason = `alias match: ${invoice.vendorName} → ${canonicalName}`;
            } else {
                // Check if any alias value for this canonical vendor matches the
                // PO vendor name (normalized). The PO name may be a substring of
                // the alias (or vice versa).
                for (const av of canonicalAliasValues) {
                    const avNorm = normalizeVendorName(av);
                    if (avNorm && (avNorm === poVendorNorm || avNorm.includes(poVendorNorm) || poVendorNorm.includes(avNorm))) {
                        aliasReason = `alias match: ${invoice.vendorName} → ${canonicalName} (via ${av})`;
                        break;
                    }
                }
            }
        }

        if (aliasReason) {
            vendorScore = { score: 40, reason: aliasReason };
        }

        // ── Confirmed-match boost ──────────────────────────────────────────
        // When this vendor_name + po_number pair was previously confirmed by a
        // human (via the approve_unreconciled action), boost the total score to
        // 95. This is the fine-tuning mechanism: once Bill confirms a match,
        // future invoices from the same vendor matching the same PO auto-resolve.
        const poNumberKey = (po.po_number || "").trim();
        const vendorKey = (invoice.vendorName || "").toLowerCase().trim();
        const isConfirmedMatch = !!(
            poNumberKey &&
            vendorKey &&
            confirmedMatchMap.get(vendorKey)?.has(poNumberKey)
        );
        let confirmedMatchReason: string | null = null;
        if (isConfirmedMatch) {
            confirmedMatchReason = `previously confirmed by user (vendor=${invoice.vendorName}, PO=${poNumberKey})`;
        }

        let total = vendorScore.score + dateScore.score + amountScore.score;
        if (confirmedMatchReason) {
            total = 95;
        }

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
        if (confirmedMatchReason) {
            reasons.push(confirmedMatchReason);
        }
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
    let autoApplyReady = candidates.length === 1
        && bestMatch!.score >= AUTO_APPLY_THRESHOLD
        && invoice.total > 0;

    // Never auto-apply dropship POs — out of AP purview (Bill 2026-07-27).
    const isDropshipPo = (po: string) => /DropshipPO$/i.test(po || "");
    if (bestMatch && isDropshipPo(bestMatch.orderId)) {
        autoApplyReady = false;
    }

    // ── Tier A: Exact OCR PO match ────────────────────────────────────────
    // If the invoice carries a raw OCR PO candidate (from raw_data.poNumber,
    // orderRef, etc.), sanitize it and DIRECT-LOOKUP the PO by number first.
    // Vendor-name search can miss when OCR vendor ≠ Finale supplier name —
    // the PO number is the authoritative join. Never dropship.
    const sanitizedOcrPo = sanitizeOcrPoCandidate(invoice.ocrPoCandidate)
        || sanitizeOcrPoCandidate(invoice.ocrOrderCandidate);
    if (sanitizedOcrPo && !isDropshipPo(sanitizedOcrPo)) {
        // Prefer a candidate already in the list
        let exactMatch = candidates.find(
            c => c.orderId.toUpperCase() === sanitizedOcrPo.toUpperCase() && !isDropshipPo(c.orderId)
        );
        // If vendor search missed it, fetch by po_number directly
        if (!exactMatch) {
            try {
                const { data: byPo } = await db
                    .from("purchase_orders")
                    .select("po_number, vendor_name, issue_date, total_amount, total, status")
                    .eq("po_number", sanitizedOcrPo)
                    .limit(1);
                const row = (byPo || [])[0] as any;
                if (row && row.po_number && !isDropshipPo(String(row.po_number))) {
                    const poTotal = Number(row.total_amount || row.total || 0);
                    exactMatch = {
                        orderId: String(row.po_number),
                        vendorName: row.vendor_name || "",
                        orderDate: row.issue_date || "",
                        total: poTotal,
                        status: row.status || "unknown",
                        score: 100,
                        reasons: [`exact OCR PO match: ${sanitizedOcrPo}`, "direct po_number lookup"],
                        isOpen: ["open", "partial", "committed", "locked"].includes(
                            String(row.status || "").toLowerCase()
                        ),
                    };
                    candidates.push(exactMatch);
                }
            } catch (e: any) {
                console.warn(`[invoice-po-matcher] OCR direct PO lookup failed: ${e?.message || e}`);
            }
        }
        if (exactMatch) {
            exactMatch.score = 100;
            if (!exactMatch.reasons.some((r) => r.includes("exact OCR PO match"))) {
                exactMatch.reasons.push(`exact OCR PO match: ${sanitizedOcrPo}`);
            }
            candidates.sort((a, b) => b.score - a.score);
            autoApplyReady = candidates[0] === exactMatch && invoice.total > 0 && !isDropshipPo(exactMatch.orderId);
        }
    }

    // ── Tier A: Unique vendor + amount ±2% + date ±14d ────────────────────
    // When only one candidate meets all three tight criteria, it's high-
    // confidence even if the base score is below threshold.
    if (!autoApplyReady && candidates.length > 0 && invoice.total > 0) {
        const tightCandidates = candidates.filter(c => {
            if (isDropshipPo(c.orderId)) return false;
            // Vendor score >= 30 (exact, substring, or alias match)
            const vScore = scoreVendorName(invoice.vendorName, c.vendorName);
            if (vScore.score < 30) return false;

            // Amount variance <= 2%
            if (c.total <= 0) return false;
            const amtPct = Math.abs(invoice.total - c.total) / c.total;
            if (amtPct > 0.02) return false;

            // Date within 14 days
            const normDate = (s: string) => (s || "").slice(0, 10);
            const invTs = new Date(normDate(invoice.invoiceDate) + "T12:00:00Z").getTime();
            const poTs = new Date(normDate(c.orderDate) + "T12:00:00Z").getTime();
            if (isNaN(invTs) || isNaN(poTs)) return false;
            const days = Math.abs((invTs - poTs) / 86_400_000);
            if (days > 14) return false;

            return true;
        });

        if (tightCandidates.length === 1) {
            tightCandidates[0].score = Math.max(tightCandidates[0].score, 90);
            tightCandidates[0].reasons.push(
                "unique vendor+amount±2%+date±14d"
            );
            candidates.sort((a, b) => b.score - a.score);
            autoApplyReady = !isDropshipPo(tightCandidates[0].orderId);
        }
    }

    // Final guard: never auto-apply a dropship PO
    if (autoApplyReady && candidates[0] && isDropshipPo(candidates[0].orderId)) {
        autoApplyReady = false;
    }

    return { invoice, candidates, bestMatch: candidates[0] || null, autoApplyReady };
}

// ── Tier A: High-confidence auto-match (pure function) ──────────────────────

/**
 * Post-process a set of scored candidates and determine if a high-confidence
 * auto-match is available. This is the pure-function counterpart to the
 * Tier A logic embedded in findPOCandidates — useful for batch runners that
 * want to separate candidate search from match decision.
 *
 * Returns a simplified match decision (or null) without mutating inputs.
 */
export interface HighConfidenceDecision {
    poNumber: string;
    score: number;
    reason: string;
    tier: "exact_ocr" | "unique_vendor_amount_date";
}

export function tryHighConfidenceAutoMatch(
    invoice: InvoiceToMatch,
    candidates: POCandidate[],
): HighConfidenceDecision | null {
    if (candidates.length === 0 || invoice.total <= 0) return null;
    const isDropshipPo = (po: string) => /DropshipPO$/i.test(po || "");

    // Tier A-1: Exact OCR PO match (never dropship)
    const sanitizedOcrPo = sanitizeOcrPoCandidate(invoice.ocrPoCandidate)
        || sanitizeOcrPoCandidate(invoice.ocrOrderCandidate);
    if (sanitizedOcrPo && !isDropshipPo(sanitizedOcrPo)) {
        const exactMatch = candidates.find(
            c => c.orderId.toUpperCase() === sanitizedOcrPo.toUpperCase() && !isDropshipPo(c.orderId)
        );
        if (exactMatch) {
            return {
                poNumber: exactMatch.orderId,
                score: 100,
                reason: `exact OCR PO match: ${sanitizedOcrPo}`,
                tier: "exact_ocr",
            };
        }
    }

    // Tier A-2: Unique vendor + amount ±2% + date ±14d (exclude dropship)
    const tightCandidates = candidates.filter(c => {
        if (isDropshipPo(c.orderId)) return false;
        const vScore = scoreVendorName(invoice.vendorName, c.vendorName);
        if (vScore.score < 30) return false;
        if (c.total <= 0) return false;
        const amtPct = Math.abs(invoice.total - c.total) / c.total;
        if (amtPct > 0.02) return false;
        const normDate = (s: string) => (s || "").slice(0, 10);
        const invTs = new Date(normDate(invoice.invoiceDate) + "T12:00:00Z").getTime();
        const poTs = new Date(normDate(c.orderDate) + "T12:00:00Z").getTime();
        if (isNaN(invTs) || isNaN(poTs)) return false;
        const days = Math.abs((invTs - poTs) / 86_400_000);
        return days <= 14;
    });

    if (tightCandidates.length === 1) {
        return {
            poNumber: tightCandidates[0].orderId,
            score: Math.max(tightCandidates[0].score, 90),
            reason: "unique vendor+amount±2%+date±14d",
            tier: "unique_vendor_amount_date",
        };
    }

    return null;
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
            ocrPoCandidate: inv.raw_data?.poNumber || null,
            ocrOrderCandidate: inv.raw_data?.orderRef || inv.raw_data?.orderNumber || null,
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
