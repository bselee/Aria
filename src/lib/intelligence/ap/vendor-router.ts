/**
 * @file    src/lib/intelligence/ap/vendor-router.ts
 * @purpose Minimal vendor routing rules. Core principle: ALL PDF invoices forward
 *          to Bill.com. Only skip: internal emails, Bill.com self-notifications,
 *          FedEx past-due notices, Amazon order confirmations, own statements.
 *          Dropship markers are PO-matching hints only — still forward.
 * @author  Hermia
 * @created 2026-05-28 (extracted from ap-agent.ts)
 * @updated 2026-06-18 (Bill Selee: stripped autopay — forward all PDFs)
 * @deps    none (pure config + matcher)
 */

// ─── Vendor Routing Rules ────────────────────────────────────────────────────
// Actions:
//   'forward'       → forward to Bill.com, attempt PO matching (default for all PDFs)
//   'dropship'      → forward to Bill.com, skip PO matching (no Finale PO exists)
//   'skip'          → mark read, do NOT forward (internal, self-notifications, non-invoice)
//   'amazon_order'  → route to Amazon order parser (separate pipeline)
//
// DESIGN DECISION (2026-06-18, Bill Selee):
//   ALL PDF invoices are forwarded to Bill.com identically.
//   Skips are for: prepaid/online vendors (no discoverable amount to forward),
//   internal emails, Bill.com self-notifications, FedEx past-due notices,
//   Amazon tracking, and own statements.
//   FedEx is the corrected exception: was wrongly marked autopay.
//   Invoice PDFs from noreply@fedex.com flow through to forwarding + PO matching.

export interface VendorRoutingRule {
    match: {
        domain?: string;
        fromExact?: string;
        senderContains?: string;
        subjectContains?: string;
    };
    action: 'forward' | 'dropship' | 'skip' | 'amazon_order';
    label: string;
}

export const VENDOR_ROUTING_RULES: VendorRoutingRule[] = [
    // ── Skip: internal emails ──────────────────────────────────────────
    { match: { fromExact: 'bill.selee@buildasoil.com' }, action: 'skip', label: 'Internal (bill.selee)' },

    // ── Skip: Bill.com self-notifications ──────────────────────────────
    { match: { domain: 'inform.bill.com' }, action: 'skip', label: 'Bill.com Self-Notification' },

    // ── Skip: prepaid / online-only vendors ─────────────────────────────
    // These are paid via online portal — no discoverable invoice amount to forward.
    { match: { domain: 'wwex.com' }, action: 'skip', label: 'Worldwide Express (Prepaid Online)' },
    { match: { senderContains: 'pioneer propane' }, action: 'skip', label: 'Pioneer Propane (Prepaid)' },
    { match: { domain: 'gorgias.com' }, action: 'skip', label: 'Gorgias (Prepaid)' },
    { match: { senderContains: 'gorgias' }, action: 'skip', label: 'Gorgias (Prepaid)' },
    { match: { domain: 'google.com' }, action: 'skip', label: 'Google (Prepaid)' },
    { match: { senderContains: 'google workspace' }, action: 'skip', label: 'Google Workspace (Prepaid)' },
    { match: { senderContains: 'google cloud' }, action: 'skip', label: 'Google Cloud (Prepaid)' },
    { match: { senderContains: 'culligan' }, action: 'skip', label: 'Culligan Water (Prepaid)' },
    { match: { senderContains: 'terminix' }, action: 'skip', label: 'Terminix (Prepaid)' },

    // ── Skip: FedEx past-due notices (no invoice PDF) ──────────────────
    // Invoice PDFs come from noreply@fedex.com and flow through normally.
    { match: { fromExact: 'billingonline@fedex.com' }, action: 'skip', label: 'FedEx Past Due (No Invoice)' },

    // ── Skip: BuildASoil own statements ────────────────────────────────
    { match: { subjectContains: 'build a soil statement' }, action: 'skip', label: 'BuildASoil Statement (Internal)' },
    { match: { senderContains: 'buildasoil.com', subjectContains: 'statement' }, action: 'skip', label: 'BuildASoil Statement (Internal)' },

    // ── Amazon: route to order parser ──────────────────────────────────
    { match: { senderContains: 'auto-confirm@amazon' }, action: 'amazon_order', label: 'Amazon Order Confirmation' },
    { match: { senderContains: 'ship-confirm@amazon' }, action: 'amazon_order', label: 'Amazon Shipping' },
    { match: { senderContains: 'shipment-tracking@amazon' }, action: 'amazon_order', label: 'Amazon Tracking' },
    { match: { senderContains: 'order-update@amazon' }, action: 'amazon_order', label: 'Amazon Order Update' },

    // ── Dropship: forward to Bill.com, skip PO matching ────────────────
    // These vendors dropship directly to customers — no Finale PO exists.
    // Still forwarded to Bill.com for payment processing.
    { match: { senderContains: 'logan labs' }, action: 'dropship', label: 'Logan Labs (Dropship)' },
    { match: { senderContains: 'autopot' }, action: 'dropship', label: 'AutoPot (Dropship)' },
    { match: { senderContains: 'evergreen growers' }, action: 'dropship', label: 'Evergreen Growers (Dropship)' },
    { match: { domain: 'evergreengrowers.com' }, action: 'dropship', label: 'Evergreen Growers (Dropship)' },
    { match: { senderContains: 'ferticell' }, action: 'dropship', label: 'Ferticell (Dropship)' },

    // QuickBooks variants
    { match: { senderContains: 'quickbooks', subjectContains: 'logan labs' }, action: 'dropship', label: 'Logan Labs (Dropship via QuickBooks)' },
    { match: { senderContains: 'quickbooks', subjectContains: 'autopot' }, action: 'dropship', label: 'AutoPot (Dropship via QuickBooks)' },
    { match: { senderContains: 'quickbooks', subjectContains: 'fert' }, action: 'dropship', label: 'Ferticell (Dropship via QuickBooks)' },
];

/**
 * Match an email sender against vendor routing rules.
 * Returns the first matching rule or null (null = default forward + PO matching).
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
            if (rule.match.subjectContains) {
                if (subjectLower.includes(rule.match.subjectContains.toLowerCase())) return rule;
                continue;
            }
            return rule;
        }
        if (rule.match.subjectContains && !rule.match.senderContains && !rule.match.domain && !rule.match.fromExact) {
            if (subjectLower.includes(rule.match.subjectContains.toLowerCase())) return rule;
        }
    }
    return null;
}
