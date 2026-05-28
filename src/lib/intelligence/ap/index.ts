/**
 * @file    src/lib/intelligence/ap/index.ts
 * @purpose AP pipeline module barrel — re-exports from decomposed sub-modules.
 *          Phase 1 of decomposition: extract pure logic first, rewire ap-agent.ts
 *          internals in a follow-up commit.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    ./vendor-router, ./retry-policy, ./types
 */

// ── Vendor Routing (deterministic, no LLM) ──────────────────────────────────
export {
    VENDOR_ROUTING_RULES,
    matchVendorRouting,
    type VendorRoutingRule,
} from './vendor-router';

// ── OCR Retry Policy (pure functions) ───────────────────────────────────────
export {
    countMeaningfulLineItems,
    getInvoiceLineSubtotal,
    hasCoreReconciliationSignals,
    getInvoiceParseScore,
    getOCRRetryReasons,
    evaluateOCRRetry,
} from './retry-policy';

// ── Shared Types ────────────────────────────────────────────────────────────
export {
    EMAIL_CLASSIFICATION,
    INVOICE_SOURCE,
    type EmailClassification,
    type InvoiceSource,
    type ReconciliationIdentity,
    type OCRRetryDecision,
} from './types';
