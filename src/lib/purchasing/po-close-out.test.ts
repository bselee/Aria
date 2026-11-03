/**
 * @file    src/lib/purchasing/po-close-out.test.ts
 * @purpose Bill's close-out rule: received drafts get committed; completion
 *          needs receipt AND a matching invoice; nothing unproven moves.
 * @author  Hermia
 * @created 2026-10-29
 * @deps    vitest
 */
import { describe, it, expect } from "vitest";
import { decidePoCloseAction, isFullyReceived, type PoCloseInput } from "./po-close-out";

function input(overrides: Partial<PoCloseInput> = {}): PoCloseInput {
    return {
        orderId: "125247",
        statusId: "ORDER_LOCKED",
        orderedUnits: 1000,
        receivedUnits: 1000,
        shortSkus: [],
        receiptsIncomplete: false,
        hasMatchedInvoice: true,
        invoiceTotal: 1000,
        poTotal: 1000,
        hasBlockingDiscrepancy: false,
        freightUnapplied: false,
        taxOrMiscUnapplied: false,
        ...overrides,
    };
}

describe("isFullyReceived", () => {
    it("is true when everything ordered arrived", () => {
        expect(isFullyReceived(input())).toBe(true);
    });

    it("is false when any SKU is short", () => {
        expect(isFullyReceived(input({ shortSkus: ["RWBP102 ×30"] }))).toBe(false);
    });

    it("is false when the receipt could not be fully read", () => {
        // An unreadable receipt is not proof of receipt.
        expect(isFullyReceived(input({ receiptsIncomplete: true }))).toBe(false);
    });

    it("is false for a PO with no units", () => {
        expect(isFullyReceived(input({ orderedUnits: 0, receivedUnits: 0 }))).toBe(false);
    });
});

describe("decidePoCloseAction — received drafts", () => {
    it("commits a fully received draft (125247 arrived while still a draft)", () => {
        const d = decidePoCloseAction(input({ statusId: "ORDER_CREATED" }));

        expect(d.action).toBe("commit");
        expect(d.reason).toContain("draft");
    });

    it("commits a received draft even without an invoice yet", () => {
        // The draft was never committed; invoice matching is a separate step.
        const d = decidePoCloseAction(input({ statusId: "ORDER_CREATED", hasMatchedInvoice: false }));

        expect(d.action).toBe("commit");
    });

    it("leaves a draft alone while it is still outstanding", () => {
        const d = decidePoCloseAction(input({
            statusId: "ORDER_CREATED",
            receivedUnits: 400,
            shortSkus: ["S-1665 ×600"],
        }));

        expect(d.action).toBe("none");
        expect(d.blockers).toEqual(["S-1665 ×600"]);
    });
});

describe("decidePoCloseAction — completion", () => {
    it("completes a received, reconciled PO", () => {
        const d = decidePoCloseAction(input());

        expect(d.action).toBe("complete");
        expect(d.blockers).toEqual([]);
    });

    it("refuses to complete when not received", () => {
        const d = decidePoCloseAction(input({ receivedUnits: 900, shortSkus: ["A100 ×100"] }));

        expect(d.action).toBe("none");
        expect(d.blockers.join(" ")).toContain("not fully received");
    });

    it("refuses to complete without a matched invoice", () => {
        const d = decidePoCloseAction(input({ hasMatchedInvoice: false }));

        expect(d.action).toBe("none");
        expect(d.blockers).toContain("no matched invoice");
    });

    it("refuses to complete when freight is not on the PO", () => {
        const d = decidePoCloseAction(input({ freightUnapplied: true }));

        expect(d.action).toBe("none");
        expect(d.blockers.join(" ")).toContain("freight");
    });

    it("refuses to complete when tax or misc is not on the PO", () => {
        const d = decidePoCloseAction(input({ taxOrMiscUnapplied: true }));

        expect(d.action).toBe("none");
        expect(d.blockers.join(" ")).toContain("tax/misc");
    });

    it("refuses to complete on a blocking invoice discrepancy", () => {
        const d = decidePoCloseAction(input({ hasBlockingDiscrepancy: true }));

        expect(d.action).toBe("none");
        expect(d.blockers).toContain("invoice/Po discrepancy");
    });

    it("tolerates small freight/tax drift between invoice and PO", () => {
        // Freight pushes the invoice $18 over a $1000 PO — inside tolerance.
        const d = decidePoCloseAction(input({ poTotal: 1000, invoiceTotal: 1018 }));

        expect(d.action).toBe("complete");
    });

    it("blocks when totals disagree beyond tolerance", () => {
        const d = decidePoCloseAction(input({ poTotal: 1000, invoiceTotal: 1200 }));

        expect(d.action).toBe("none");
        expect(d.blockers.join(" ")).toContain("vs PO");
    });

    it("never touches an already-closed PO", () => {
        expect(decidePoCloseAction(input({ statusId: "ORDER_COMPLETED" })).action).toBe("none");
    });
});
