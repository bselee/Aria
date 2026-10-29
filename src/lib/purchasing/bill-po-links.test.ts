/**
 * @file    bill-po-links.test.ts
 * @purpose Unit tests for the many-to-many bill→PO helpers (Gap 24). The cases
 *          that matter are the ones where a wrong answer either resurrects the
 *          "awaiting vendor invoice" lie on a covered PO, or invents coverage
 *          from something other than a link row.
 */

import { describe, expect, it } from "vitest";

import {
    coversPosForInvoice,
    invoicesForPo,
    isPoCoveredByMultiPoBill,
    linkBillsToPos,
    poNumbersForInvoice,
    type BillPoLink,
} from "./bill-po-links";

/** A link row enriched the way the receivings route enriches it. */
function link(overrides: Partial<BillPoLink> = {}): BillPoLink {
    return {
        vendor_invoice_id: "inv-1",
        po_number: "125429",
        invoice_number: "215047605",
        ...overrides,
    };
}

describe("linkBillsToPos", () => {
    it("writes one row per covered PO, bill's own po_number first", () => {
        const rows = linkBillsToPos(
            { id: "inv-1", invoice_number: "215047605", po_number: "125429" },
            ["125430", "125431"],
        );

        expect(rows).toEqual([
            { vendor_invoice_id: "inv-1", po_number: "125429", invoice_number: "215047605" },
            { vendor_invoice_id: "inv-1", po_number: "125430", invoice_number: "215047605" },
            { vendor_invoice_id: "inv-1", po_number: "125431", invoice_number: "215047605" },
        ]);
    });

    it("drops blanks and duplicates without reordering the rest", () => {
        const rows = linkBillsToPos(
            { id: "inv-1", po_number: " 125429 " },
            ["125430", "125429", "  ", "", null, undefined, "125430"],
        );

        expect(rows.map((r) => r.po_number)).toEqual(["125429", "125430"]);
    });

    it("yields nothing for a bill with no id — an unattributable link is not a link", () => {
        expect(linkBillsToPos({ id: "" }, ["125429"])).toEqual([]);
    });

    it("carries a null invoice number rather than an empty string", () => {
        const rows = linkBillsToPos({ id: "inv-1" }, ["125429"]);
        expect(rows[0].invoice_number).toBeNull();
    });
});

describe("coversPosForInvoice", () => {
    it("names every PO the bill covers, sorted numerically", () => {
        const links = [
            link({ vendor_invoice_id: "inv-1", po_number: "125430" }),
            link({ vendor_invoice_id: "inv-1", po_number: "125429" }),
            link({ vendor_invoice_id: "inv-2", po_number: "125999" }),
        ];

        expect(
            coversPosForInvoice({ id: "inv-1", invoice_number: "215047605", po_number: "125429" }, links),
        ).toEqual(["125429", "125430"]);
    });

    it("keeps the legacy po_number even when no link row exists yet", () => {
        expect(coversPosForInvoice({ id: "inv-1", po_number: "125429" }, [])).toEqual(["125429"]);
    });

    it("does not credit a bill with a PO it is not linked to", () => {
        const links = [link({ vendor_invoice_id: "inv-2", po_number: "125430" })];
        expect(coversPosForInvoice({ id: "inv-1", po_number: "125429" }, links)).toEqual(["125429"]);
    });

    it("matches by invoice number only when the bill has no id", () => {
        const links = [link({ vendor_invoice_id: "", invoice_number: "215047605", po_number: "125430" })];
        expect(coversPosForInvoice({ id: "", invoice_number: "215047605" }, links)).toEqual(["125430"]);
    });
});

describe("poNumbersForInvoice", () => {
    it("resolves a number to every covered PO", () => {
        const links = [
            link({ po_number: "125430" }),
            link({ po_number: "125429" }),
            link({ vendor_invoice_id: "inv-2", po_number: "125900", invoice_number: "1105-A" }),
        ];

        expect(poNumbersForInvoice("215047605", links)).toEqual(["125429", "125430"]);
    });

    it("ignores case and padding in the invoice number", () => {
        const links = [link({ invoice_number: " ab-12 " })];
        expect(poNumbersForInvoice("AB-12", links)).toEqual(["125429"]);
    });

    it("reads a PostgREST embedded vendor_invoices object", () => {
        const links: BillPoLink[] = [
            { vendor_invoice_id: "inv-1", po_number: "125429", vendor_invoices: { invoice_number: "215047605" } },
        ];
        expect(poNumbersForInvoice("215047605", links)).toEqual(["125429"]);
    });

    it("returns nothing for a blank number or un-enriched links", () => {
        expect(poNumbersForInvoice("", [link()])).toEqual([]);
        expect(poNumbersForInvoice("215047605", [{ vendor_invoice_id: "inv-1", po_number: "125429" }])).toEqual([]);
    });
});

describe("invoicesForPo", () => {
    it("lists every bill covering one PO, sorted and deduped", () => {
        const links = [
            link({ invoice_number: "B-2" }),
            link({ invoice_number: "A-1" }),
            link({ invoice_number: "B-2" }),
            link({ vendor_invoice_id: "inv-9", po_number: "125430", invoice_number: "C-3" }),
        ];

        expect(invoicesForPo("125429", links)).toEqual(["A-1", "B-2"]);
    });

    it("skips links whose invoice number was never joined in", () => {
        const links: BillPoLink[] = [{ vendor_invoice_id: "inv-1", po_number: "125429" }];
        expect(invoicesForPo("125429", links)).toEqual([]);
    });

    it("returns nothing for a PO with no links", () => {
        expect(invoicesForPo("125999", [link()])).toEqual([]);
    });
});

describe("isPoCoveredByMultiPoBill", () => {
    it("is true when one bill covers the PO and a sibling", () => {
        const links = [link({ po_number: "125429" }), link({ po_number: "125430" })];
        expect(isPoCoveredByMultiPoBill("125429", links)).toBe(true);
        expect(isPoCoveredByMultiPoBill("125430", links)).toBe(true);
    });

    it("is false for a single-PO bill", () => {
        expect(isPoCoveredByMultiPoBill("125429", [link()])).toBe(false);
    });

    it("is false when two DIFFERENT bills each cover one PO", () => {
        const links = [
            link({ vendor_invoice_id: "inv-1", po_number: "125429" }),
            link({ vendor_invoice_id: "inv-2", po_number: "125430" }),
        ];
        expect(isPoCoveredByMultiPoBill("125429", links)).toBe(false);
    });

    it("is false for a PO nobody links, and for a blank PO", () => {
        expect(isPoCoveredByMultiPoBill("125999", [link()])).toBe(false);
        expect(isPoCoveredByMultiPoBill("", [link()])).toBe(false);
    });
});
