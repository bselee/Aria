/**
 * @file    src/lib/intelligence/ap/vendor-router.ts
 * @purpose Minimal vendor routing rules. Core principle: ALL PDF invoices forward
 *          to Bill.com. Only skip: internal emails, Bill.com self-notifications,
 *          FedEx past-due notices, Amazon order confirmations, own statements,
 *          shipment notices / order acks / vendor statements.
 *          Dropship markers are PO-matching hints only — still forward.
 * @author  Hermia
 * @created 2026-05-28 (extracted from ap-agent.ts)
 * @updated 2026-07-17 (Toyota Commercial Finance prepaid online; Belt Power AR
 *          statements/reminders; broader statement subject classes)
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
//   Amazon tracking, own statements, and non-invoice classes (shipment/ack/statement).
//   FedEx is the corrected exception: was wrongly marked autopay.
//   Invoice PDFs from noreply@fedex.com flow through to forwarding + PO matching.
//
// HERMIA(2026-07-17):
//   Toyota Industries Commercial Finance (TICF / BillTrust) = paid online — never Bill.com.
//   Belt Power invoices only from remitto@; beltpowerar@ is statements/collections/reminders.

export interface VendorRoutingRule {
    match: {
        domain?: string;
        fromExact?: string;
        senderContains?: string;
        subjectContains?: string;
        /** Optional attachment filename fragment (checked by local-forwarder, not Gmail headers). */
        filenameContains?: string;
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
    // Toyota Industries Commercial Finance — paid online (BillTrust portal)
    { match: { senderContains: 'toyota commercial finance' }, action: 'skip', label: 'Toyota Commercial Finance (Paid Online)' },
    { match: { senderContains: 'ticf' }, action: 'skip', label: 'TICF (Paid Online)' },
    { match: { domain: 'billtrust.com', subjectContains: 'ticf' }, action: 'skip', label: 'TICF via BillTrust (Paid Online)' },
    { match: { domain: 'billtrust.com', senderContains: 'toyota' }, action: 'skip', label: 'Toyota CF via BillTrust (Paid Online)' },
    { match: { domain: 'toyotacf.com' }, action: 'skip', label: 'Toyota CF Domain (Paid Online)' },

    // ── Skip: FedEx past-due notices (no invoice PDF) ──────────────────
    // Invoice PDFs come from noreply@fedex.com and flow through normally.
    { match: { fromExact: 'billingonline@fedex.com' }, action: 'skip', label: 'FedEx Past Due (No Invoice)' },

    // ── Skip: BuildASoil own statements ────────────────────────────────
    { match: { subjectContains: 'build a soil statement' }, action: 'skip', label: 'BuildASoil Statement (Internal)' },
    { match: { senderContains: 'buildasoil.com', subjectContains: 'statement' }, action: 'skip', label: 'BuildASoil Statement (Internal)' },

    // ── Skip: non-invoice email classes (2026-07-10 Belt Power incident) ──
    // Shipment notices / acks / statements can carry dollar amounts + PDFs.
    // They are NOT invoices. Inline-invoice-handler was fabricating Organic AG
    // bills from Belt Power shipment HTML and multi-forwarding to Bill.com.
    { match: { subjectContains: 'shipment notification' }, action: 'skip', label: 'Shipment Notification (Not Invoice)' },
    { match: { subjectContains: 'order has shipped' }, action: 'skip', label: 'Ship Confirm (Not Invoice)' },
    { match: { subjectContains: 'your order has shipped' }, action: 'skip', label: 'Ship Confirm (Not Invoice)' },
    { match: { subjectContains: 'order acknowledgement' }, action: 'skip', label: 'Order Ack (Not Invoice)' },
    { match: { subjectContains: 'order acknowledgment' }, action: 'skip', label: 'Order Ack (Not Invoice)' },
    // BFG Supply sends "Acknowledgment for OrderNumber: NNN" with an
    // Acknowledgment_*.pdf — an order ack, never a bill (2026-09-08: two were
    // forwarded; zero became bills, both correctly absent from Bill.com).
    { match: { filenameContains: 'acknowledgment_' }, action: 'skip', label: 'Order Ack PDF (Not Invoice)' },
    { match: { filenameContains: '_acknowledgment' }, action: 'skip', label: 'Order Ack PDF (Not Invoice)' },
    { match: { subjectContains: 'monthly statement' }, action: 'skip', label: 'Vendor Monthly Statement' },
    { match: { subjectContains: 'account statement' }, action: 'skip', label: 'Account Statement (Not Invoice)' },
    { match: { subjectContains: 'statement of account' }, action: 'skip', label: 'Statement of Account (Not Invoice)' },
    { match: { subjectContains: 'your statement' }, action: 'skip', label: 'Your Statement (Not Invoice)' },
    { match: { subjectContains: 'reminder on overdue' }, action: 'skip', label: 'Overdue Reminder (Not Invoice)' },
    { match: { subjectContains: 'packing list' }, action: 'skip', label: 'Packing List (Not Invoice)' },
    // Belt Power: invoices only from remitto@. AR mailbox + reminders/statements are noise.
    { match: { fromExact: 'no-reply@beltpower.com' }, action: 'skip', label: 'Belt Power No-Reply (Ship Notices)' },
    { match: { fromExact: 'beltpowerar@beltpower.com' }, action: 'skip', label: 'Belt Power AR (Statements/Collections)' },
    { match: { senderContains: 'beltpowerar' }, action: 'skip', label: 'Belt Power AR (Statements/Collections)' },
    { match: { senderContains: 'beltpower', subjectContains: 'statement' }, action: 'skip', label: 'Belt Power Statement' },
    { match: { senderContains: 'beltpower', subjectContains: 'overdue' }, action: 'skip', label: 'Belt Power Overdue Reminder' },
    { match: { senderContains: 'beltpower', subjectContains: 'shipment' }, action: 'skip', label: 'Belt Power Shipment' },
    { match: { senderContains: 'beltpower', subjectContains: 'reminder' }, action: 'skip', label: 'Belt Power Invoice Reminder' },
    { match: { senderContains: 'beltpower', subjectContains: 'immediate attention' }, action: 'skip', label: 'Belt Power Collections Notice' },
    // Filename-aware rules (local-forwarder passes attachment name into matchVendorRouting)
    { match: { senderContains: 'beltpower', filenameContains: 'statement' }, action: 'skip', label: 'Belt Power Statement PDF' },
    { match: { filenameContains: '_statement' }, action: 'skip', label: 'Statement Attachment (Not Invoice)' },
    { match: { filenameContains: 'statement.pdf' }, action: 'skip', label: 'Statement PDF (Not Invoice)' },

    // ── Skip: account statements & correspondence (2026-09-08 audit) ────
    // Evidence: Berger Horticultural STATEMENT/RELEVÉ DE COMPTE (BUIAS1.pdf,
    // $42,539) + account-update images forwarded to Bill.com, never became bills.
    // ⚠️ Berger ALSO sends real invoices in batches of 10–14 per delivery
    //    (no deliveries recently, so none observed). Real invoices arrive as
    //    QuickBooks "New payment request" or invoice-subject emails — those
    //    MUST keep forwarding (null rule). Skip ONLY explicit statement /
    //    correspondence signals; never a bare sender or 'compte' match
    //    (French invoices can legitimately reference "compte").
    { match: { senderContains: 'berger', subjectContains: 'statement' }, action: 'skip', label: 'Berger Statement (Not Invoice)' },
    { match: { senderContains: 'berger', subjectContains: 'relev' }, action: 'skip', label: 'Berger Statement FR (Relevé de Compte)' },
    { match: { senderContains: 'berger', subjectContains: 'update required' }, action: 'skip', label: 'Berger Account Correspondence' },
    // Wagner Equipment "Invoice and CC Receipt" (F1973685.PDF) — paid by credit
    // card at pickup; the PDF is a CC receipt, not a payable.
    { match: { senderContains: 'wagner equipment', subjectContains: 'cc receipt' }, action: 'skip', label: 'Wagner CC Receipt (Paid)' },
    // Marion Ag payment receipts (Payment Receipt_Customer_*.pdf) prove a payment
    // already made — the payable invoice was forwarded separately (Invoice_*.pdf).
    { match: { senderContains: 'marionag', filenameContains: 'payment receipt' }, action: 'skip', label: 'Marion Ag Payment Receipt (Paid)' },
    // Grassroots reminder threads carry a photo/PDF of an invoice already sent via
    // QuickBooks ("Grassroots Invoice NNNNN"). Reminder = duplicate content.
    { match: { senderContains: 'grassroots', subjectContains: 'reminder' }, action: 'skip', label: 'Grassroots Invoice Reminder (Duplicate)' },

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
 *
 * All specified match fields are ANDed. Domain/fromExact/senderContains are
 * identity constraints; subjectContains / filenameContains are optional filters.
 * Pure subjectContains / filenameContains rules (no identity) are allowed.
 *
 * @param filename - Optional attachment filename (for statement PDF detection)
 */
export function matchVendorRouting(
    fromEmail: string,
    fromName: string,
    subject: string = '',
    filename: string = '',
): VendorRoutingRule | null {
    const email = (fromEmail || '').toLowerCase();
    const name = (fromName || '').toLowerCase();
    const domain = email.includes('@') ? email.split('@')[1] : '';
    const subjectLower = (subject || '').toLowerCase();
    const filenameLower = (filename || '').toLowerCase();

    for (const rule of VENDOR_ROUTING_RULES) {
        const m = rule.match;

        if (m.fromExact && email !== m.fromExact.toLowerCase()) continue;
        if (m.domain && domain !== m.domain.toLowerCase()) continue;
        if (m.senderContains) {
            const needle = m.senderContains.toLowerCase();
            if (!(email.includes(needle) || name.includes(needle))) continue;
        }
        if (m.subjectContains && !subjectLower.includes(m.subjectContains.toLowerCase())) continue;
        if (m.filenameContains) {
            // Filename rules require a filename; empty = no match
            if (!filenameLower || !filenameLower.includes(m.filenameContains.toLowerCase())) continue;
        }

        // Require at least one constraint so empty match objects never fire
        if (m.fromExact || m.domain || m.senderContains || m.subjectContains || m.filenameContains) {
            return rule;
        }
    }
    return null;
}
