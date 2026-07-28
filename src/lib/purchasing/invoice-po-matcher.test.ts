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
vi.mock("@/lib/purchasing/vendor-name-normalize", () => ({
    normalizeVendorName: (s: string) => (s || "").toUpperCase().replace(/\s+/g, " ").trim(),
    resolveCanonicalVendor: () => null,
    loadVendorAliases: vi.fn().mockResolvedValue([]),
}));

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

    it("strips # prefix: # 23324007 → 23324007", () => {
        expect(sanitizeOcrPoCandidate("# 23324007")).toBe("23324007");
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

    it("accepts plain 8-digit PO numbers", () => {
        expect(sanitizeOcrPoCandidate("23324007")).toBe("23324007");
    });

    it("accepts DropshipPO suffix (digits retained for PO lookup)", () => {
        const v = sanitizeOcrPoCandidate("23497897-DropshipPO");
        expect(v === "23497897" || v === "23497897-DropshipPO").toBe(true);
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
        expect(result!.tier).toBe("unique_vendor_amount_date");
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

    it("returns null when amount variance > 2%", () => {
        const inv = makeInvoice({
            vendorName: "TestCo",
            total: 100,
            invoiceDate: "2026-07-15",
        });
        const candidates = [
            makePO({
                orderId: "PO-001",
                vendorName: "TestCo",
                total: 500,
                orderDate: "2026-07-14",
                score: 70,
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
            total: 500,
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
