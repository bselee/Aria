/**
 * @file    src/lib/intelligence/ap/vendor-router.ts
 * @purpose Deterministic vendor routing rules — runs BEFORE LLM classification
 *          to save API calls and ensure correctness for known senders.
 * @author  Will / Antigravity / Hermia
 * @created 2026-05-28
 * @deps    none (pure config + matcher)
 * @extracted-from src/lib/intelligence/ap-agent.ts lines 49-160
 */

// ─── Vendor Routing Rules ────────────────────────────────────────────────────
// Deterministic routing for known vendor types.
// - 'autopay'       → vendor is on autopay or recurring subscription; mark read, no Bill.com forward
// - 'dropship'      → forward to Bill.com, mark read, skip PO matching/reconciliation
// - 'ignore'        → skip entirely (e.g., internal forwarded emails from Will's inbox)
// - 'amazon_order'  → route to Amazon order parser for tracking + Slack request matching

export interface VendorRoutingRule {
    match: {
        domain?: string;
        fromExact?: string;
        senderContains?: string;
        /** Match when the email subject contains this string (case-insensitive). */
        subjectContains?: string;
    };
    action: 'autopay' | 'dropship' | 'ignore' | 'amazon_order';
    label: string;
}

export const VENDOR_ROUTING_RULES: VendorRoutingRule[] = [
    // ── Autopay / recurring (mark read, no Bill.com forward) ─────────────
    { match: { domain: 'wwex.com' }, action: 'autopay', label: 'Worldwide Express (Autopay)' },
    { match: { senderContains: 'pioneer propane' }, action: 'autopay', label: 'Pioneer Propane' },
    { match: { domain: 'gorgias.com' }, action: 'autopay', label: 'Gorgias' },
    { match: { senderContains: 'gorgias' }, action: 'autopay', label: 'Gorgias' },
    { match: { domain: 'google.com' }, action: 'autopay', label: 'Google' },
    { match: { senderContains: 'google workspace' }, action: 'autopay', label: 'Google Workspace' },
    { match: { senderContains: 'google cloud' }, action: 'autopay', label: 'Google Cloud' },

    // ── Amazon (route to order parser for tracking) ──────────────────────
    { match: { senderContains: 'auto-confirm@amazon' }, action: 'amazon_order', label: 'Amazon Order Confirmation' },
    { match: { senderContains: 'ship-confirm@amazon' }, action: 'amazon_order', label: 'Amazon Shipping' },
    { match: { senderContains: 'shipment-tracking@amazon' }, action: 'amazon_order', label: 'Amazon Tracking' },
    { match: { senderContains: 'order-update@amazon' }, action: 'amazon_order', label: 'Amazon Order Update' },

    // ── Dropship vendors (forward to Bill.com, no PO matching) ──────────
    { match: { senderContains: 'logan labs' }, action: 'dropship', label: 'Logan Labs (Dropship)' },
    { match: { senderContains: 'autopot' }, action: 'dropship', label: 'AutoPot (Dropship)' },
    { match: { senderContains: 'evergreen growers' }, action: 'dropship', label: 'Evergreen Growers (Dropship)' },

    // ── QuickBooks dropship vendors (subject-based — vendor name only in subject line) ──
    { match: { senderContains: 'quickbooks', subjectContains: 'logan labs' }, action: 'dropship', label: 'Logan Labs (Dropship via QuickBooks)' },
    { match: { senderContains: 'quickbooks', subjectContains: 'autopot' }, action: 'dropship', label: 'AutoPot (Dropship via QuickBooks)' },
    { match: { senderContains: 'quickbooks', subjectContains: 'fert' }, action: 'dropship', label: 'Ferticell (Dropship via QuickBooks)' },

    // ── Internal ignores ────────────────────────────────────────────────
    { match: { fromExact: 'bill.selee@buildasoil.com' }, action: 'ignore', label: 'Internal (bill.selee)' },
];

/**
 * Match an email sender against vendor routing rules.
 * Returns the first matching rule or null.
 */
export function matchVendorRouting(
    fromEmail: string,
    fromName: string,
    subject: string = '',
): VendorRoutingRule | null {
    const email = (fromEmail || '').toLowerCase();
    const name = (fromName || '').toLowerCase();
    const domain = email.includes('@') ? email.split('@')[1] : '';
    const subjectLower = (subject || '').toLowerCase();

    for (const rule of VENDOR_ROUTING_RULES) {
        if (rule.match.domain && domain === rule.match.domain) return rule;
        if (rule.match.fromExact && email === rule.match.fromExact.toLowerCase()) return rule;
        if (rule.match.senderContains && (email.includes(rule.match.senderContains) || name.includes(rule.match.senderContains))) {
            // If rule also has a subjectContains requirement, check that too
            if (rule.match.subjectContains) {
                if (subjectLower.includes(rule.match.subjectContains.toLowerCase())) return rule;
                continue; // sender matched but subject didn't — keep looking
            }
            return rule;
        }
        // Subject-only match (no sender filter but subject matches)
        if (rule.match.subjectContains && !rule.match.senderContains && !rule.match.domain && !rule.match.fromExact) {
            if (subjectLower.includes(rule.match.subjectContains.toLowerCase())) return rule;
        }
    }
    return null;
}
