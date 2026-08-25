/**
 * @file    src/lib/purchasing/ordering-row-copy.test.ts
 * @purpose Tests for discreet PO Draft labels and one-line draft justification.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    vitest, ordering-row-copy
 * @env     none
 */

import { describe, expect, it } from "vitest";
import { formatPoDraftLabel, orderDraftJustification } from "./ordering-row-copy";

describe("formatPoDraftLabel", () => {
    it("renders PO{n} Draft without a hash", () => {
        expect(formatPoDraftLabel("125192")).toBe("PO125192 Draft");
    });

    it("strips an existing PO prefix", () => {
        expect(formatPoDraftLabel("PO-125192")).toBe("PO125192 Draft");
        expect(formatPoDraftLabel("PO 3")).toBe("PO3 Draft");
    });

    it("falls back when empty", () => {
        expect(formatPoDraftLabel("")).toBe("Draft");
        expect(formatPoDraftLabel(null)).toBe("Draft");
    });
});

describe("orderDraftJustification", () => {
    it("prefers the existing draft token over qty math", () => {
        expect(orderDraftJustification({
            suggestedQty: 5,
            lastPurchaseQty: 50,
            runwayDays: 42,
            leadTimeDays: 13,
            draftPO: { orderId: "125192", orderDate: "2026-08-14", quantity: 3000 },
        })).toBe("PO125192 Draft · 3,000 · 8/14");
    });

    it("justifies a new draft with qty, last order, and runway vs lead", () => {
        expect(orderDraftJustification({
            suggestedQty: 50,
            lastPurchaseQty: 50,
            runwayDays: 42,
            leadTimeDays: 13,
            recommendation: {
                provenance: [{ step: "cover_floor", detail: "raised 5 to 50" }],
            },
        })).toBe("order 50 · last 50 · 42d vs 13d lead · 30d floor");
    });

    it("tags last-order floor when that step fired", () => {
        expect(orderDraftJustification({
            suggestedQty: 50,
            lastPurchaseQty: 50,
            runwayDays: 42,
            leadTimeDays: 13,
            recommendation: {
                provenance: [
                    { step: "cover_floor", detail: "raised 5 to 21" },
                    { step: "last_purchase_floor", detail: "Bumped to 50" },
                ],
            },
        })).toContain("last-order floor");
    });
});
