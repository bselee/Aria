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
    // ── Confirmed dropship vendors (ship directly to customers) ────────────
    { vendorKeyword: 'autopot',          label: 'AutoPot (Dropship)' },
    { vendorKeyword: 'logan labs',       label: 'Logan Labs (Dropship)' },
    { vendorKeyword: 'loganlab',         label: 'Logan Labs (Dropship)' },
    { vendorKeyword: 'evergreen growers', label: 'Evergreen Growers (Dropship)' },
    { vendorKeyword: 'evergreengrow',    label: 'Evergreen Growers (Dropship)' },
    { vendorKeyword: 'abel',             label: 'Abel\'s Aces (Dropship)' },
    { vendorKeyword: 'abelsace',         label: 'Abel\'s Aces (Dropship)' },

    // ── QuickBooks routed dropship (vendor name only in subject) ───────────
    { senderKeyword: 'quickbooks', subjectRequired: 'logan labs',  label: 'Logan Labs (Dropship via QuickBooks)' },
    { senderKeyword: 'quickbooks', subjectRequired: 'autopot',     label: 'AutoPot (Dropship via QuickBooks)' },
    { senderKeyword: 'quickbooks', subjectRequired: 'fert',        label: 'Ferticell (Dropship via QuickBooks)' },

    // ── Add new dropship vendors here ──────────────────────────────────────
    // Format: { senderKeyword: 'domain.com', label: 'Vendor Name (Dropship)' }
    //   OR    { vendorKeyword: 'vendor name', label: 'Vendor Name (Dropship)' }
    { vendorKeyword: 'ferticell', label: 'Ferticell (Dropship)' },
    { vendorKeyword: 'fert', label: 'Ferticell (Dropship)' },
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
}

/**
 * Classify an invoice as dropship flow-through vs. real invoice needing analysis.
 *
 * This is the SINGLE authoritative function. Every pipeline path (ap-agent.ts,
 * dashboard invoice-queue, run-ap-pipeline.ts, Telegram commands) must call this.
 *
 * Resolution order:
 *   1. REAL_INVOICE_OVERRIDES — explicit override wins everything
 *   2. DROPSHIP_RULES — known dropship vendors
 *   3. Unknown — can't determine, needs human classification
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

    // ── Step 2: Check dropship rules ────────────────────────────────────────
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

    // ── Step 3: Unknown — can't determine from available data ──────────────
    // If we have enough data to make a real invoice guess, assume real
    if (vendor || email) {
        return {
            classification: 'real_invoice',
            reason: 'No dropship rules matched — treating as real invoice',
        };
    }

    return {
        classification: 'unknown',
        reason: 'Insufficient data to classify (no vendor name, sender, or subject)',
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