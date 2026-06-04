/**
 * @file    src/lib/intelligence/ap/autopay-detector.ts
 * @purpose Auto-detect autopay vendors from email-level signals (sender, subject,
 *          snippet) BEFORE LLM classification or OCR.
 *
 *          CRITICAL RULE: Must verify the invoice has ACTUALLY BEEN PAID before
 *          allowing the caller to archive it. If there's any doubt, the caller
 *          must leave the email UNREAD in the inbox for human escalation.
 *
 *          Two-stage detection:
 *            Stage 1: Is this from an autopay vendor? (domain, sender, subject)
 *            Stage 2: Has this invoice been PAID? (snippet, subject signals)
 *
 *          verifiedPaid=true  → caller MAY archive (mark read, remove from inbox)
 *          verifiedPaid=false → caller MUST leave UNREAD (log but don't touch inbox)
 *
 * PATTERNS IDENTIFIED (kaizen 2026-06-04):
 *   - Domain match: known autopay providers (culligan.com, terminix.com)
 *   - Subject keywords: "autopay", "monthly service", "recurring"
 *   - Payment keywords: "paid", "payment received", "receipt", "confirmation"
 *   - Snippet: "balance $0.00", "paid in full", "payment successful"
 *
 * @author  Hermia
 * @created 2026-06-04
 * @deps    none (pure heuristic matching)
 * @env     none
 */

// ─── Payment Verification Signals ──────────────────────────────────────────
// These indicate the invoice has actually been PAID, not just sent.
// Subject-based (available before OCR/download).

const PAID_SUBJECT_PATTERNS: RegExp[] = [
    /payment\s+(received|confirmed|successful|complete|processed)/i,
    /autopay\s+(receipt|confirmation|notice)/i,
    /receipt/i,                                     // "Receipt for your payment"
    /paid\s+invoice/i,
    /invoice\s+paid/i,
    /payment\s+receipt/i,
    /confirmation\s+#?\d/i,                         // "Payment confirmation #12345"
    /thank\s+you\s+for\s+your\s+(payment|order)/i,
    /auto\s*pay.*confirm/i,
];

const PAID_SNIPPET_PATTERNS: RegExp[] = [
    /balance\s*:?\s*\$?\s*0\.00/i,
    /paid\s+in\s+full/i,
    /payment\s+received/i,
    /transaction\s+(complete|successful|approved)/i,
    /amount\s+paid/i,
    /total\s+paid/i,
    /autopay\s+processed/i,
    /this\s+(payment|transaction).*(complete|processed)/i,
    /your\s+payment\s+of\s+\$[\d,]+\.\d{2}/i,
];

// ─── Autopay Signal Patterns ────────────────────────────────────────────────
// These indicate the email is FROM an autopay/recurring vendor (not necessarily
// confirming payment — just identifying the sender type).

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
    /** Whether the email appears to be from an autopay/recurring vendor */
    isAutopay: boolean;
    /**
     * Whether we can verify the invoice has actually been PAID.
     * If false, the caller MUST leave the email UNREAD in the inbox
     * for human escalation — do NOT archive.
     */
    verifiedPaid: boolean;
    /** Confidence level of the autopay vendor detection */
    confidence: 'high' | 'medium' | 'low';
    /** Human-readable reason for the decision */
    reason: string;
}

// ─── Detector ───────────────────────────────────────────────────────────────

/**
 * Detect whether an email represents a PAID autopay/recurring vendor invoice.
 *
 * Two-stage detection:
 *   1. Is this from an autopay vendor? (domain, sender, subject)
 *   2. Has this invoice been PAID? (subject, snippet signals)
 *
 * **Caller contract:**
 *   - verifiedPaid=true  → MAY archive (mark read, remove from inbox)
 *   - verifiedPaid=false → MUST leave UNREAD in inbox for escalation
 *   - isAutopay=false    → proceed with normal LLM classification
 *
 * @param fromEmail  - The sender's email address (e.g., "billing@culligan.com")
 * @param fromName   - The sender's display name (e.g., "Culligan Water Service")
 * @param subject    - The email subject line
 * @param snippet    - (Optional) Gmail snippet/preview text for payment signals
 * @returns AutopayDetectionResult with isAutopay, verifiedPaid, and confidence
 *
 * @example
 *   // Strong domain match, no payment verification → log, don't archive
 *   detectAutopay('billing@culligan.com', 'Culligan Water', 'Your Invoice');
 *   // => { isAutopay: true, verifiedPaid: false, confidence: 'high', ... }
 *
 *   // Subject confirms payment → safe to archive
 *   detectAutopay('billing@culligan.com', 'Culligan Water', 'Payment Receipt - Culligan');
 *   // => { isAutopay: true, verifiedPaid: true, confidence: 'high', ... }
 */
export function detectAutopay(
    fromEmail: string,
    fromName: string,
    subject: string,
    snippet?: string,
): AutopayDetectionResult {
    const email = (fromEmail || '').toLowerCase();
    const name = (fromName || '').toLowerCase();
    const subjectLower = (subject || '').toLowerCase();
    const snippetLower = (snippet || '').toLowerCase();
    const combinedText = `${subjectLower} ${snippetLower}`;

    // ── Stage 1: Is this from an autopay vendor? ──────────────────────────

    let isAutopay = false;
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let reasonParts: string[] = [];

    // Tier 1: Strong domain match
    if (email.includes('@')) {
        const domain = email.split('@')[1];
        for (const entry of STRONG_AUTOPAY_DOMAINS) {
            if (domain === entry.domain || domain.endsWith('.' + entry.domain)) {
                isAutopay = true;
                confidence = 'high';
                reasonParts.push(`Domain: ${entry.domain} → ${entry.label}`);
                break;
            }
        }
    }

    // Tier 2: Subject keyword match
    if (!isAutopay) {
        for (const pattern of SUBJECT_AUTOPAY_PATTERNS) {
            if (pattern.test(subjectLower)) {
                isAutopay = true;
                confidence = 'high';
                reasonParts.push(`Subject: ${pattern.source}`);
                break;
            }
        }
    }

    // Tier 3: Sender name contains service keyword
    if (!isAutopay) {
        const matchedSender = SERVICE_SENDER_KEYWORDS.find(
            entry => name.includes(entry.keyword) || email.includes(entry.keyword),
        );
        if (matchedSender) {
            const hasInvoiceSignal = /invoice|bill|statement|receipt|payment|charge|due/i.test(subjectLower);
            isAutopay = true;
            confidence = hasInvoiceSignal ? 'high' : 'medium';
            reasonParts.push(`Sender: "${matchedSender.keyword}" → ${matchedSender.label}`);
        }
    }

    if (!isAutopay) {
        return {
            isAutopay: false,
            verifiedPaid: false,
            confidence: 'low',
            reason: 'No autopay signals detected',
        };
    }

    // ── Stage 2: Has this invoice been PAID? ──────────────────────────────
    // Check subject + snippet for payment confirmation signals.
    // Without payment verification, we log but leave the email UNREAD.

    const subjectHasPaidSignal = PAID_SUBJECT_PATTERNS.some(p => p.test(subjectLower));
    const snippetHasPaidSignal = PAID_SNIPPET_PATTERNS.some(p => p.test(snippetLower));
    const verifiedPaid = subjectHasPaidSignal || snippetHasPaidSignal;

    if (verifiedPaid) {
        if (subjectHasPaidSignal) reasonParts.push('Subject confirms payment');
        if (snippetHasPaidSignal) reasonParts.push('Snippet confirms payment');
    } else {
        reasonParts.push('No payment verification (leave UNREAD)');
    }

    return {
        isAutopay: true,
        verifiedPaid,
        confidence,
        reason: reasonParts.join('; '),
    };
}