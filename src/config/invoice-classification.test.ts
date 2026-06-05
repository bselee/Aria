/**
 * @file    src/config/invoice-classification.test.ts
 * @purpose Comprehensive vitest tests for the single-source-of-truth
 *          invoice classification module. Covers:
 *            - Dropship vendor keyword matching (vendorName, fromEmail)
 *            - Real invoice overrides (ULINE wins over dropship)
 *            - QuickBooks AND gate (sender + subjectRequired)
 *            - QuickBooks with no subject match (falls through)
 *            - Fallback to real_invoice when vendor or email present
 *            - Unknown state when no data available
 *            - Case insensitivity on all matchers
 *            - Ferticell vs 'fert' false-positive guard
 *            - isDropshipFlowThrough convenience function
 *            - needsAnalysis convenience function
 *            - Edge cases: null/undefined inputs, domain matching
 * @author  Hermia
 * @created 2026-06-05
 * @deps    vitest, @/config/invoice-classification
 *
 * Run: npx vitest run src/config/invoice-classification.test.ts
 */

import { classifyInvoice, isDropshipFlowThrough, needsAnalysis } from "@/config/invoice-classification";
import { describe, it, expect } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Shorthand to reduce boilerplate in assertions

const dropship = "dropship_flow_through";
const real = "real_invoice";
const unknown = "unknown";

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe("classifyInvoice — Dropship Vendor Keyword Match", () => {
    it.each([
        { label: "AutoPot by vendorName",                 input: { vendorName: "AutoPot" } },
        { label: "AutoPot by vendorName lowercase",       input: { vendorName: "autopot" } },
        { label: "AutoPot via email containing 'autopot' does NOT match (no senderKeyword rule)", input: { fromEmail: "autopot@somewhere.com" }, expectDropship: false },
        { label: "Logan Labs by vendorName",              input: { vendorName: "Logan Labs" } },
        { label: "Logan Labs by vendorName short",        input: { vendorName: "loganlab" } },
        { label: "Logan Labs via email domain does NOT match (no senderDomain rule)", input: { fromEmail: "orders@loganlabs.com" }, expectDropship: false },
        { label: "Evergreen Growers by vendorName",       input: { vendorName: "Evergreen Growers" } },
        { label: "Evergreen Growers by vendorName short", input: { vendorName: "evergreengrow" } },
        { label: "Abel by vendorName",                    input: { vendorName: "Abel" } },
        { label: "Abel by fromEmail does NOT match (no senderKeyword rule)", input: { fromEmail: "abel@aces.com" }, expectDropship: false },
        { label: "AbelsAces short",                       input: { vendorName: "abelsace" } },
        { label: "Ferticell by vendorName",               input: { vendorName: "Ferticell" } },
        { label: "Ferticell by fromEmail does NOT match (no senderKeyword rule)", input: { fromEmail: "billing@ferticell.com" }, expectDropship: false },
    ])("$label → $expectDropship", ({ input, expectDropship }) => {
        const result = classifyInvoice(input);
        const isDropship = expectDropship !== false;
        expect(result.classification).toBe(isDropship ? dropship : real);
        if (isDropship) {
            expect(result.reason).toBeTruthy();
            expect(result.matchedRule).toBeTruthy();
        }
    });
});

describe("classifyInvoice — Real Invoice Overrides (ULINE)", () => {
    it("ULINE by vendorName overrides any dropship", () => {
        const result = classifyInvoice({ vendorName: "Uline" });
        expect(result.classification).toBe(real);
        expect(result.reason).toContain("Override");
        expect(result.matchedRule).toContain("ULINE");
    });

    it("ULINE by vendorName mixed case still matches", () => {
        const result = classifyInvoice({ vendorName: "ULINE" });
        expect(result.classification).toBe(real);
    });

    it("ULINE by vendorName even if subject also looks dropship", () => {
        // Subject matches autopot which would be dropship, but ULINE override wins
        const result = classifyInvoice({ vendorName: "Uline", subject: "autopot order" });
        expect(result.classification).toBe(real);
        expect(result.reason).toContain("Override");
    });

    it("ULINE by vendorName even if fromEmail contains quickbooks", () => {
        const result = classifyInvoice({ vendorName: "Uline", fromEmail: "quickbooks@notification.intuit.com" });
        expect(result.classification).toBe(real);
        expect(result.reason).toContain("Override");
    });
});

describe("classifyInvoice — QuickBooks AND Gate", () => {
    it("QuickBooks sender + subject 'logan labs' → dropship", () => {
        const result = classifyInvoice({
            fromEmail: "quickbooks@notification.intuit.com",
            subject: "Invoice from Logan Labs",
        });
        expect(result.classification).toBe(dropship);
        expect(result.matchedRule).toContain("Logan Labs");
    });

    it("QuickBooks sender + subject 'autopot' → dropship", () => {
        const result = classifyInvoice({
            fromEmail: "quickbooks@notification.intuit.com",
            subject: "autopot order #12345",
        });
        expect(result.classification).toBe(dropship);
        expect(result.matchedRule).toContain("AutoPot");
    });

    it("QuickBooks sender + subject 'fert' → dropship (Ferticell via QB)", () => {
        const result = classifyInvoice({
            fromEmail: "quickbooks@notification.intuit.com",
            subject: "fert invoice",
        });
        expect(result.classification).toBe(dropship);
        expect(result.matchedRule).toContain("Ferticell");
    });

    it("QuickBooks sender + no matching subject → falls through (no dropship)", () => {
        const result = classifyInvoice({
            fromEmail: "quickbooks@notification.intuit.com",
            subject: "random vendor statement",
        });
        // No dropship rule matches — falls to real_invoice fallback (vendor absent but email present)
        expect(result.classification).toBe(real);
    });

    it("QuickBooks sender + subject 'fert' multiple times still works", () => {
        const result = classifyInvoice({
            fromEmail: "quickbooks@notification.intuit.com",
            subject: "Your Fert order has shipped (FERT-789)",
        });
        expect(result.classification).toBe(dropship);
    });
});

describe("classifyInvoice — Ferticell vs 'fert' false-positive guard", () => {
    it("Vendor 'Fertilizer Co' is NOT matched by 'fert' keyword (no 'fert' vendor rule)", () => {
        // There is no vendorKeyword: 'fert' in DROPSHIP_RULES — only 'ferticell'.
        // 'Fertilizer' does NOT contain 'ferticell' as substring.
        const result = classifyInvoice({ vendorName: "Fertilizer Co" });
        expect(result.classification).toBe(real); // falls through to real_invoice
        expect(result.reason).not.toContain("fert");
    });

    it("Vendor 'Fertility Plus' is NOT matched by 'fert' keyword", () => {
        const result = classifyInvoice({ vendorName: "Fertility Plus" });
        expect(result.classification).toBe(real);
    });

    it("Vendor 'Ferticell' still matches via full keyword", () => {
        const result = classifyInvoice({ vendorName: "Ferticell international" });
        expect(result.classification).toBe(dropship);
    });
});

describe("classifyInvoice — Fallback to real_invoice", () => {
    it("Unknown vendor with email → real_invoice", () => {
        const result = classifyInvoice({
            vendorName: "Some Unknown Co",
            fromEmail: "billing@unknownco.com",
        });
        expect(result.classification).toBe(real);
        expect(result.reason).toContain("No dropship rules matched");
    });

    it("Vendor present but not dropship → real_invoice", () => {
        const result = classifyInvoice({ vendorName: "Home Depot" });
        expect(result.classification).toBe(real);
    });

    it("Email present but not dropship → real_invoice", () => {
        const result = classifyInvoice({ fromEmail: "vendor@gmail.com" });
        expect(result.classification).toBe(real);
    });

    it("Subject present but no vendor/email → unknown (subject alone doesn't trigger fallback)", () => {
        // The fallback checks vendor || email — subject is not included
        const result = classifyInvoice({ subject: "some invoice" });
        expect(result.classification).toBe(unknown);
    });

    it("Filename present but no vendor/email → unknown (filename not in fallback check)", () => {
        const result = classifyInvoice({ filename: "invoice.pdf" });
        expect(result.classification).toBe(unknown);
    });
});

describe("classifyInvoice — Unknown state", () => {
    it("No data at all → unknown", () => {
        const result = classifyInvoice({});
        expect(result.classification).toBe(unknown);
        expect(result.reason).toContain("Insufficient data");
    });

    it("All nulls → unknown", () => {
        const result = classifyInvoice({
            vendorName: null,
            fromEmail: null,
            subject: null,
            filename: null,
        });
        expect(result.classification).toBe(unknown);
    });

    it("All undefined → unknown", () => {
        const result = classifyInvoice({});
        expect(result.classification).toBe(unknown);
    });

    it("Empty strings → unknown", () => {
        const result = classifyInvoice({
            vendorName: "",
            fromEmail: "",
            subject: "",
            filename: "",
        });
        expect(result.classification).toBe(unknown);
    });
});

describe("classifyInvoice — Case insensitivity", () => {
    it("Vendor 'AUTOPOT' all caps matches dropship", () => {
        const result = classifyInvoice({ vendorName: "AUTOPOT" });
        expect(result.classification).toBe(dropship);
    });

    it("Vendor 'AuToPoT' mixed case matches dropship", () => {
        const result = classifyInvoice({ vendorName: "AuToPoT Supplies" });
        expect(result.classification).toBe(dropship);
    });

    it("Email 'QUICKBOOKS@INTUIT.COM' all caps matches", () => {
        const result = classifyInvoice({
            fromEmail: "QUICKBOOKS@INTUIT.COM",
            subject: "AUTOPOT ORDER",
        });
        expect(result.classification).toBe(dropship);
    });

    it("Subject 'INVOICE FROM LOGAN LABS' all caps matches QuickBooks rule", () => {
        const result = classifyInvoice({
            fromEmail: "quickbooks@intuit.com",
            subject: "INVOICE FROM LOGAN LABS",
        });
        expect(result.classification).toBe(dropship);
    });

    it("Vendor 'ULINE' all caps matches real_invoice override", () => {
        const result = classifyInvoice({ vendorName: "ULINE" });
        expect(result.classification).toBe(real);
    });
});

describe("classifyInvoice — Edge cases", () => {
    it("Vendor 'Mabel' contains substring 'abel' → IS matched by dropship rule (documented behavior)", () => {
        // vendorKeyword 'abel' IS a substring of 'mabel', so this matches.
        // Known edge case: 'abil' or other names ending in 'abel' would also match.
        const result = classifyInvoice({ vendorName: "Mabel's Supplies" });
        expect(result.classification).toBe(dropship);
    });

    it("Email 'SALES@LOGANLABS.COM' all caps → falls to real_invoice (no senderDomain/senderKeyword rule for loganlabs)", () => {
        // No DROPSHIP_RULE has senderKeyword or senderDomain matching 'loganlabs.com'
        // So it falls through to real_invoice (email present → fallback)
        const result = classifyInvoice({ fromEmail: "SALES@LOGANLABS.COM" });
        expect(result.classification).toBe(real);
    });

    it("fromApInbox flag does not affect classification", () => {
        const resultTrue = classifyInvoice({ vendorName: "AutoPot", fromApInbox: true });
        const resultFalse = classifyInvoice({ vendorName: "AutoPot", fromApInbox: false });
        expect(resultTrue.classification).toBe(dropship);
        expect(resultFalse.classification).toBe(dropship);
    });

    it("Filename alone not enough for dropship match (no filename matching in rules)", () => {
        // There's no filename-based rule, so this should go to unknown
        const result = classifyInvoice({ filename: "autopot_invoice.pdf" });
        expect(result.classification).toBe(unknown);
    });

    it("Vendor with leading/trailing whitespace is trimmed", () => {
        const result = classifyInvoice({ vendorName: "  AutoPot  " });
        expect(result.classification).toBe(dropship);
    });
});

describe("classifyInvoice — Regression: real_invoice override wins over everything", () => {
    it("ULINE with both dropship vendorName and dropship fromEmail → still real_invoice", () => {
        const result = classifyInvoice({
            vendorName: "Uline",
            fromEmail: "autopot@somewhere.com",
            subject: "autopot order",
        });
        expect(result.classification).toBe(real);
    });

    it("ULINE with quickbooks email → still real_invoice", () => {
        const result = classifyInvoice({
            vendorName: "Uline",
            fromEmail: "quickbooks@notification.intuit.com",
        });
        expect(result.classification).toBe(real);
    });
});

// ─── Convenience Functions ────────────────────────────────────────────────────

describe("isDropshipFlowThrough", () => {
    it("returns true for dropship vendor", () => {
        expect(isDropshipFlowThrough({ vendorName: "AutoPot" })).toBe(true);
    });

    it("returns false for ULINE (real invoice override)", () => {
        expect(isDropshipFlowThrough({ vendorName: "Uline" })).toBe(false);
    });

    it("returns false for unknown vendor with email (real_invoice)", () => {
        expect(isDropshipFlowThrough({ vendorName: "Random Vendor" })).toBe(false);
    });

    it("returns false for empty input (unknown)", () => {
        expect(isDropshipFlowThrough({})).toBe(false);
    });

    it("returns true for QuickBooks AND gate match", () => {
        expect(isDropshipFlowThrough({
            fromEmail: "quickbooks@intuit.com",
            subject: "autopot order",
        })).toBe(true);
    });
});

describe("needsAnalysis", () => {
    it("returns true for ULINE (real invoice)", () => {
        expect(needsAnalysis({ vendorName: "Uline" })).toBe(true);
    });

    it("returns true for unknown vendor with email", () => {
        expect(needsAnalysis({ vendorName: "Home Depot" })).toBe(true);
    });

    it("returns false for dropship vendor", () => {
        expect(needsAnalysis({ vendorName: "AutoPot" })).toBe(false);
    });

    it("returns false for empty input (unknown)", () => {
        expect(needsAnalysis({})).toBe(false);
    });

    it("returns false for QuickBooks AND gate match (dropship)", () => {
        expect(needsAnalysis({
            fromEmail: "quickbooks@intuit.com",
            subject: "logan labs invoice",
        })).toBe(false);
    });
});

// ─── Combined pipeline scenarios ──────────────────────────────────────────────

describe("classifyInvoice — Full resolution order", () => {
    // Verify the ordering: RealInvoiceOverrides > DropshipRules > Fallback > Unknown

    it("Step 1: RealInvoiceOverrides win — ULINE", () => {
        const r = classifyInvoice({ vendorName: "Uline" });
        expect(r.classification).toBe(real);
        expect(r.matchedRule).toContain("ULINE");
    });

    it("Step 2: DropshipRules match — AutoPot", () => {
        const r = classifyInvoice({ vendorName: "AutoPot" });
        expect(r.classification).toBe(dropship);
        expect(r.matchedRule).toContain("AutoPot");
    });

    it("Step 3: Fallback with vendor/email → real_invoice", () => {
        const r = classifyInvoice({ vendorName: "Some Vendor" });
        expect(r.classification).toBe(real);
        expect(r.reason).toContain("No dropship rules matched");
    });

    it("Step 4: No data → unknown", () => {
        const r = classifyInvoice({});
        expect(r.classification).toBe(unknown);
        expect(r.reason).toContain("Insufficient data");
    });
});
