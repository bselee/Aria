/**
 * @file    src/config/invoice-classification.ts
 * @purpose SINGLE SOURCE OF TRUTH for classifying invoices as dropship flow-through
 *          vs. real invoices needing analysis. Merges previously scattered lists
 *          (vendor-router.ts dropship entries, dropship-vendors.ts, LLM fallback).
 *
 *          DROPSHIP_FLOW_THROUGH: Supplier ships directly to customer. BuildASoil
 *          never touches the product. The invoice passes through to Bill.com for
 *          payment. NO PO matching, NO line-item analysis, NO reconciliation.
 *
 *          REAL_INVOICE: BuildASoil's own purchase. Needs PO matching, price
 *          verification, line-item reconciliation, and discrepancy detection.
 *
 *          UNKNOWN: Can't determine from available data — requires human review
 *          before proceeding (typically surfaces as EYES_NEEDED).
 *
 * @author  Hermia
 * @created 2026-06-01
 * @deps    none (pure config + matcher)
 *
 * USAGE:
 *   import { classifyInvoice } from '@/config/invoice-classification';
 *   const result = classifyInvoice({ vendorName, fromEmail, subject });
 *   // result.classification === 'dropship_flow_through' | 'real_invoice' | 'unknown'
 *
 * NOTE: This is the AUTHORITATIVE source. The old vendor-router.ts `action: 'dropship'`
 * and dropship-vendors.ts `KNOWN_DROPSHIP_KEYWORDS` should both delegate here.
 */

// ─── Classification Types ──────────────────────────────────────────────────────

export type InvoiceClassification = 'dropship_flow_through' | 'real_invoice' | 'unknown';

export interface ClassificationResult {
    classification: InvoiceClassification;
    /** Why this classification was chosen (for logging/debugging) */
    reason: string;
    /** The matching rule/source that triggered this classification */
    matchedRule?: string;
}

// ─── Dropship Vendor Registry (SINGLE SOURCE OF TRUTH) ────────────────────────
// These vendors ship directly to customers — BuildASoil never receives the goods.
// Invoices are flow-through only: forward to Bill.com, skip analysis.
//
// Add new entries here. The same list feeds:
//   - ap-agent.ts routing (skip PO matching)
//   - dashboard invoice-queue filtering
//   - Telegram classification display
//   - run-ap-pipeline.ts classification display

interface DropshipRule {
    /** Keyword match against vendor name (case-insensitive, substring) */
    vendorKeyword?: string;
    /** Keyword match against from/sender email (case-insensitive, substring) */
    senderKeyword?: string;
    /** Exact domain match against from email (case-insensitive) */
    senderDomain?: string;
    /** Optional: require subject to also contain this for the rule to fire */
    subjectRequired?: string;
    /** Human-readable label for what this dropship rule covers */
    label: string;
}

const DROPSHIP_RULES: DropshipRule[] = [
    // ── Confirmed dropship-only vendors (Bill 2026-07-27) ──────────────────
    // These never place standard warehouse POs Aria manages.
    { vendorKeyword: 'autopot',           label: 'AutoPot (Dropship)' },
    { vendorKeyword: 'logan labs',        label: 'Logan Labs (Dropship)' },
    { vendorKeyword: 'loganlab',          label: 'Logan Labs (Dropship)' },
    { vendorKeyword: 'evergreen growers', label: 'Evergreen Growers (Dropship)' },
    { vendorKeyword: 'evergreengrow',     label: 'Evergreen Growers (Dropship)' },
    { vendorKeyword: 'evergreen',         label: 'Evergreen (Dropship)' }, // lighting variants
    { vendorKeyword: 'grandmaster',       label: 'Grandmaster (Dropship)' },
    { vendorKeyword: 'mammoth',           label: 'Mammoth (Dropship)' },
    { vendorKeyword: 'abel',              label: "Abel's Aces (Dropship)" },
    { vendorKeyword: 'abelsace',          label: "Abel's Aces (Dropship)" },

    // ── QuickBooks routed dropship (vendor name only in subject) ───────────
    { senderKeyword: 'quickbooks', subjectRequired: 'logan labs',  label: 'Logan Labs (Dropship via QuickBooks)' },
    { senderKeyword: 'quickbooks', subjectRequired: 'autopot',     label: 'AutoPot (Dropship via QuickBooks)' },
    { senderKeyword: 'quickbooks', subjectRequired: 'fert',        label: 'Ferticell (Dropship via QuickBooks)' },

    // Ferticell is dropship-only in Aria's purview
    { vendorKeyword: 'ferticell', label: 'Ferticell (Dropship)' },
];

// ─── Real Invoice Overrides ───────────────────────────────────────────────────
// These vendors are dropship-adjacent but produce invoices that MUST go through
// full reconciliation. Add a sender/vendor entry here if the automated classifier
// would guess dropship but the invoice actually needs analysis.
// (Empty for now — can grow as exceptions are discovered.)

interface OverrideRule {
    senderKeyword?: string;
    vendorKeyword?: string;
    senderDomain?: string;
    label: string;
}

const REAL_INVOICE_OVERRIDES: OverrideRule[] = [
    // Example: { senderDomain: 'some-dropship-adjacent.com', label: 'Vendor (Invoice Needs Analysis)' },
];

// ─── Classification Function ──────────────────────────────────────────────────

export interface ClassificationInput {
    /** Vendor name from invoice OCR or email From header name */
    vendorName?: string | null;
    /** From email address (e.g., "vendor@example.com") */
    fromEmail?: string | null;
    /** Email subject line */
    subject?: string | null;
    /** Filename of PDF attachment */
    filename?: string | null;
    /** Whether this came via the AP inbox (true) or default inbox (false) */
    fromApInbox?: boolean;
    /**
     * Purchase order number. PO-pattern detection is STRONGER than
     * vendor-name keyword matching because the PO number is an
     * authoritative system identifier — if the PO ends with
     * "-DropshipPO" or "-S-DropshipPO", the transaction IS a
     * dropship regardless of vendor name. Keeping both signals
     * ensures coverage even when one is missing.
     */
    poNumber?: string | null;
}

/**
 * Classify an invoice as dropship flow-through vs. real invoice needing analysis.
 *
 * This is the SINGLE authoritative function. Every pipeline path (ap-agent.ts,
 * dashboard invoice-queue, run-ap-pipeline.ts, Telegram commands) must call this.
 *
 * Resolution order:
 *   1. REAL_INVOICE_OVERRIDES — explicit override wins everything
 *   2. PO NUMBER dropship pattern — stronger than vendor name because the PO is
 *      an authoritative system identifier. If the PO ends with "-DropshipPO" or
 *      "-S-DropshipPO", it IS a dropship regardless of vendor name.
 *   3. DROPSHIP_RULES — known dropship vendors (keyword fallback)
 *   4. Unknown — can't determine, needs human classification
 *
 * NOTE: PO-pattern detection is deliberately placed before vendor-name keyword
 * matching because a dropship-suffixed PO number is an unambiguous signal from
 * the purchasing system — it doesn't depend on OCR quality, vendor name
 * variations, or the keyword registry being kept up to date. Removing this as
 * "duplicate of keyword matching" would create a regression for any dropship
 * vendor whose name is not in KNOWN_DROPSHIP_KEYWORDS.
 */
export function classifyInvoice(input: ClassificationInput): ClassificationResult {
    const vendor = (input.vendorName || '').toLowerCase().trim();
    const email = (input.fromEmail || '').toLowerCase().trim();
    const subject = (input.subject || '').toLowerCase().trim();
    const filename = (input.filename || '').toLowerCase().trim();

    // Extract domain from email
    const domain = email.includes('@') ? email.split('@')[1] || '' : '';

    // Build search space: search vendor name, from email, email domain, and filename
    const searchSpace = [vendor, email, domain, filename].filter(Boolean);

    // ── Step 1: Check real_invoice overrides first ──────────────────────────
    for (const rule of REAL_INVOICE_OVERRIDES) {
        if (rule.senderKeyword && email.includes(rule.senderKeyword.toLowerCase())) {
            return { classification: 'real_invoice', reason: `Override: ${rule.label}`, matchedRule: rule.label };
        }
        if (rule.senderDomain && domain === rule.senderDomain.toLowerCase()) {
            return { classification: 'real_invoice', reason: `Override: ${rule.label}`, matchedRule: rule.label };
        }
        if (rule.vendorKeyword && vendor.includes(rule.vendorKeyword.toLowerCase())) {
            return { classification: 'real_invoice', reason: `Override: ${rule.label}`, matchedRule: rule.label };
        }
    }

    // ── Step 2: PO-number dropship pattern (stronger than vendor name) ──────
    // The PO number is an authoritative system identifier — if it ends with
    // "-DropshipPO" or "-S-DropshipPO", the transaction IS a dropship regardless
    // of vendor name, OCR accuracy, or keyword registry completeness.
    const po = (input.poNumber || '').trim();
    if (po && /DropshipPO/i.test(po)) {
        return {
            classification: 'dropship_flow_through',
            reason: `Dropship PO number: ${po}`,
            matchedRule: 'PO Pattern: DropshipPO',
        };
    }

    // ── Step 3: Check dropship rules ────────────────────────────────────────
    for (const rule of DROPSHIP_RULES) {
        // If rule has a subject requirement, check it first
        if (rule.subjectRequired && !subject.includes(rule.subjectRequired.toLowerCase())) {
            continue; // subject doesn't match, skip this rule
        }

        if (rule.vendorKeyword) {
            // Check if vendor name contains the keyword
            if (vendor.includes(rule.vendorKeyword.toLowerCase())) {
                return {
                    classification: 'dropship_flow_through',
                    reason: `Vendor "${input.vendorName}" matches dropship keyword "${rule.vendorKeyword}"`,
                    matchedRule: rule.label,
                };
            }
        }

        if (rule.senderKeyword) {
            if (email.includes(rule.senderKeyword.toLowerCase())) {
                return {
                    classification: 'dropship_flow_through',
                    reason: `Sender "${input.fromEmail}" matches dropship keyword "${rule.senderKeyword}"`,
                    matchedRule: rule.label,
                };
            }
        }

        if (rule.senderDomain) {
            if (domain === rule.senderDomain.toLowerCase()) {
                return {
                    classification: 'dropship_flow_through',
                    reason: `Domain "${domain}" matches dropship domain "${rule.senderDomain}"`,
                    matchedRule: rule.label,
                };
            }
        }
    }

    // ── Step 4: Unknown — can't determine from available data ──────────────
    // If we have enough data to make a real invoice guess, assume real.
    // Reason is intentionally EMPTY for the common case — the dashboard
    // must not spam "No dropship rules matched" on every real invoice row.
    if (vendor || email) {
        return {
            classification: 'real_invoice',
            reason: '',
        };
    }

    return {
        classification: 'unknown',
        reason: 'Insufficient data to classify',
    };
}

/**
 * Convenience: check if an invoice classification is dropship flow-through.
 */
export function isDropshipFlowThrough(input: ClassificationInput): boolean {
    return classifyInvoice(input).classification === 'dropship_flow_through';
}

/**
 * Convenience: check if an invoice classification needs analysis.
 */
export function needsAnalysis(input: ClassificationInput): boolean {
    return classifyInvoice(input).classification === 'real_invoice';
}