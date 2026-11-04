/**
 * @file    invoice-po-matcher.test.ts
 * @purpose Tests for invoice-po-matcher alias resolution flow + Tier A
 *          high-confidence auto-match (exact OCR PO match, unique
 *          vendor+amount±2%+date±14d).
 *
 *          Uses vi.mock at the top level to control DB behavior without
 *          hitting live PostgREST.
 * @author  Hermia
 * @created 2026-07-27
 */
// ── Mock @/lib/db BEFORE importing the module under test ───────────────────
// vi.mock is hoisted by vitest; mock variables must use vi.hoisted or let/var.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFrom, createChain } = vi.hoisted(() => {
    function createChain(finalData: { data: any; error: any } = { data: [], error: null }) {
        const chain: any = {
            select: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue(finalData),
        };
        chain.then = (resolve: any, reject: any) =>
            Promise.resolve(finalData).then(resolve, reject);
        return chain;
    }
    return { mockFrom: vi.fn(), createChain };
});

vi.mock("@/lib/db", () => ({
    createClient: () => ({
        from: (...args: any[]) => mockFrom(...args),
    }),
}));

// invoice-po-matcher imports Finale + reconciler; mock to prevent live I/O
vi.mock("@/lib/finale/client", () => ({ FinaleClient: class {} }));
vi.mock("@/lib/finale/reconciler", () => ({
    reconcileInvoiceToPO: vi.fn(),
    applyReconciliation: vi.fn(),
    buildReconciliationIdentityMetadata: vi.fn(),
}));
vi.mock("@/lib/purchasing/po-lifecycle", () => ({
    transitionLifecycleState: vi.fn(),
}));
vi.mock("@/lib/purchasing/vendor-name-normalize", async (importOriginal) => {
    // Use the REAL pure functions (normalizeVendorName / normalizeVendorKey)
    // so the suffix/punctuation-drift fix is actually exercised; only the
    // DB-backed alias resolution is stubbed.
    const actual = await importOriginal<typeof import("@/lib/purchasing/vendor-name-normalize")>();
    return {
        ...actual,
        resolveCanonicalVendor: () => null,
        loadVendorAliases: vi.fn().mockResolvedValue([]),
    };
});

// Mock finale modules to prevent transitive loading of tracking modules
// with live I/O side effects.
vi.mock("@/lib/finale/client", () => ({ FinaleClient: vi.fn() }));
vi.mock("@/lib/finale/reconciler", () => ({
    reconcileInvoiceToPO: vi.fn(),
    applyReconciliation: vi.fn(),
    buildReconciliationIdentityMetadata: vi.fn(),
}));
vi.mock("@/lib/purchasing/po-lifecycle", () => ({ transitionLifecycleState: vi.fn() }));

// These modules must be imported AFTER the vi.mock calls
import {
    findPOCandidates,
    tryHighConfidenceAutoMatch,
    sanitizeOcrPoCandidate,
    type InvoiceToMatch,
    type POCandidate,
    type HighConfidenceDecision,
} from "./invoice-po-matcher";

// Re-import from the sanitize module for direct testing
// (the re-export via invoice-po-matcher barrel works too)

// ── Helper ──────────────────────────────────────────────────────────────────

function makeInvoice(overrides: Partial<InvoiceToMatch> = {}): InvoiceToMatch {
    return {
        id: "inv-test",
        invoiceNumber: "INV-TEST",
        vendorName: "TestCo",
        invoiceDate: "2026-07-15",
        subtotal: 100,
        freight: 0,
        tax: 0,
        total: 100,
        ...overrides,
    };
}


function stubDbForPoSearch(pos: any[], confirmed: any[] = []) {
    mockFrom.mockImplementation((table: string) => {
        if (table === "confirmed_po_matches") return createChain({ data: confirmed, error: null });
        if (table === "vendor_aliases") return createChain({ data: [], error: null });
        if (table === "purchase_orders") return createChain({ data: pos, error: null });
        return createChain({ data: [], error: null });
    });
}

function makePO(overrides: Partial<POCandidate> = {}): POCandidate {
    return {
        orderId: "PO-001",
        vendorName: "TestCo",
        orderDate: "2026-07-15",
        total: 100,
        status: "open",
        score: 0,
        reasons: [],
        isOpen: true,
        ...overrides,
    };
}

// ── sanitizeOcrPoCandidate ──────────────────────────────────────────────────

describe("sanitizeOcrPoCandidate", () => {
    it("strips PO prefix: PO124813 → 124813", () => {
        expect(sanitizeOcrPoCandidate("PO124813")).toBe("124813");
    });

    it("strips P.O. prefix: P.O.124813 → 124813", () => {
        expect(sanitizeOcrPoCandidate("P.O.124813")).toBe("124813");
    });

    it("strips # prefix only when the number is a real PO shape", () => {
        expect(sanitizeOcrPoCandidate("# 125257")).toBe("125257");
    });

    it("strips Ref prefix: Ref #124813 → 124813", () => {
        expect(sanitizeOcrPoCandidate("Ref #124813")).toBe("124813");
    });

    it("extracts embedded PO from compound: 71486681-1124705 → 124705", () => {
        // 7-digit "1124705" starts with "11", strip one leading 1 → "124705"
        expect(sanitizeOcrPoCandidate("71486681-1124705")).toBe("124705");
    });

    it("returns null for NEED PO patterns", () => {
        expect(sanitizeOcrPoCandidate("NEED PO 03/20/26")).toBeNull();
        expect(sanitizeOcrPoCandidate("NEED PO")).toBeNull();
    });

    it("returns null for SEE BELOW", () => {
        expect(sanitizeOcrPoCandidate("SEE BELOW")).toBeNull();
    });

    it("returns null for BUILMOCO", () => {
        expect(sanitizeOcrPoCandidate("BUILMOCO")).toBeNull();
    });

    it("returns null for null/undefined input", () => {
        expect(sanitizeOcrPoCandidate(null)).toBeNull();
        expect(sanitizeOcrPoCandidate(undefined)).toBeNull();
    });

    it("returns null for pure letters as company name", () => {
        expect(sanitizeOcrPoCandidate("FEDEX")).toBeNull();
        expect(sanitizeOcrPoCandidate("AMAZON")).toBeNull();
    });

    it("accepts plain 6-digit PO numbers", () => {
        expect(sanitizeOcrPoCandidate("124813")).toBe("124813");
        expect(sanitizeOcrPoCandidate("125137")).toBe("125137");
    });

    it("rejects numbers that are not a Finale PO shape", () => {
        // 8-digit tracking tails, account numbers, and phone numbers used to pass.
        expect(sanitizeOcrPoCandidate("23324007")).toBeNull();
        expect(sanitizeOcrPoCandidate("23514987")).toBeNull();
        expect(sanitizeOcrPoCandidate("9897269125")).toBeNull();
        expect(sanitizeOcrPoCandidate("QTY")).toBeNull();
    });

    it("accepts the 9-digit DropshipPO shape", () => {
        const v = sanitizeOcrPoCandidate("123514987-DropshipPO");
        expect(v === "123514987" || v === "123514987-DropshipPO").toBe(true);
    });
});

// ── tryHighConfidenceAutoMatch (pure function) ─────────────────────────────

describe("tryHighConfidenceAutoMatch", () => {
    it("returns null when candidates are empty", () => {
        const inv = makeInvoice({ ocrPoCandidate: "PO124813" });
        const result = tryHighConfidenceAutoMatch(inv, []);
        expect(result).toBeNull();
    });

    it("returns null when invoice total is $0", () => {
        const inv = makeInvoice({ total: 0, ocrPoCandidate: "124813" });
        const candidates = [makePO({ orderId: "124813" })];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).toBeNull();
    });

    it("finds exact OCR PO match among candidates (Tier A-1)", () => {
        const inv = makeInvoice({ ocrPoCandidate: "PO124813" });
        const candidates = [
            makePO({ orderId: "124813", score: 70, reasons: ["vendor match"] }),
            makePO({ orderId: "124999", score: 60, reasons: ["vendor match"] }),
        ];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).not.toBeNull();
        expect(result!.poNumber).toBe("124813");
        expect(result!.score).toBe(100);
        expect(result!.tier).toBe("exact_ocr");
        expect(result!.reason).toContain("124813");
    });

    it("finds exact OCR match via ocrOrderCandidate as fallback", () => {
        const inv = makeInvoice({
            ocrPoCandidate: null,
            ocrOrderCandidate: "PO124813",
        });
        const candidates = [makePO({ orderId: "124813" })];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).not.toBeNull();
        expect(result!.poNumber).toBe("124813");
        expect(result!.tier).toBe("exact_ocr");
    });

    it("returns null when sanitized OCR doesn't match and amount/date are not unique-tight", () => {
        const inv = makeInvoice({ ocrPoCandidate: "PO999999", total: 100, invoiceDate: "2026-07-15" });
        // Amount far from candidate; date far — no Tier A-2 either
        const candidates = [makePO({ orderId: "124813", total: 9999, orderDate: "2025-01-01", score: 40 })];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).toBeNull();
    });

    it("finds unique vendor+amount±2%+date±14d (Tier A-2)", () => {
        const inv = makeInvoice({
            vendorName: "TestCo",
            total: 100,
            invoiceDate: "2026-07-15",
        });
        const candidates = [
            makePO({
                orderId: "PO-001",
                vendorName: "TestCo",
                total: 100,
                orderDate: "2026-07-14",
                score: 70,
                reasons: ["vendor match"],
            }),
            makePO({
                orderId: "PO-002",
                vendorName: "OtherCo",
                total: 99,
                orderDate: "2026-07-01",
                score: 60,
                reasons: [],
            }),
        ];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).not.toBeNull();
        expect(result!.poNumber).toBe("PO-001");
        expect(result!.tier).toBe("unique_vendor_date");
        expect(result!.score).toBeGreaterThanOrEqual(90);
    });

    it("returns null when two candidates both meet tight criteria", () => {
        const inv = makeInvoice({
            vendorName: "TestCo",
            total: 100,
            invoiceDate: "2026-07-15",
        });
        // Both POs are from same vendor with very similar amounts/dates
        const candidates = [
            makePO({
                orderId: "PO-001",
                vendorName: "TestCo",
                total: 100,
                orderDate: "2026-07-14",
                score: 70,
            }),
            makePO({
                orderId: "PO-002",
                vendorName: "TestCo",
                total: 101,
                orderDate: "2026-07-16",
                score: 68,
            }),
        ];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).toBeNull();
    });

    it("returns null when vendor score < 30", () => {
        const inv = makeInvoice({
            vendorName: "UnrelatedCo",
            total: 100,
            invoiceDate: "2026-07-15",
        });
        const candidates = [
            makePO({
                orderId: "PO-001",
                vendorName: "CompletelyDifferent",
                total: 100,
                orderDate: "2026-07-14",
                score: 10,
            }),
        ];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).toBeNull();
    });

    it("returns null when date difference > 14 days", () => {
        const inv = makeInvoice({
            vendorName: "TestCo",
            total: 100,
            invoiceDate: "2026-07-15",
        });
        const candidates = [
            makePO({
                orderId: "PO-001",
                vendorName: "TestCo",
                total: 100.50,
                orderDate: "2026-01-15",
                score: 70,
            }),
        ];
        const result = tryHighConfidenceAutoMatch(inv, candidates);
        expect(result).toBeNull();
    });
});

// ── findPOCandidates with Tier A integration ─────────────────────────────────

describe("findPOCandidates with Tier A auto-match", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: empty confirmed_po_matches + empty PO list; tests override mockFrom
        mockFrom.mockImplementation((table: string) => {
            if (table === "confirmed_po_matches") return createChain({ data: [], error: null });
            if (table === "vendor_aliases") return createChain({ data: [], error: null });
            return createChain({ data: [], error: null });
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns autoApplyReady=true when exact OCR PO matches a candidate", async () => {
        const invoice: InvoiceToMatch = {
            id: "inv-ocr-1",
            invoiceNumber: "INV-OCR-001",
            vendorName: "Miles Filippelli",
            invoiceDate: "2026-07-15",
            subtotal: 500,
            freight: 25,
            tax: 0,
            total: 525,
            ocrPoCandidate: "PO124800",
        };

        stubDbForPoSearch([{
            po_number: "124800",
            vendor_name: "Miles Filippelli",
            issue_date: "2026-07-10",
            total_amount: null,
            total: 500,
            status: "open",
        }]);

        const result = await findPOCandidates(invoice);
        expect(result.autoApplyReady).toBe(true);
        expect(result.bestMatch).not.toBeNull();
        expect(result.bestMatch!.orderId).toBe("124800");
        expect(result.bestMatch!.score).toBe(100);
        const hasOcrReason = result.bestMatch!.reasons.some(r => r.includes("exact OCR PO match"));
        expect(hasOcrReason).toBe(true);
    });

    it("sets autoApplyReady=true for unique vendor+amount±2%+date±14d", async () => {
        const invoice: InvoiceToMatch = {
            id: "inv-tight",
            invoiceNumber: "INV-TIGHT-1",
            vendorName: "AutoPot USA",
            invoiceDate: "2026-07-16",
            subtotal: 500,
            freight: 0,
            tax: 0,
            total: 500,
        };

        stubDbForPoSearch([{
            po_number: "PO-AUTOPOT",
            vendor_name: "AutoPot USA",
            issue_date: "2026-07-14",
            total_amount: null,
            total: 500,
            status: "open",
        }, {
            // Second open PO so the 2026-10-28 single-open-PO fast path
            // (score 85, early return) does not short-circuit Tier A-2.
            // Outside the ±14d window, so it is not a tight candidate.
            po_number: "PO-AUTOPOT-OLD",
            vendor_name: "AutoPot USA",
            issue_date: "2026-06-01",
            total_amount: null,
            total: 900,
            status: "open",
        }]);

        const result = await findPOCandidates(invoice);
        // Score path alone can auto-apply (vendor+date+amount = 100), or Tier A-2 unique rule
        expect(result.autoApplyReady).toBe(true);
        expect(result.bestMatch!.score).toBeGreaterThanOrEqual(90);
        const hasTightReason = result.bestMatch!.reasons.some(
            r => r.includes("unique vendor") && r.includes("14d")
        );
        const highScore = result.bestMatch!.score >= 90;
        expect(hasTightReason || highScore).toBe(true);
    });

    it("keeps autoApplyReady=false when two POs both meet tight criteria", async () => {
        const invoice: InvoiceToMatch = {
            id: "inv-ambiguous",
            invoiceNumber: "INV-AMBIG-1",
            vendorName: "TestCo",
            invoiceDate: "2026-07-16",
            subtotal: 100,
            freight: 0,
            tax: 0,
            total: 100,
        };

        stubDbForPoSearch([
            {
                po_number: "PO-A",
                vendor_name: "TestCo",
                issue_date: "2026-07-14",
                total_amount: null,
                total: 100,
                status: "open",
            },
            {
                po_number: "PO-B",
                vendor_name: "TestCo",
                issue_date: "2026-07-15",
                total_amount: null,
                total: 101,
                status: "open",
            },
        ]);

        const result = await findPOCandidates(invoice);
        expect(result.autoApplyReady).toBe(false);
    });

    it("still boosts confirmed matches alongside Tier A logic", async () => {
        const invoice: InvoiceToMatch = {
            id: "inv-confirmed",
            invoiceNumber: "INV-CONFIRMED-1",
            vendorName: "Miles Filippelli",
            invoiceDate: "2026-07-20",
            subtotal: 500,
            freight: 25,
            tax: 0,
            total: 525,
        };

        stubDbForPoSearch([{
            po_number: "124800",
            vendor_name: "Miles Filippelli",
            issue_date: "2026-07-10",
            total_amount: null,
            // Must cover the $525 invoice or the confirmed-match cover guard
            // withholds the boost. A second open PO (unrelated vendor) keeps
            // the single-open-PO fast path from returning early at 85.
            total: 600,
            status: "open",
        }, {
            po_number: "PO-OTHER-1",
            vendor_name: "Unrelated Supply",
            issue_date: "2026-07-01",
            total_amount: null,
            total: 2000,
            status: "open",
        }], [{
            vendor_name: "Miles Filippelli",
            po_number: "124800",
        }]);

        const result = await findPOCandidates(invoice);
        expect(result.candidates.length).toBeGreaterThanOrEqual(1);
        const best = result.candidates[0];
        expect(best.score).toBeGreaterThanOrEqual(95);
        const hasConfirmedReason = best.reasons.some(r => r.includes("previously confirmed"));
        expect(hasConfirmedReason).toBe(true);
    });

    it("keeps the confirmed 95 when the vendor has exactly one open PO (2026-10-29)", async () => {
        // The fast path used to return early at 85, so the human-confirmed
        // vendor→PO pair never surfaced its 95 or its provenance for
        // bill-as-they-deliver vendors — the exact case where one open PO is
        // normal. The confirmed boost must win.
        const invoice: InvoiceToMatch = {
            id: "inv-confirmed-single",
            invoiceNumber: "INV-CONF-SINGLE",
            vendorName: "Miles Filippelli",
            invoiceDate: "2026-07-20",
            subtotal: 500,
            freight: 25,
            tax: 0,
            total: 525,
        };

        stubDbForPoSearch([{
            po_number: "124800",
            vendor_name: "Miles Filippelli",
            issue_date: "2026-07-10",
            total_amount: null,
            total: 600,
            status: "open",
        }], [{ vendor_name: "Miles Filippelli", po_number: "124800" }]);

        const result = await findPOCandidates(invoice);
        expect(result.bestMatch!.orderId).toBe("124800");
        expect(result.bestMatch!.score).toBeGreaterThanOrEqual(95);
        expect(result.bestMatch!.reasons.some(r => r.includes("previously confirmed"))).toBe(true);
        expect(result.bestMatch!.matchMethod).toBe("confirmed");
        expect(result.autoApplyReady).toBe(true);
    });

    it("upgrades a single open PO to the Tier A 90 and names the reason", async () => {
        const invoice: InvoiceToMatch = {
            id: "inv-tight-single",
            invoiceNumber: "INV-TIGHT-SINGLE",
            vendorName: "AutoPot USA",
            invoiceDate: "2026-07-16",
            subtotal: 500,
            freight: 0,
            tax: 0,
            total: 500,
        };

        stubDbForPoSearch([{
            po_number: "PO-AUTOPOT",
            vendor_name: "AutoPot USA",
            issue_date: "2026-07-14",
            total_amount: null,
            total: 500,
            status: "open",
        }]);

        const result = await findPOCandidates(invoice);
        expect(result.bestMatch!.orderId).toBe("PO-AUTOPOT");
        expect(result.bestMatch!.score).toBeGreaterThanOrEqual(90);
        expect(result.bestMatch!.reasons.some(r => r.includes("unique vendor") && r.includes("14d"))).toBe(true);
        expect(result.autoApplyReady).toBe(true);
    });

    it("still auto-applies the single open PO when no scoring tier reaches it", async () => {
        // 37 days apart (date 6) + exact vendor (40) = 46, under the 50
        // suggestion bar, so the scored loop drops the PO entirely; Tier A
        // needs ≤14d; the covering rule needs the PO to cover $525 and it is
        // only $400. The single-open-PO guarantee has to carry the link at 85.
        const invoice: InvoiceToMatch = {
            id: "inv-fastpath-only",
            invoiceNumber: "INV-FP-ONLY",
            vendorName: "New Moon",
            invoiceDate: "2026-08-20",
            subtotal: 525,
            freight: 0,
            tax: 0,
            total: 525,
        };

        stubDbForPoSearch([{
            po_number: "124900",
            vendor_name: "New Moon",
            issue_date: "2026-07-14",
            total_amount: null,
            total: 400,
            status: "open",
        }]);

        const result = await findPOCandidates(invoice);
        expect(result.bestMatch!.orderId).toBe("124900");
        expect(result.bestMatch!.score).toBe(85);
        expect(result.bestMatch!.reasons.some(r => r.includes("single open PO"))).toBe(true);
        expect(result.autoApplyReady).toBe(true);
    });

    it("does not let a confirmed match boost an invoice dated before the PO exists (2026-10-27)", async () => {
        // Rootwise freight bills dated 2025-03 → 2026-04 rode the
        // Rootwise→125080 confirm to 95 while the PO was issued 2026-07-13.
        const invoice: InvoiceToMatch = {
            id: "inv-predate",
            invoiceNumber: "772769286160",
            vendorName: "Rootwise Soil Dynamics",
            invoiceDate: "2026-04-14",
            subtotal: 369.2,
            freight: 0,
            tax: 0,
            total: 369.2,
        };

        stubDbForPoSearch([{
            po_number: "125080",
            vendor_name: "Rootwise Soil Dynamics",
            issue_date: "2026-07-13",
            total_amount: 4141.09,
            total: 4141.09,
            status: "received",
        }], [{
            vendor_name: "Rootwise Soil Dynamics",
            po_number: "125080",
        }]);

        const result = await findPOCandidates(invoice);
        const best = result.candidates[0];
        const hasConfirmedReason = best?.reasons?.some((r: string) => r.includes("previously confirmed")) ?? false;
        expect(hasConfirmedReason).toBe(false);
        expect(best?.score ?? 0).toBeLessThan(95);
    });

    it("does not let a confirmed match take an invoice its PO cannot cover", async () => {
        // Ferticell invoice 2907 ($7,243.02) against the two Ferticell POs open
        // that day: 124904 ($7,353.28, ordered 1 day before) and 124857
        // ($4,682.08, ordered 16 days before, already invoice 2880's PO and
        // human-confirmed for the vendor from 2880's approval).
        const invoice: InvoiceToMatch = {
            id: "inv-2907",
            invoiceNumber: "2907",
            vendorName: "Ferticell",
            invoiceDate: "2026-06-11",
            subtotal: 6922.96,
            freight: 320.06,
            tax: 0,
            total: 7243.02,
        };

        stubDbForPoSearch([
            {
                po_number: "124904",
                vendor_name: "Ferticell",
                issue_date: "2026-06-10",
                total_amount: 7353.28,
                total: null,
                status: "received",
            },
            {
                po_number: "124857",
                vendor_name: "Ferticell",
                issue_date: "2026-05-26",
                total_amount: 4682.08,
                total: null,
                status: "received",
            },
        ], [{
            vendor_name: "Ferticell",
            po_number: "124857",
        }]);

        const result = await findPOCandidates(invoice);

        expect(result.autoApplyReady).toBe(true);
        expect(result.bestMatch!.orderId).toBe("124904");
        const shortPo = result.candidates.find(c => c.orderId === "124857");
        expect(shortPo).toBeDefined();
        expect(shortPo!.reasons.some(r => r.includes("previously confirmed"))).toBe(false);
        expect(shortPo!.score).toBeLessThan(90);
    });

    it("does not let a confirmed match steal the link from a stale PO outside the date window (2026-11-04)", async () => {
        // Colorado Worm invoice 19500 ($2000, Nov 2) belongs to the NEWER open
        // PO 125467 (Nov 3), not the human-confirmed 124424 (Mar 1, 8 months
        // stale). The confirmed boost must not cross the date window.
        const invoice: InvoiceToMatch = {
            id: "inv-19500",
            invoiceNumber: "19500",
            vendorName: "Colorado Worm Company",
            invoiceDate: "2026-11-02",
            subtotal: 2000,
            freight: 0,
            tax: 0,
            total: 2000,
        };

        stubDbForPoSearch([
            {
                po_number: "125467",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-03",
                total_amount: 9000,
                total: 9000,
                status: "Committed",
            },
            {
                po_number: "124424",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-03-01",
                total_amount: 8400,
                total: 8400,
                status: "received",
            },
        ], [{
            vendor_name: "Colorado Worm Company",
            po_number: "124424",
        }]);

        const result = await findPOCandidates(invoice);

        // The stale confirmed PO is dropped; the date-correct open PO wins.
        expect(result.bestMatch!.orderId).toBe("125467");
        expect(result.candidates.some(c => c.orderId === "124424")).toBe(false);
    });

    it("auto-applies by unit price when the invoice has no SKU or printed PO (Colorado Worm 19500 → 125467)", async () => {
        // Colorado Worm 19500 ($2000 = 100 x $20, Nov 2). Three open POs at
        // three different unit prices; the $20 line identifies 125467.
        const invoice: InvoiceToMatch = {
            id: "inv-19500",
            invoiceNumber: "19500",
            vendorName: "Colorado Worm Company",
            invoiceDate: "2026-11-02",
            subtotal: 2000,
            freight: 0,
            tax: 0,
            total: 2000,
            lineItems: [{ qty: 100, unit_price: 20 }],
        };

        stubDbForPoSearch([
            {
                po_number: "125467",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-03",
                total_amount: 9000,
                total: 9000,
                status: "Committed",
                line_items: [{ quantity: "450", productId: "COWOCO2", unitPrice: 20, remainingQty: 450 }],
            },
            {
                po_number: "125450",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-10-28",
                total_amount: 3250,
                total: 3250,
                status: "Committed",
                line_items: [{ quantity: "325", productId: "COWOCO1", unitPrice: 10, remainingQty: 325 }],
            },
            {
                po_number: "125441",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-10-15",
                total_amount: 8000,
                total: 8000,
                status: "Committed",
                line_items: [{ quantity: "200", productId: "COWOCO3", unitPrice: 40, remainingQty: 200 }],
            },
            {
                po_number: "125411",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-10-15",
                total_amount: 4500,
                total: 4500,
                status: "Committed",
                line_items: [{ quantity: "225", productId: "COWOCO2", unitPrice: 20, remainingQty: 0 }],
            },
        ]);

        const result = await findPOCandidates(invoice);

        expect(result.bestMatch!.orderId).toBe("125467");
        expect(result.bestMatch!.matchMethod).toBe("unit_price_exact");
        expect(result.autoApplyReady).toBe(true);
    });

    it("does not auto-apply when the unit price recurs across two open POs", async () => {
        // Same $20 price on two POs — the price is ambiguous, so a human picks.
        const invoice: InvoiceToMatch = {
            id: "inv-amb",
            invoiceNumber: "AMB",
            vendorName: "Colorado Worm Company",
            invoiceDate: "2026-11-02",
            subtotal: 1000,
            freight: 0,
            tax: 0,
            total: 1000,
            lineItems: [{ qty: 50, unit_price: 20 }],
        };

        stubDbForPoSearch([
            {
                po_number: "125467",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-03",
                total_amount: 9000,
                total: 9000,
                status: "Committed",
                line_items: [{ quantity: "450", productId: "COWOCO2", unitPrice: 20, remainingQty: 450 }],
            },
            {
                po_number: "125999",
                vendor_name: "Colorado Worm Company",
                issue_date: "2026-11-05",
                total_amount: 2000,
                total: 2000,
                status: "Committed",
                line_items: [{ quantity: "100", productId: "COWOCO2B", unitPrice: 20, remainingQty: 100 }],
            },
        ]);

        const result = await findPOCandidates(invoice);

        expect(result.autoApplyReady).toBe(false);
    });

    it("auto-applies a Miles invoice by description→SKU (Peach Half Gallon → 125465)", async () => {
        // Miles bills by description, no SKU. "Peach Half Gallon" resolves to
        // BASLPEE103; the open PO 125465 carries it with remaining qty, while
        // the received 125261 carries it at remainingQty 0.
        const invoice: InvoiceToMatch = {
            id: "inv-miles-peach",
            invoiceNumber: "INV-MILES",
            vendorName: "Miles Filippelli",
            invoiceDate: "2026-11-02",
            subtotal: 650,
            freight: 0,
            tax: 0,
            total: 650,
            lineItems: [{ qty: 50, sku: "", unit_price: 13, description: "Peach Half Gallon" }],
        };

        stubDbForPoSearch([
            {
                po_number: "125465",
                vendor_name: "Miles Filippelli",
                issue_date: "2026-11-02",
                total_amount: 2600,
                total: 2600,
                status: "Committed",
                line_items: [
                    { quantity: "100", productId: "BASLPEE103", unitPrice: 13, remainingQty: 100 },
                    { quantity: "40", productId: "BASLHE105", unitPrice: 13, remainingQty: 40 },
                ],
            },
            {
                po_number: "125261",
                vendor_name: "Miles Filippelli",
                issue_date: "2026-09-02",
                total_amount: 1980,
                total: 1980,
                status: "received",
                line_items: [
                    { quantity: "50", productId: "BASLPEE103", unitPrice: 13, remainingQty: 0 },
                ],
            },
        ]);

        const result = await findPOCandidates(invoice);

        expect(result.bestMatch!.orderId).toBe("125465");
        expect(result.bestMatch!.matchMethod).toBe("description_sku");
        expect(result.autoApplyReady).toBe(true);
    });

    it("does not fall through to price for a Miles line whose SKU is on no open PO", async () => {
        // "watermelon half gallon" resolves to FWE101, which is NOT on 125465
        // (peach/hemp/comfrey/nettle). The $13 price WOULD match 125465, but a
        // Miles price match is meaningless — never auto-apply it.
        const invoice: InvoiceToMatch = {
            id: "inv-miles-watermelon",
            invoiceNumber: "INV-MILES-WM",
            vendorName: "Miles Filippelli",
            invoiceDate: "2026-11-02",
            subtotal: 390,
            freight: 0,
            tax: 0,
            total: 390,
            lineItems: [{ qty: 30, sku: "", unit_price: 13, description: "watermelon half gallon" }],
        };

        stubDbForPoSearch([
            {
                po_number: "125465",
                vendor_name: "Miles Filippelli",
                issue_date: "2026-11-02",
                total_amount: 2600,
                total: 2600,
                status: "Committed",
                line_items: [
                    { quantity: "100", productId: "BASLPEE103", unitPrice: 13, remainingQty: 100 },
                ],
            },
        ]);

        const result = await findPOCandidates(invoice);

        expect(result.autoApplyReady).toBe(false);
    });

    it("exact OCR match takes priority over confirmed match", async () => {
        const invoice: InvoiceToMatch = {
            id: "inv-priority",
            invoiceNumber: "INV-PRIORITY",
            vendorName: "Miles Filippelli",
            invoiceDate: "2026-07-20",
            subtotal: 500,
            freight: 25,
            tax: 0,
            total: 525,
            ocrPoCandidate: "PO124813", // OCR says different PO than confirmed
        };

        stubDbForPoSearch([
            {
                po_number: "124813",
                vendor_name: "Miles Filippelli",
                issue_date: "2026-07-10",
                total_amount: null,
                total: 500,
                status: "open",
            },
            {
                po_number: "124800",
                vendor_name: "Miles Filippelli",
                issue_date: "2026-07-05",
                total_amount: null,
                total: 520,
                status: "open",
            },
        ], [{
            vendor_name: "Miles Filippelli",
            po_number: "124800",
        }]);

        const result = await findPOCandidates(invoice);
        expect(result.autoApplyReady).toBe(true);
        expect(result.bestMatch!.orderId).toBe("124813");
        expect(result.bestMatch!.score).toBe(100);
        const hasOcrReason = result.bestMatch!.reasons.some(r => r.includes("exact OCR PO match"));
        expect(hasOcrReason).toBe(true);
    });
});
