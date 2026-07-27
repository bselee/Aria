/**
 * @file    src/lib/purchasing/multi-delivery-match.ts
 * @purpose Pure functions for multi-delivery vendor matching — remaining-balance
 *          PO candidate detection for vendors that ship in partial deliveries
 *          (Miles, Thrive, Rootwise) where each invoice covers only part of
 *          a single PO.
 *
 *          Integration hook for invoice-po-matcher sibling:
 *          Import `suggestMultiDeliveryMatch` and call it during auto-match
 *          when the primary matcher returns no unique PO. If it returns a PO,
 *          use it as the matched PO and flag the match as `multiDelivery: true`
 *          so the reconciler skips shipping-charge checks.
 *
 * @author  Hermia
 * @created 2026-07-27
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpenPO {
  poNumber: string;
  vendorName: string;
  total: number;              // PO total (full order value)
  invoiceDate?: string | null;
}

export interface AssignedInvoice {
  poNumber: string;
  status: string;             // "approved", "rejected", etc.
  total: number;
}

export interface RemainingBalanceCandidate {
  poNumber: string;
  vendorName: string;
  poTotal: number;
  remainingBalance: number;
  invoiceTotal: number;
  score: number;              // 0–100: how good the fit is
  invoiceDate?: string | null;
}

// ── Multi-delivery vendor detection ──────────────────────────────────────────

/**
 * Normalize a vendor name for comparison: lowercase, trim, collapse whitespace.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vendor names that ship multi-delivery (partial fulfillment over time). */
const MULTI_DELIVERY_VENDORS = ["miles", "filippelli", "thrive", "rootwise"];

/**
 * Check whether a vendor is known to ship multi-delivery (partial invoices
 * against a single PO over time).
 */
export function isMultiDeliveryVendor(name: string): boolean {
  const n = normalize(name);
  return MULTI_DELIVERY_VENDORS.some(
    (v) => n === v || n.startsWith(v + " ") || n.includes(v)
  );
}

/**
 * Whether freight/shipping charges are expected on invoices from this vendor.
 * Miles/Thrive never charge shipping; Rootwise uses our FedEx pickup.
 */
export function freightExpected(name: string): boolean {
  // These three vendors never have shipping charges on their invoices
  return !isMultiDeliveryVendor(name);
}

// ── Remaining balance matching ───────────────────────────────────────────────

/**
 * Calculate the remaining (un-invoiced) balance on a PO given its assigned
 * invoices so far. Returns the PO total minus the sum of all non-rejected
 * invoice amounts assigned to it.
 */
export function calcRemainingBalance(
  poTotal: number,
  assignedInvoices: AssignedInvoice[]
): number {
  const invoiced = assignedInvoices
    .filter((inv) => inv.status !== "rejected" && inv.status !== "disregarded")
    .reduce((sum, inv) => sum + Number(inv.total || 0), 0);
  return Math.max(0, poTotal - invoiced);
}

/**
 * Find open POs where this invoice could be a partial match — same vendor,
 * remaining balance >= invoice total, within a 60-day date window.
 *
 * @param invoice       The unmatched invoice being considered.
 * @param openPOs       Open POs from the purchasing system.
 * @param assignedInvoices  Invoices already assigned to each PO (keyed by poNumber).
 * @returns             Candidates sorted by score descending (best first).
 */
export function findRemainingBalanceCandidates(
  invoice: { vendorName: string; total: number; invoiceDate?: string | null },
  openPOs: OpenPO[],
  assignedByPO: Record<string, AssignedInvoice[]>
): RemainingBalanceCandidate[] {
  const invVendor = normalize(invoice.vendorName);
  const invTotal = Number(invoice.total || 0);

  if (invTotal <= 0) return [];

  const candidates: RemainingBalanceCandidate[] = [];

  for (const po of openPOs) {
    const poVendor = normalize(po.vendorName);
    // Vendor must match
    if (poVendor !== invVendor) continue;

    const assigned = assignedByPO[po.poNumber] || [];
    const remaining = calcRemainingBalance(po.total, assigned);

    // Must have enough remaining balance
    if (remaining < invTotal) continue;

    // Date window: if both dates exist, must be within 60 days
    if (invoice.invoiceDate && po.invoiceDate) {
      const invDate = new Date(invoice.invoiceDate + "T00:00:00");
      const poDate = new Date(po.invoiceDate + "T00:00:00");
      const diffDays = Math.abs(
        (invDate.getTime() - poDate.getTime()) / 86_400_000
      );
      if (diffDays > 60) continue;
    }

    // Score: how well the invoice fits in the remaining balance.
    // Higher is better — close-to-remaining means it's likely the final invoice.
    const utilization = invTotal / remaining;
    // Perfect utilization = 100, over 0.8 = good, under 0.2 = weak
    const fitScore = Math.round(Math.min(100, utilization * 100));

    candidates.push({
      poNumber: po.poNumber,
      vendorName: po.vendorName,
      poTotal: po.total,
      remainingBalance: remaining,
      invoiceTotal: invTotal,
      score: fitScore,
      invoiceDate: po.invoiceDate,
    });
  }

  // Sort descending by score, then by remainingBalance ascending (prefer
  // tighter fits when scores are equal)
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.remainingBalance - b.remainingBalance;
  });

  return candidates;
}

/**
 * Suggest the best multi-delivery match for an invoice, returning null when
 * no unique, confident candidate exists.
 *
 * Strategy: if exactly one PO has enough remaining balance AND it's within
 * date window, return it. Otherwise null (multi-vendor ambiguity or no fit).
 */
export function suggestMultiDeliveryMatch(
  invoice: { vendorName: string; total: number; invoiceDate?: string | null },
  openPOs: OpenPO[],
  assignedByPO: Record<string, AssignedInvoice[]>
): RemainingBalanceCandidate | null {
  const candidates = findRemainingBalanceCandidates(invoice, openPOs, assignedByPO);

  // Must have at least one candidate
  if (candidates.length === 0) return null;

  // Unique best: the top candidate must have score > 0 and the second-best
  // must be at least 20 points lower (avoid ambiguity)
  if (candidates.length === 1) {
    return candidates[0].score > 0 ? candidates[0] : null;
  }

  // Two or more: require a clear leader
  if (candidates[0].score - candidates[1].score >= 20) {
    return candidates[0];
  }

  // Ambiguous — multiple POs could fit
  return null;
}

/**
 * Integration hook comment for auto-match-unmatched sibling:
 *
 * In auto-match-unmatched.ts (or wherever the auto-match loop lives),
 * import { isMultiDeliveryVendor, suggestMultiDeliveryMatch } and call
 * them as a fallback when the primary scorer returns no result. Example:
 *
 * ```typescript
 * // In auto-match loop, after primary scoring fails:
 * if (isMultiDeliveryVendor(invoice.vendorName)) {
 *   const match = suggestMultiDeliveryMatch(invoice, openPOs, assignedByPO);
 *   if (match) {
 *     // Assign poNumber = match.poNumber with multiDelivery: true
 *     // Skip shipping-charge checking during reconciliation
 *   }
 * }
 * ```
 */
