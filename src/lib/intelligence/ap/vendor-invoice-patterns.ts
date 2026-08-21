/**
 * @file    src/lib/intelligence/ap/vendor-invoice-patterns.ts
 * @purpose Declarative per-vendor invoice-number + bundle-detection patterns.
 *          Lifts the hard-coded AAA Cooper Pro# regex and bundle-skip branch out
 *          of ap-local-forwarder.ts so the NEXT vendor that bundles invoices
 *          gets a table row, not another code branch.
 *          WHY THE SUBJECT IS THE SOURCE OF TRUTH: OCR-extracted invoice numbers
 *          for LTL freight are garbage — observed values include "3746570"
 *          (AAA Cooper's ACCOUNT number, not an invoice number), the literal
 *          string "==Start of OCR for page 1==", and comma-joined lists from
 *          bundle PDFs. The email SUBJECT reliably carries the real Pro#.
 * @author  Hermia
 * @created 2026-08-13
 * @deps    none (pure config + matchers — no DB, no I/O, no imports from the
 *          forwarder; importing ap-local-forwarder.ts would be circular)
 */

export interface VendorInvoicePattern {
    /** Stable key, e.g. 'aaacooper'. Used for debugging and future DB gating. */
    vendorKey: string;
    /** Canonical vendor name written to DB rows, e.g. 'AAA Cooper Transportation'. */
    canonicalName: string;
    /** Matches the From header (email + display name). First row that matches wins. */
    senderMatch: RegExp;
    /** Ordered: first capture group that hits wins. */
    invoicePatterns: RegExp[];
    /** Subject shapes that mean "bundle/correspondence, not one invoice". */
    bundleSubjectPatterns?: RegExp[];
    /**
     * When set, ONLY subjects matching one of these are single invoices —
     * anything else is a bundle. This single rule is what protects AAA Cooper
     * today: only "Invoice Stmt ..." and bare-Pro# subjects stay forwarded.
     */
    individualSubjectPatterns?: RegExp[];
}

// ─── Vendor table ────────────────────────────────────────────────────────────
// Every regex below names the real-world subject / sender it was derived from
// (all observed in ap_local_forwards, 2026-08-13).
export const VENDOR_INVOICE_PATTERNS: VendorInvoicePattern[] = [
    // ── AAA Cooper Transportation ──────────────────────────────────────
    // Real senders: act.statement@aaacooper.com,
    //   Becky Seehaver <BECKY.SEEHAVER@aaacooper.com>,
    //   correspondence.aaacooper@jas.collectiontoolbox.com, and display name
    //   "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>".
    {
        vendorKey: "aaacooper",
        canonicalName: "AAA Cooper Transportation",
        senderMatch: /aaacooper|cooper transportation/i,
        invoicePatterns: [
            // "Invoice Stmt - Cust 0001159492 Pro#: 64058431" → 64058431
            // (the Pro# is the real invoice identity; the Cust/account number
            //  "0001159492" / decoy "3746570" must never win — Pro# is first)
            /Pro#:\s*(\d+)/i,
            // Bare Pro# subject "64471555" (Becky Seehaver)
            /^\s*(\d{5,10})\s*$/,
        ],
        bundleSubjectPatterns: [
            // "Account 1159492 - BUILDASOIL" (correspondence.aaacooper@jas.collectiontoolbox.com)
            /^Account\s+\d+\s*-/i,
            // Threads with "Correspondence" in the subject
            /Correspondence/i,
            // Reply threads "RE: Need remittance" / "RE: Buildasoil" (Becky Seehaver)
            /^RE:/i,
        ],
        individualSubjectPatterns: [
            // "Invoice Stmt - Cust 0001159492 Pro#: 64058431" (act.statement@aaacooper.com)
            /invoice stmt/i,
            // Bare Pro# subject "64471555" (Becky Seehaver)
            /^\s*\d{5,10}\s*$/,
        ],
    },

    // ── Belt Power ─────────────────────────────────────────────────────
    // Real senders: "Belt Power, LLC" <remitto@beltpower.com>,
    //   "Belt Power AR" <beltpowerar@beltpower.com>.
    {
        vendorKey: "beltpower",
        canonicalName: "Belt Power",
        senderMatch: /beltpower/i,
        invoicePatterns: [
            // "Belt Power, LLC - Invoice# 3198860 Belt Power Invoice" → 3198860
            // also "Invoice 3196029 Reminder from Belt Power, LLC" → 3196029
            /Invoice#?\s*(\d{5,10})/i,
        ],
    },
];

/**
 * Generic invoice-number chain used when NO vendor row matches.
 *
 * Byte-identical to the historical subject-only extraction in
 * ap-local-forwarder.ts (Pro# → bare digits → invoice). Kept as the full chain
 * because the forwarder's subject-only helper has no sender context — a
 * single-pattern fallback would silently stop extracting AAA Cooper Pro#
 * numbers and break the vendor+invoice# dedup gate.
 *
 * Spec seed: generic fallback pattern `/invoice\s*(?:#|no\.?|number)?\s*:?\s*(\d{5,10})/i`
 * is the LAST pattern of this chain ("Invoice #12345" → 12345).
 */
const GENERIC_INVOICE_PATTERNS: RegExp[] = [
    // "Invoice Stmt - Cust 0001159492 Pro#: 64058431" → 64058431 (AAA Cooper Pro#)
    /Pro#:\s*(\d+)/i,
    // Bare subject "64471555" → 64471555
    /^\s*(\d{5,10})\s*$/,
    // "Invoice #12345" / "Invoice no. 12345" / "Invoice number: 12345" → 12345
    /invoice\s*(?:#|no\.?|number)?\s*:?\s*(\d{5,10})/i,
];

/**
 * Generic bundle signatures — apply to ALL vendors (spec WS-C requirement),
 * whether or not they have a table row.
 */
const GENERIC_BUNDLE_SUBJECT_PATTERNS: RegExp[] = [
    // "Account 1159492 - BUILDASOIL" — account-number correspondence bundles
    /^Account\s+\d+\s*-/i,
    // Subject containing "Correspondence" (bundle/correspondence threads)
    /Correspondence/i,
];

/**
 * Find the first vendor pattern row whose senderMatch hits the From header.
 * First row that matches wins (aaacooper row precedes beltpower, mirroring the
 * historical check order in deriveVendorName).
 *
 * @param from - raw Gmail From header ("Name <email@domain.com>" or bare email)
 * @returns the matched row, or null when no vendor row matches
 */
export function matchVendorInvoicePattern(from: string): VendorInvoicePattern | null {
    const lower = (from || "").toLowerCase();
    for (const pattern of VENDOR_INVOICE_PATTERNS) {
        if (pattern.senderMatch.test(lower)) return pattern;
    }
    return null;
}

/**
 * Extract the invoice/Pro number from an email subject.
 *
 * Exists because OCR invoice# for LTL freight is unreliable (pulls account
 * numbers like "3746570" or "==Start of OCR==..." garbage) — the SUBJECT is
 * the trustworthy identity. Uses the matched vendor's invoicePatterns in order
 * (first capture group that hits wins); falls back to the generic chain when
 * no vendor row matches or the vendor defines no patterns.
 *
 * @param from    - raw Gmail From header (vendor lookup)
 * @param subject - raw email subject
 * @returns the raw numeric invoice number string, or undefined when no pattern hits
 */
export function extractInvoiceNumber(from: string, subject: string): string | undefined {
    const pattern = matchVendorInvoicePattern(from);
    const patterns =
        pattern?.invoicePatterns && pattern.invoicePatterns.length > 0
            ? pattern.invoicePatterns
            : GENERIC_INVOICE_PATTERNS;
    const s = (subject || "").trim();
    for (const re of patterns) {
        const m = s.match(re);
        if (m) return m[1];
    }
    return undefined;
}

/**
 * Derive the canonical vendor name from a From header for DB dedup gating.
 * Mirrors the historical deriveVendorName mapping (aaacooper/cooper
 * transportation → AAA Cooper Transportation; beltpower → Belt Power) via the
 * declarative table, so a new vendor row automatically gets its canonical name.
 *
 * @param from - raw Gmail From header
 * @returns the canonical vendor name, or undefined for unknown senders
 */
export function deriveCanonicalVendorName(from: string): string | undefined {
    return matchVendorInvoicePattern(from)?.canonicalName;
}

/**
 * Decide whether an email is a BUNDLE/correspondence rather than one invoice.
 *
 * Rules, in order:
 *   1. Vendor defines individualSubjectPatterns ⇒ ONLY subjects matching one of
 *      them are single invoices; everything else is a bundle. (This exact rule
 *      is what stopped the AAA Cooper "Multiple Copies" duplicates in Bill.com.)
 *   2. Vendor defines bundleSubjectPatterns ⇒ a subject matching any is a bundle.
 *   3. Generic bundle signatures (Account <digits> - / Correspondence) apply to
 *      ALL vendors, matched or not.
 *
 * @param from    - raw Gmail From header (vendor lookup)
 * @param subject - raw email subject
 * @returns true when the email should be treated as a bundle (skip), false when
 *          it is an individual invoice (forward)
 */
export function isBundleEmail(from: string, subject: string): boolean {
    const pattern = matchVendorInvoicePattern(from);
    const s = (subject || "").trim();

    // individualSubjectPatterns present ⇒ anything not matching is a bundle.
    if (pattern?.individualSubjectPatterns && pattern.individualSubjectPatterns.length > 0) {
        return !pattern.individualSubjectPatterns.some((re) => re.test(s));
    }

    // Vendor-specific bundle signatures (vendors without an individual-only rule).
    if (pattern?.bundleSubjectPatterns?.some((re) => re.test(s))) {
        return true;
    }

    // Generic bundle signatures apply to ALL vendors.
    return GENERIC_BUNDLE_SUBJECT_PATTERNS.some((re) => re.test(s));
}
