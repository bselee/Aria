/**
 * @file    src/lib/purchasing/ordering-po-coverage.test.ts
 * @purpose A PO that owes no goods is not inbound supply, whatever Finale's
 *          status field says (125080 received in July still reads `open`).
 * @author  Hermia
 * @created 2026-10-29
 * @deps    vitest
 */
import { describe, it, expect } from "vitest";
import {
    isReceivedNotProcessed,
    buildRecentOpenCoverageByProduct,
    poStillOwesGoods,
    type RecentPOForCoverage,
} from "./ordering-po-coverage";

function po(overrides: Partial<RecentPOForCoverage> = {}): RecentPOForCoverage {
    return {
        orderId: "125080",
        status: "open",
        orderDate: "2026-07-13",
        items: [{ productId: "RWBP102", quantity: 30, remainingQty: 30 }],
        ...overrides,
    };
}

describe("poStillOwesGoods", () => {
    it("owes goods when a line still has units remaining", () => {
        expect(poStillOwesGoods(po())).toBe(true);
    });

    it("owes nothing when every line is fully received — even if status says open", () => {
        // 125080: received 2026-07-24, still `open`, remaining 0. It was holding
        // RWBP102 off the board indefinitely.
        const received = po({ items: [{ productId: "RWBP102", quantity: 30, remainingQty: 0 }] });

        expect(poStillOwesGoods(received)).toBe(false);
    });

    it("treats a committed PO with everything received as owing nothing", () => {
        const committed = po({
            orderId: "125441",
            status: "Committed",
            items: [{ productId: "COWOCO3", quantity: 200, remainingQty: 0 }],
        });

        expect(poStillOwesGoods(committed)).toBe(false);
    });

    it("fails open when no line carries a readable remainder", () => {
        // Absence of receipt evidence is not evidence of receipt.
        const unknown = po({ items: [{ productId: "RWBP102", quantity: 30, remainingQty: null }] });

        expect(poStillOwesGoods(unknown)).toBe(true);
    });

    it("keeps owing when one line is done and another is outstanding", () => {
        const mixed = po({
            items: [
                { productId: "A100", quantity: 10, remainingQty: 0 },
                { productId: "B200", quantity: 5, remainingQty: 5 },
            ],
        });

        expect(poStillOwesGoods(mixed)).toBe(true);
    });
});

describe("buildRecentOpenCoverageByProduct", () => {
    it("drops cover from a fully-received PO that Finale still calls open", () => {
        const coverage = buildRecentOpenCoverageByProduct([
            po({ items: [{ productId: "RWBP102", quantity: 30, remainingQty: 0 }] }),
        ]);

        expect(coverage.has("RWBP102")).toBe(false);
    });

    it("keeps cover from a genuinely outstanding PO", () => {
        const coverage = buildRecentOpenCoverageByProduct([
            po({ orderId: "125999", status: "Committed", items: [{ productId: "A100", quantity: 40, remainingQty: 15 }] }),
        ]);

        expect(coverage.get("A100")?.totalQty).toBe(15);
    });

    it("credits only the outstanding remainder of a partially received PO", () => {
        // "if unreceived, that is a different story" — the undelivered half is
        // still real cover; the delivered half is stock, not supply.
        const coverage = buildRecentOpenCoverageByProduct([
            po({ orderId: "125500", status: "Committed", items: [{ productId: "B200", quantity: 100, remainingQty: 40 }] }),
        ]);

        expect(coverage.get("B200")?.totalQty).toBe(40);
    });

    it("does not let a received Draft hold the SKU off the board (125247)", () => {
        // 125247: S-1665 and S-5940 fully on hand, PO still a Draft.
        const coverage = buildRecentOpenCoverageByProduct([
            po({
                orderId: "125247",
                status: "Draft",
                items: [
                    { productId: "S-1665", quantity: 1000, remainingQty: 0 },
                    { productId: "S-5940", quantity: 1000, remainingQty: 0 },
                ],
            }),
        ]);

        expect(coverage.has("S-1665")).toBe(false);
        expect(coverage.has("S-5940")).toBe(false);
    });
});

describe("isReceivedNotProcessed", () => {
    it("flags a received draft as an unprocessed step", () => {
        const receivedDraft = po({
            orderId: "125247",
            status: "Draft",
            items: [{ productId: "S-1665", quantity: 1000, remainingQty: 0 }],
        });

        expect(isReceivedNotProcessed(receivedDraft)).toBe(true);
    });

    it("flags a received committed PO", () => {
        const receivedCommitted = po({
            orderId: "125394",
            status: "Committed",
            items: [{ productId: "TEC101", quantity: 12, remainingQty: 0 }],
        });

        expect(isReceivedNotProcessed(receivedCommitted)).toBe(true);
    });

    it("never flags a PO that still owes units", () => {
        const unreceived = po({ orderId: "126000", status: "Committed" });

        expect(isReceivedNotProcessed(unreceived)).toBe(false);
    });

    it("never flags a closed PO", () => {
        const closed = po({ orderId: "125300", status: "Completed", items: [{ productId: "A100", quantity: 5, remainingQty: 0 }] });

        expect(isReceivedNotProcessed(closed)).toBe(false);
    });
});
