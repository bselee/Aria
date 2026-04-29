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
