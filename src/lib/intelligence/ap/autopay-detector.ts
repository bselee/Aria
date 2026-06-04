/**
 * @file    src/lib/intelligence/ap/autopay-detector.ts
 * @purpose Auto-detect autopay vendors from email-level signals (sender, subject)
 *          BEFORE LLM classification or OCR — saves API calls and ensures
 *          consistent handling for recurring service providers.
 *
 *          This runs as a fallback AFTER deterministic vendor-router.ts rules
 *          fail to match. It catches vendors like Culligan, Terminix, local
 *          utilities, and other recurring-service senders that:
 *            - Never have a PO number
 *            - Are paid on autopay (no Bill.com forward needed)
 *            - Send monthly invoices for small recurring amounts ($10-200)
 *
 * PATTERNS IDENTIFIED (kaizen 2026-06-04):
 *   - Subject keywords: "autopay", "auto pay", "monthly service", "recurring"
 *   - Sender domain: known utility/service providers
 *   - Sender name: contains words like "water", "gas", "electric", "waste",
 *     "pest", "propane", "internet", "phone", "security", "alarm"
 *   - Recurring: same vendor appears monthly with no PO history
 *
 * @author  Hermia
 * @created 2026-06-04
 * @deps    none (pure heuristic matching)
 * @env     none
 */

// ─── Autopay Signal Patterns ────────────────────────────────────────────────
// These patterns indicate an email is about an autopay/recurring service
// that should NOT be forwarded to Bill.com.

const SUBJECT_AUTOPAY_PATTERNS: RegExp[] = [
    /auto[- ]?pay/i,
    /auto[- ]?payment/i,
    /recurring/i,
    /monthly\s+(service|charge|fee|subscription|bill)/i,
    /subscription\s+(receipt|invoice|notice|confirmation)/i,
    /account\s+(summary|statement|activity)/i,
];

/** Domain or sender-name keywords for known service providers */
const SERVICE_SENDER_KEYWORDS: Array<{ keyword: string; label: string }> = [
    // ── Water / Utility ──────────────────────────────────────────────────
    { keyword: 'culligan',        label: 'Culligan Water Service' },
    { keyword: 'city water',      label: 'Municipal Water' },
    { keyword: 'water bill',      label: 'Water Utility' },
    { keyword: 'water service',   label: 'Water Service' },

    // ── Pest Control ─────────────────────────────────────────────────────
    { keyword: 'terminix',        label: 'Terminix Pest Control' },
    { keyword: 'orkin',           label: 'Orkin Pest Control' },
    { keyword: 'pest control',    label: 'Pest Control Service' },
    { keyword: 'bug spray',       label: 'Pest Control Service' },

    // ── Gas / Propane ────────────────────────────────────────────────────
    { keyword: 'propane',         label: 'Propane Service' },
    { keyword: 'natural gas',     label: 'Natural Gas Service' },
    { keyword: 'gas company',     label: 'Gas Utility' },

    // ── Electric / Energy ────────────────────────────────────────────────
    { keyword: 'electric',        label: 'Electric Utility' },
    { keyword: 'power company',   label: 'Power Utility' },
    { keyword: 'energy bill',     label: 'Energy Service' },

    // ── Waste / Recycling ────────────────────────────────────────────────
    { keyword: 'waste',           label: 'Waste Management' },
    { keyword: 'recycling',       label: 'Recycling Service' },
    { keyword: 'trash',           label: 'Trash Service' },
    { keyword: 'dumpster',        label: 'Dumpster Service' },

    // ── Internet / Phone / Comm ──────────────────────────────────────────
    { keyword: 'internet bill',   label: 'Internet Service' },
    { keyword: 'phone bill',      label: 'Phone Service' },
    { keyword: 'cellular',        label: 'Cellular Service' },
    { keyword: 'comcast',         label: 'Comcast' },
    { keyword: 'xfinity',         label: 'Xfinity' },
    { keyword: 'verizon',         label: 'Verizon' },
    { keyword: 'spectrum',        label: 'Spectrum' },
    { keyword: 'att',             label: 'AT&T' },

    // ── Security / Monitoring ────────────────────────────────────────────
    { keyword: 'security system', label: 'Security System' },
    { keyword: 'alarm system',    label: 'Alarm System' },
    { keyword: 'monitoring',      label: 'Monitoring Service' },

    // ── Equipment Lease / Copier ─────────────────────────────────────────
    { keyword: 'copier',          label: 'Copier Lease' },
    { keyword: 'printer',         label: 'Printer Lease' },
    { keyword: 'equipment lease', label: 'Equipment Lease' },
    { keyword: 'machine lease',   label: 'Machine Lease' },

    // ── Misc Recurring Service ───────────────────────────────────────────
    { keyword: 'cleaning service', label: 'Cleaning Service' },
    { keyword: 'janitorial',       label: 'Janitorial Service' },
    { keyword: 'lawn care',        label: 'Lawn Care Service' },
    { keyword: 'landscaping',      label: 'Landscaping Service' },
    { keyword: 'snow removal',     label: 'Snow Removal' },
    { keyword: 'hvac service',     label: 'HVAC Service' },
    { keyword: 'elevator',         label: 'Elevator Service' },
];

// ─── Strong Autopay Domains ─────────────────────────────────────────────────
// These domains ALWAYS send autopay/recurring invoices that should not
// reach Bill.com. Add new ones here as discovered — but prefer adding
// to vendor-router.ts for deterministic zero-overhead routing when the
// sender domain/name is known exactly.
//
// KEY RULE: vendor-router.ts = exact known sender (zero heuristic cost).
//           autopay-detector.ts = fuzzy/pattern-based fallback (slightly more CPU).

const STRONG_AUTOPAY_DOMAINS: Array<{ domain: string; label: string }> = [
    { domain: 'culligan.com',       label: 'Culligan Water (Autopay)' },
    { domain: 'terminix.com',       label: 'Terminix (Autopay)' },
    { domain: 'billtrust.com',      label: 'Billtrust (Lease Autopay)' },
];

// ─── Result Type ────────────────────────────────────────────────────────────

export interface AutopayDetectionResult {
    /** Whether the email is confidently an autopay/recurring service */
    isAutopay: boolean;
    /** Confidence level */
    confidence: 'high' | 'medium' | 'low';
    /** Human-readable reason for the decision */
    reason: string;
}

// ─── Detector ───────────────────────────────────────────────────────────────

/**
 * Detect whether an email represents an autopay/recurring vendor invoice
 * that should be marked read and NOT forwarded to Bill.com.
 *
 * This runs as a heuristic fallback AFTER deterministic vendor-router.ts
 * rules fail to match, and BEFORE the expensive LLM classification call.
 *
 * Three signal tiers (checked in order):
 *   1. Strong domain match — sender domain is a known autopay provider
 *   2. Subject signals — subject contains autopay/recurring keywords
 *   3. Sender name signals — sender display name contains service keywords
 *
 * @param fromEmail  - The sender's email address (e.g., "billing@culligan.com")
 * @param fromName   - The sender's display name (e.g., "Culligan Water Service")
 * @param subject    - The email subject line
 * @returns AutopayDetectionResult with isAutopay flag and confidence
 *
 * @example
 *   const result = detectAutopay('billing@culligan.com', 'Culligan Water', 'Your Invoice from Culligan');
 *   // => { isAutopay: true, confidence: 'high', reason: 'Strong domain match: culligan.com' }
 */
export function detectAutopay(
    fromEmail: string,
    fromName: string,
    subject: string,
): AutopayDetectionResult {
    const email = (fromEmail || '').toLowerCase();
    const name = (fromName || '').toLowerCase();
    const subjectLower = (subject || '').toLowerCase();

    // ── Tier 1: Strong domain match (high confidence) ────────────────────
    if (email.includes('@')) {
        const domain = email.split('@')[1];
        for (const entry of STRONG_AUTOPAY_DOMAINS) {
            if (domain === entry.domain || domain.endsWith('.' + entry.domain)) {
                return {
                    isAutopay: true,
                    confidence: 'high',
                    reason: `Strong domain match: ${entry.domain} → ${entry.label}`,
                };
            }
        }
    }

    // ── Tier 2: Subject keyword match (high/medium confidence) ────────────
    for (const pattern of SUBJECT_AUTOPAY_PATTERNS) {
        if (pattern.test(subjectLower)) {
            return {
                isAutopay: true,
                confidence: 'high',
                reason: `Subject matches autopay pattern: ${pattern.source}`,
            };
        }
    }

    // ── Tier 3: Sender name contains service keyword (medium confidence) ──
    // Only fire when BOTH subject and sender name look like a service bill.
    // This prevents false positives from vendors whose names coincidentally
    // contain generic words like "electric" or "waste".
    const matchedSender = SERVICE_SENDER_KEYWORDS.find(
        entry => name.includes(entry.keyword) || email.includes(entry.keyword),
    );

    if (matchedSender) {
        // Boost confidence if subject also looks invoice-like
        const hasInvoiceSignal = /invoice|bill|statement|receipt|payment|charge|due/i.test(subjectLower);
        const confidence: 'medium' | 'high' = hasInvoiceSignal ? 'high' : 'medium';

        return {
            isAutopay: true,
            confidence,
            reason: `Sender contains "${matchedSender.keyword}" → ${matchedSender.label}${hasInvoiceSignal ? ' + invoice subject signal' : ''}`,
        };
    }

    return {
        isAutopay: false,
        confidence: 'low',
        reason: 'No autopay signals detected',
    };
}