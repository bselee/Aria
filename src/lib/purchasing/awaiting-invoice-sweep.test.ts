/**
 * @file    awaiting-invoice-sweep.test.ts
 * @purpose Gap 17: a received PO's "awaiting invoice" splits into
 *          awaiting_vendor (normal) vs in_gmail_unmatched (the bill is in
 *          Gmail, the sweep proves it by PO number). Gmail + PostgREST are
 *          both injected here — no test may reach live Gmail or the DB.
 * @author  Hermia
 * @created 2026-10-29
 * @deps    vitest, ./awaiting-invoice-sweep
 */

import { describe, expect, it, vi } from "vitest";

import {
    INVOICE_STATE,
    MAX_POS_PER_SWEEP,
    buildPoSearchQuery,
    hasRecordedBill,
    isBillLikeHit,
    isSearchablePoNumber,
    sweepAwaitingInvoices,
    type AwaitingInvoiceCandidate,
    type AwaitingInvoiceFinding,
    type GmailAccountId,
    type GmailHit,
    type GmailSearch,
    type InvoiceState,
} from "./awaiting-invoice-sweep";

// ── Fixtures ──────────────────────────────────────────────────────────────

function candidate(overrides: Partial<AwaitingInvoiceCandidate> = {}): AwaitingInvoiceCandidate {
    return {
        poNumber: "125393",
        vendorName: "Rootwise",
        receiveDate: "2026-10-20T10:00:00-06:00",
        invoiceState: null,
        ...overrides,
    };
}

/** Recorded state writes, in call order. */
interface Write {
    poNumber: string;
    state: InvoiceState;
    finding: AwaitingInvoiceFinding | null;
}

/**
 * Run the sweep with a fake Gmail inbox map and a recording writer.
 * `inbox[account][query-substring]` is not modelled — every hit is served for
 * whichever account lists it, which is all the sweep asks of the adapter.
 */
async function runSweep(opts: {
    candidates: AwaitingInvoiceCandidate[];
    hits?: Partial<Record<GmailAccountId, GmailHit[]>>;
    searchImpl?: GmailSearch;
    markThrows?: boolean;
    skipAlreadyFlagged?: boolean;
}) {
    const writes: Write[] = [];
    const queries: Array<{ query: string; account: GmailAccountId }> = [];
    const defaultHits = opts.hits ?? {};

    const searchGmail: GmailSearch = async (query, account) => {
        queries.push({ query, account });
        if (opts.searchImpl) return opts.searchImpl(query, account);
        return defaultHits[account] ?? [];
    };

    const report = await sweepAwaitingInvoices({
        listCandidates: async () => opts.candidates,
        searchGmail,
        markInvoiceState: async (poNumber, state, finding) => {
            if (opts.markThrows) throw new Error("PostgREST write refused");
            writes.push({ poNumber, state, finding });
        },
        ...(opts.skipAlreadyFlagged === undefined ? {} : { skipAlreadyFlagged: opts.skipAlreadyFlagged }),
    });

    return { report, writes, queries };
}

// ── Gmail query construction ──────────────────────────────────────────────

describe("buildPoSearchQuery", () => {
    it("searches the PO number, never the vendor", () => {
        const q = buildPoSearchQuery("125393");
        expect(q).toContain('"125393"');
        expect(q).toContain('"PO-125393"');
        // Glued form: how the Rootwise attachment "BAS PO125393-1-PDF.pdf" hits.
        expect(q).toContain("PO125393");
        expect(q).not.toMatch(/from:rootwise/i);
        expect(q).not.toMatch(/from:(?!buildasoil|finaleinventory)/i);
    });

    it("excludes our own outbound PO email and Finale notices", () => {
        const q = buildPoSearchQuery("125393");
        expect(q).toContain("-in:sent");
        expect(q).toContain("-from:buildasoil.com");
        expect(q).toContain("-from:finaleinventory.com");
    });

    it("normalises a PO-prefixed number to the same query", () => {
        expect(buildPoSearchQuery("PO-125393")).toBe(buildPoSearchQuery("125393"));
    });

    it("returns an empty query for a number-less string", () => {
        expect(buildPoSearchQuery("PO-")).toBe("");
    });
});

describe("isSearchablePoNumber", () => {
    it("accepts six-digit Finale numbers with or without a PO prefix", () => {
        expect(isSearchablePoNumber("125393")).toBe(true);
        expect(isSearchablePoNumber("PO-125393")).toBe(true);
    });

    it("rejects dropships and non-PO ids", () => {
        expect(isSearchablePoNumber("DropshipPO125393")).toBe(false);
        expect(isSearchablePoNumber("12539")).toBe(false);
        expect(isSearchablePoNumber("")).toBe(false);
        expect(isSearchablePoNumber(null)).toBe(false);
    });
});

// ── Hit classification ────────────────────────────────────────────────────

describe("isBillLikeHit", () => {
    it("accepts the canonical Rootwise subject", () => {
        expect(isBillLikeHit({ threadId: "t", subject: "Rootwise Invoices" })).toBe(true);
    });

    it("accepts an attachment even with a bland subject", () => {
        expect(isBillLikeHit({ threadId: "t", subject: "Order update", hasAttachment: true })).toBe(true);
    });

    it("rejects a shipping notice that merely quotes the PO number", () => {
        expect(isBillLikeHit({ threadId: "t", subject: "UPS shipment notification for 125393" })).toBe(false);
    });
});

describe("hasRecordedBill", () => {
    it("counts a positive-total bill", () => {
        expect(hasRecordedBill([{ vendor_name: "Uline", invoice_number: "215047605", total: 175 }])).toBe(true);
    });

    it("does not count a $0 row (unreadable amount, not proof of billing)", () => {
        expect(hasRecordedBill([{ vendor_name: "Uline", invoice_number: "215047605", total: 0 }])).toBe(false);
    });

    it("does not count an OCR phantom", () => {
        expect(hasRecordedBill([{ vendor_name: "error", invoice_number: "error", total: 250 }])).toBe(false);
    });

    it("does not count a carrier freight archive as a goods bill", () => {
        expect(
            hasRecordedBill([{ vendor_name: "LTL Select", invoice_number: "300093120787", source_ref: "ltlselect-42", total: 610 }]),
        ).toBe(false);
    });
});

// ── The sweep ─────────────────────────────────────────────────────────────

describe("sweepAwaitingInvoices", () => {
    it("flags the Rootwise case: PO number finds the bill in the ap inbox", async () => {
        const { report, writes, queries } = await runSweep({
            candidates: [candidate()],
            hits: {
                default: [],
                ap: [{ threadId: "18c9f-thread", subject: "Rootwise Invoices", messageId: "msg-1", hasAttachment: true }],
            },
        });

        expect(report.findings).toHaveLength(1);
        expect(report.findings[0]).toMatchObject({
            poNumber: "125393",
            gmailThreadId: "18c9f-thread",
            subject: "Rootwise Invoices",
            account: "ap",
        });
        expect(report.findings[0].query).toContain("PO125393");
        expect(report.markedInGmail).toBe(1);
        expect(report.markedAwaitingVendor).toBe(0);

        expect(writes).toEqual([
            {
                poNumber: "125393",
                state: INVOICE_STATE.IN_GMAIL_UNMATCHED,
                finding: expect.objectContaining({ gmailThreadId: "18c9f-thread" }),
            },
        ]);
        // Both inboxes were searched by PO number.
        expect(queries.map((q) => q.account)).toEqual(["default", "ap"]);
        expect(queries.every((q) => q.query === buildPoSearchQuery("125393"))).toBe(true);
    });

    it("marks awaiting_vendor when neither inbox has the PO number", async () => {
        const { report, writes } = await runSweep({ candidates: [candidate()] });

        expect(report.findings).toHaveLength(0);
        expect(report.markedAwaitingVendor).toBe(1);
        expect(writes).toEqual([{ poNumber: "125393", state: INVOICE_STATE.AWAITING_VENDOR, finding: null }]);
    });

    it("does not rewrite a PO already sitting at awaiting_vendor", async () => {
        const { report, writes } = await runSweep({
            candidates: [candidate({ invoiceState: INVOICE_STATE.AWAITING_VENDOR })],
        });

        expect(report.unchanged).toBe(1);
        expect(report.markedAwaitingVendor).toBe(0);
        expect(writes).toHaveLength(0);
    });

    it("skips a PO already flagged in_gmail_unmatched without re-querying Gmail", async () => {
        const { report, writes, queries } = await runSweep({
            candidates: [candidate({ invoiceState: INVOICE_STATE.IN_GMAIL_UNMATCHED })],
        });

        expect(report.alreadyFlagged).toBe(1);
        expect(queries).toHaveLength(0);
        expect(writes).toHaveLength(0);
    });

    it("excludes paid-in-advance vendors from the search entirely", async () => {
        const { report, writes, queries } = await runSweep({
            candidates: [
                candidate({ poNumber: "125401", vendorName: "Sustainable Village" }),
                candidate({ poNumber: "125402", vendorName: "Cen-Tec" }),
                candidate({ poNumber: "125403", vendorName: "Axiom" }),
                candidate({ poNumber: "125404", vendorName: "Colorful Packaging" }),
            ],
        });

        expect(report.skippedPaidInAdvance.sort()).toEqual(["125401", "125402", "125403", "125404"]);
        expect(queries).toHaveLength(0);
        expect(writes).toHaveLength(0);
        expect(report.findings).toHaveLength(0);
    });

    it("is not fooled by a shipping confirmation quoting the PO number", async () => {
        const { report, writes } = await runSweep({
            candidates: [candidate()],
            hits: { default: [{ threadId: "t-nudge", subject: "UPS shipment notification for PO 125393" }] },
        });

        expect(report.findings).toHaveLength(0);
        expect(writes[0]?.state).toBe(INVOICE_STATE.AWAITING_VENDOR);
    });

    it("leaves the state untouched when every Gmail account fails", async () => {
        const { report, writes } = await runSweep({
            candidates: [candidate()],
            searchImpl: async () => {
                throw new Error("invalid_grant");
            },
        });

        expect(writes).toHaveLength(0);
        expect(report.searched).toBe(1);
        expect(report.errors.some((e) => e.includes("left unchanged"))).toBe(true);
    });

    it("still flags a PO when only one inbox answers", async () => {
        const { report, writes } = await runSweep({
            candidates: [candidate()],
            searchImpl: async (_query, account) => {
                if (account === "default") throw new Error("invalid_grant");
                return [{ threadId: "t-ap", subject: "Invoice 4471 for PO-125393", hasAttachment: true }];
            },
        });

        expect(report.findings).toHaveLength(1);
        expect(writes[0]?.state).toBe(INVOICE_STATE.IN_GMAIL_UNMATCHED);
        expect(report.errors).toHaveLength(1);
    });

    it("reports the finding even when the state write fails", async () => {
        const { report } = await runSweep({
            candidates: [candidate()],
            hits: { default: [{ threadId: "t-1", subject: "Rootwise Invoices", hasAttachment: true }] },
            markThrows: true,
        });

        expect(report.findings).toHaveLength(1);
        expect(report.markedInGmail).toBe(0);
        expect(report.errors.some((e) => e.includes("state write failed"))).toBe(true);
    });

    it("skips non-PO ids such as dropships", async () => {
        const { report, queries } = await runSweep({
            candidates: [candidate({ poNumber: "DropshipPO125500" })],
        });

        expect(report.skippedNotPoNumber).toEqual(["DropshipPO125500"]);
        expect(queries).toHaveLength(0);
    });

    it("bounds a run at MAX_POS_PER_SWEEP, oldest receipt first", async () => {
        const many = Array.from({ length: MAX_POS_PER_SWEEP + 5 }, (_, i) =>
            candidate({
                poNumber: `125${String(400 + i).padStart(3, "0")}`,
                receiveDate: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00-06:00`,
            }),
        );

        const { report, queries } = await runSweep({ candidates: many });

        expect(report.truncated).toBe(5);
        expect(report.searched).toBe(MAX_POS_PER_SWEEP);
        expect(queries).toHaveLength(MAX_POS_PER_SWEEP * 2);
    });

    it("never reaches live Gmail or PostgREST when nothing is injected", async () => {
        // Default adapters: createClient() refuses to invent a DB under vitest
        // and the Gmail SDK is imported lazily, so this reports instead of throws.
        const report = await sweepAwaitingInvoices();

        expect(report.candidates).toBe(0);
        expect(report.searched).toBe(0);
        expect(report.findings).toHaveLength(0);
        expect(report.errors.length).toBeGreaterThan(0);
        expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
    });
});
