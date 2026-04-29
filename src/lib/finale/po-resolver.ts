/**
 * @file    po-resolver.ts
 * @purpose Shared Finale PO resolver. Both the AP-pipeline (ap-agent.ts)
 *          and the paid-invoice worker (default-inbox-invoice.ts) need to
 *          turn a printed PO reference (from email subject / OCR / haiku
 *          extraction) into the actual Finale order ID. Vendors print
 *          their own reference numbers, parenthesized formats, transposed
 *          digits, and sometimes multiple candidates in one document.
 *
 *          Resolution strategy (in order):
 *            1. Try the raw token as printed.
 *            2. Try Finale's parenthesized prefix format ("B123402" → "B(123402)").
 *            3. Try digits-only ("B123402" → "123402") + parens-only ("(123402)").
 *            4. Try every adjacent-digit-swap variant (123402 → 213402, 132402, …)
 *               — OCR commonly transposes adjacent digit pairs.
 *            5. If multiple valid candidates resolve, disambiguate by
 *               counting how many invoice-vendor-name words appear in
 *               each candidate's Finale supplier name.
 *            6. If nothing resolves, return null so the caller can fall
 *               back to vendor + date matching or alert.
 *
 *          The function is best-effort: a Finale lookup failure for one
 *          candidate is silently skipped (it just isn't a valid match);
 *          only a hard exception surfaces.
 */

import { FinaleClient } from "./client";

export type PoResolutionResult = {
    /** The resolved Finale order ID. Null when nothing matches. */
    orderId: string | null;
    /** All variant tokens we probed (useful for logging / debug). */
    triedCandidates: string[];
    /** Multi-candidate count — when > 1 we disambiguated by vendor. */
    validCandidatesCount: number;
    /** Human-readable note about how the match was made (or why it failed). */
    note: string;
};

/**
 * Build the variant set for a printed PO token. Order matters: more
 * specific (raw, parens, digits-only) come before transposed swaps so
 * the natural "as printed" hit wins disambiguation ties.
 */
export function buildPoCandidates(printedPo: string): string[] {
    const tokens = printedPo.includes(" ")
        ? printedPo.split(/\s+/).filter(Boolean)
        : [printedPo];

    const out: string[] = [];
    const seen = new Set<string>();
    const push = (s: string) => { if (s && !seen.has(s)) { seen.add(s); out.push(s); } };

    for (const t of tokens) {
        push(t);
        // Finale's "B(NNNN)" parenthesized format — only meaningful for letter-prefixed tokens.
        const withParens = t.replace(/^([A-Za-z]+)(\d+)$/, "$1($2)");
        if (withParens !== t) push(withParens);
        // Digits-only stripped of letter prefix.
        const digitsOnly = t.replace(/^[A-Za-z]+/, "");
        if (digitsOnly && digitsOnly !== t) {
            push(digitsOnly);
            push(`(${digitsOnly})`);
        }
        // Adjacent-digit transposition variants — applies to ANY digit-bearing
        // token (with or without letter prefix). Pure-digit tokens like "123402"
        // need swap recovery just as much as "B123402".
        const swapBase = digitsOnly || t.replace(/\D/g, "");
        if (swapBase.length > 1 && /^\d+$/.test(swapBase)) {
            for (let i = 0; i < swapBase.length - 1; i++) {
                const arr = swapBase.split("");
                [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
                const swapped = arr.join("");
                if (swapped !== swapBase) push(swapped);
            }
        }
    }
    return out;
}

/**
 * Resolve a printed PO reference to a real Finale order ID.
 *
 * @param printedPo  Whatever the caller extracted (regex, OCR, Haiku).
 * @param vendorHint Optional vendor name from the invoice — used to
 *                   disambiguate when multiple candidates resolve.
 * @param client     Optional pre-built FinaleClient. If omitted, a fresh
 *                   one is constructed (each call is cheap — auth is
 *                   per-request token).
 */
export async function resolveFinalePo(
    printedPo: string,
    vendorHint: string | null = null,
    client?: FinaleClient,
): Promise<PoResolutionResult> {
    const finale = client ?? new FinaleClient();
    const candidates = buildPoCandidates(printedPo);

    // Probe each candidate. Use getOrderDetails (full fetch) — same as
    // ap-agent for parity. Errors mean "not found" and are skipped.
    const valid: string[] = [];
    for (const candidate of candidates) {
        try {
            await finale.getOrderDetails(candidate);
            valid.push(candidate);
        } catch {
            /* not found — try next */
        }
    }

    if (valid.length === 0) {
        return {
            orderId: null,
            triedCandidates: candidates,
            validCandidatesCount: 0,
            note: `No Finale PO matched any of ${candidates.length} candidate variants for "${printedPo}"`,
        };
    }

    if (valid.length === 1) {
        const orderId = valid[0];
        return {
            orderId,
            triedCandidates: candidates,
            validCandidatesCount: 1,
            note: orderId === printedPo
                ? `Exact match: ${orderId}`
                : `Resolved "${printedPo}" → ${orderId}`,
        };
    }

    // Multiple matches — disambiguate by vendor name overlap.
    const vendorWords = (vendorHint ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

    let bestCandidate = valid[0];
    let bestScore = -1;
    for (const candidate of valid) {
        try {
            const summary = await finale.getOrderSummary(candidate);
            if (!summary) continue;
            const supplierLower = (summary.supplier ?? "").toLowerCase();
            const score = vendorWords.filter(w => supplierLower.includes(w)).length;
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        } catch {
            /* skip — keep current best */
        }
    }

    return {
        orderId: bestCandidate,
        triedCandidates: candidates,
        validCandidatesCount: valid.length,
        note: vendorHint
            ? `${valid.length} candidates resolved; disambiguated by vendor "${vendorHint}" → ${bestCandidate} (score ${bestScore})`
            : `${valid.length} candidates resolved; no vendor hint, picked first → ${bestCandidate}`,
    };
}

// ── Multi-strategy correlation (when printed PO doesn't resolve) ─────────────
//
// Will's directive: for vendors like Axiom, Riceland, etc., when the
// printed PO# doesn't match Finale, the most recent OPEN PO from that
// vendor is almost always the right correlation. Add SKU overlap and
// amount proximity as tie-breakers; if NOTHING correlates, the caller
// should consider creating a draft PO from the invoice line items.

export type CorrelationStrategy =
    | "exact"           // resolveFinalePo found a direct match
    | "vendor-recent"   // most recent vendor PO (no other signal available)
    | "sku-overlap"     // most SKU overlap with invoice line items
    | "amount-proximity"// invoice total ≈ PO total within tolerance
    | "create-draft";   // nothing correlated — create a new draft PO

export type Confidence = "high" | "medium" | "low";

export type CorrelationResult = {
    orderId: string | null;
    strategy: CorrelationStrategy | null;
    confidence: Confidence;
    note: string;
    /** When non-null, the matched PO row from listRecentPosByVendor. */
    candidate?: {
        orderId: string;
        status: string;
        orderDate: string;
        supplierName: string;
        total: number;
        skus: string[];
    };
};

export type CorrelateInput = {
    /** Printed PO# from email subject / OCR / extractor. May be null. */
    printedPo?: string | null;
    /** Vendor name from the invoice — required for fallback strategies. */
    vendorName: string;
    /** Extracted line items, used for SKU overlap. */
    lineItems?: Array<{ sku?: string | null; total?: number | null }>;
    /** Invoice total (after freight + tax). Used for amount proximity. */
    invoiceTotal?: number;
    /** Invoice freight separately — let amount-proximity use subtotal. */
    invoiceFreight?: number;
    /** Optional pre-built FinaleClient (test injection). */
    client?: FinaleClient;
    /** Days back to look for recent vendor POs (default 60). */
    daysBack?: number;
};

/**
 * Run the multi-strategy correlation pipeline. Returns the best match
 * with its strategy + confidence, or `{orderId: null, strategy: 'create-draft'}`
 * when nothing correlates. Caller decides whether to actually create the
 * draft (it usually wants Will to confirm first).
 */
export async function correlatePo(input: CorrelateInput): Promise<CorrelationResult> {
    const finale = input.client ?? new FinaleClient();
    const daysBack = input.daysBack ?? 60;

    // Strategy 1: exact / variant match on the printed PO.
    if (input.printedPo) {
        const r = await resolveFinalePo(input.printedPo, input.vendorName, finale);
        if (r.orderId) {
            return {
                orderId: r.orderId,
                strategy: "exact",
                confidence: r.validCandidatesCount === 1 ? "high" : "medium",
                note: r.note,
            };
        }
    }

    // Strategies 2-4: pull recent vendor POs, then rank.
    const recentPos = await finale.listRecentPosByVendor(input.vendorName, { daysBack });

    if (recentPos.length === 0) {
        return {
            orderId: null,
            strategy: "create-draft",
            confidence: "low",
            note: `No recent POs (${daysBack}d) for vendor "${input.vendorName}"; consider creating a draft from invoice line items.`,
        };
    }

    // Pre-extract invoice SKUs (lower-cased) for overlap counting.
    const invoiceSkus = new Set(
        (input.lineItems ?? [])
            .map(li => (li.sku ?? "").toLowerCase())
            .filter(Boolean),
    );

    // Score each PO: skuOverlap (per-SKU match), amountDelta (abs diff).
    const subtotal = (input.invoiceTotal ?? 0) - (input.invoiceFreight ?? 0);

    type Scored = typeof recentPos[number] & { skuOverlap: number; amountDelta: number; daysAgo: number };
    const scored: Scored[] = recentPos.map(po => {
        const skuOverlap = invoiceSkus.size > 0
            ? po.skus.filter(s => invoiceSkus.has(s.toLowerCase())).length
            : 0;
        const amountDelta = subtotal > 0 && po.total > 0 ? Math.abs(po.total - subtotal) : Infinity;
        const orderDate = po.orderDate ? new Date(po.orderDate).getTime() : 0;
        const daysAgo = orderDate ? (Date.now() - orderDate) / 86400000 : 999;
        return { ...po, skuOverlap, amountDelta, daysAgo };
    });

    // Strategy 2: SKU overlap (preferred when we have invoice line items).
    if (invoiceSkus.size > 0) {
        const bestSku = scored.slice().sort((a, b) => b.skuOverlap - a.skuOverlap || a.daysAgo - b.daysAgo)[0];
        if (bestSku && bestSku.skuOverlap > 0) {
            return {
                orderId: bestSku.orderId,
                strategy: "sku-overlap",
                confidence: bestSku.skuOverlap >= 3 ? "high" : bestSku.skuOverlap >= 1 ? "medium" : "low",
                note: `Vendor "${input.vendorName}" recent PO ${bestSku.orderId} matches ${bestSku.skuOverlap}/${invoiceSkus.size} invoice SKUs (${bestSku.daysAgo.toFixed(0)}d ago).`,
                candidate: bestSku,
            };
        }
    }

    // Strategy 3: amount proximity (within 5% or $50, whichever larger).
    if (subtotal > 0) {
        const tolerance = Math.max(subtotal * 0.05, 50);
        const bestAmount = scored.slice().sort((a, b) => a.amountDelta - b.amountDelta)[0];
        if (bestAmount && bestAmount.amountDelta <= tolerance) {
            return {
                orderId: bestAmount.orderId,
                strategy: "amount-proximity",
                confidence: bestAmount.amountDelta <= tolerance / 2 ? "high" : "medium",
                note: `Vendor "${input.vendorName}" recent PO ${bestAmount.orderId} total $${bestAmount.total.toFixed(2)} ≈ invoice subtotal $${subtotal.toFixed(2)} (Δ $${bestAmount.amountDelta.toFixed(2)}).`,
                candidate: bestAmount,
            };
        }
    }

    // Strategy 4: most recent vendor PO (Will's primary heuristic).
    const mostRecent = scored.slice().sort((a, b) => a.daysAgo - b.daysAgo)[0];
    if (mostRecent) {
        return {
            orderId: mostRecent.orderId,
            strategy: "vendor-recent",
            confidence: scored.length === 1 ? "medium" : "low",
            note: scored.length === 1
                ? `Single recent PO for vendor "${input.vendorName}": ${mostRecent.orderId} (${mostRecent.daysAgo.toFixed(0)}d ago).`
                : `Most recent of ${scored.length} POs for vendor "${input.vendorName}": ${mostRecent.orderId} (${mostRecent.daysAgo.toFixed(0)}d ago) — no SKU/amount signal to disambiguate.`,
            candidate: mostRecent,
        };
    }

    return {
        orderId: null,
        strategy: "create-draft",
        confidence: "low",
        note: `Nothing correlated; consider creating a draft for "${input.vendorName}".`,
    };
}
