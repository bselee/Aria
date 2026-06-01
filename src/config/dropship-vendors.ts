/**
 * @file    src/config/dropship-vendors.ts
 * @purpose Backward-compatible re-export of the dropship vendor list.
 *          SOURCE OF TRUTH has moved to src/config/invoice-classification.ts.
 *
 *          The KNOWN_DROPSHIP_KEYWORDS constant is preserved here for backward
 *          compatibility, but NEW code should import `classifyInvoice` or
 *          `isDropshipFlowThrough` directly from `@/config/invoice-classification`.
 *
 * @deprecated Import from @/config/invoice-classification instead.
 * @author  Aria
 * @created 2026-02-27
 * @updated 2026-06-01 — Now delegates to the unified invoice-classification module.
 */

/**
 * Legacy keyword list — kept for backward compat.
 * New code: use classifyInvoice() from @/config/invoice-classification.
 */
export const KNOWN_DROPSHIP_KEYWORDS = [
    "autopot",
    "logan labs",
    "loganlab",
    "evergreen growers",
    "evergreengrow",
    "abel",
    "abelsace",
];