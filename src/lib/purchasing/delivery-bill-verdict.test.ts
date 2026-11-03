/**
 * @file    src/lib/purchasing/delivery-bill-verdict.test.ts
 * @purpose The receiving desk's three questions, per delivery: under delivered?
 *          over billed? OK to load into Bill.com?
 * @author  Hermia
 * @created 2026-11-03
 * @deps    vitest
 */
import { describe, it, expect } from "vitest";
import { checkDeliveryAgainstBill } from "./delivery-bill-verdict";

describe("clean delivery (Colorado Worm case)", () => {
    it("loads a bill that matches what arrived", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "CW101", receivedQty: 40, poUnitPrice: 12.5 }],
            [{ sku: "CW101", qty: 40, unitPrice: 12.5 }],
        );

        expect(v.disposition).toBe("load");
        expect(v.matches).toBe(true);
        expect(v.headline).toContain("Safe to load");
    });
});

describe("Miles 125408 — partial PO delivery, own bill", () => {
    // The PO has 3 lines. This delivery brought only the pumpkin.
    it("loads the pumpkin bill and does not ask for the rest of the PO", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "BASLPE103", receivedQty: 50, poUnitPrice: 13 }],
            [{ sku: "", description: "Pumpkin Half Gallons", qty: 50, unitPrice: 13 }],
        );

        expect(v.disposition).toBe("load");
        expect(v.lines).toHaveLength(1);
        expect(v.lines[0].sku).toBe("BASLPE103");
        expect(v.overBilled).toBe(false);
    });

    it("holds a bill charging for 50 when only 24 arrived", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "BASLCE103", receivedQty: 24, poUnitPrice: 24 }],
            [{ sku: "BASLCE103", qty: 50, unitPrice: 24 }],
        );

        expect(v.disposition).toBe("hold");
        expect(v.underDelivered).toBe(true);
        expect(v.overBilledAmount).toBe(624);
        expect(v.headline).toContain("Hold");
    });

    it("names the exact shortfall so the desk can call the vendor", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "BASLCE103", receivedQty: 24, poUnitPrice: 24 }],
            [{ sku: "BASLCE103", qty: 50, unitPrice: 24 }],
        );

        expect(v.reasons.join(" ")).toContain("24 received, 50 billed");
        expect(v.reasons.join(" ")).toContain("26 short");
    });
});

describe("over billing", () => {
    it("holds a bill charging a higher unit price than the PO", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "HTF101", receivedQty: 10, poUnitPrice: 24 }],
            [{ sku: "HTF101", qty: 10, unitPrice: 30 }],
        );

        expect(v.disposition).toBe("hold");
        expect(v.overBilled).toBe(true);
        expect(v.overBilledAmount).toBe(60);
    });

    it("tolerates a few cents of rounding", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "BAV103Label", receivedQty: 400, poUnitPrice: 0.616215 }],
            [{ sku: "BAV103Label", qty: 400, unitPrice: 0.62 }],
        );

        expect(v.disposition).toBe("load");
    });

    it("holds a bill for a SKU that never arrived", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "BASLPE103", receivedQty: 50, poUnitPrice: 13 }],
            [
                { sku: "BASLPE103", qty: 50, unitPrice: 13 },
                { sku: "BASLCE103", qty: 10, unitPrice: 24 },
            ],
        );

        expect(v.disposition).toBe("hold");
        expect(v.lines.some((l) => l.notDelivered)).toBe(true);
        expect(v.reasons.join(" ")).toContain("never delivered");
    });
});

describe("under delivery without over billing", () => {
    it("shows a delivered-but-unbilled line as review, not a clean pass", () => {
        const v = checkDeliveryAgainstBill(
            [
                { sku: "BASLPE103", receivedQty: 50, poUnitPrice: 13 },
                { sku: "HTF101", receivedQty: 10, poUnitPrice: 24 },
            ],
            [{ sku: "BASLPE103", qty: 50, unitPrice: 13 }],
        );

        // The $650 bill is correct, but the PO is NOT settled: $240 of goods
        // have no bill. Saying "safe to load" alone would imply otherwise.
        expect(v.disposition).toBe("review");
        expect(v.unbilledAmount).toBe(240);
        expect(v.headline).toContain("no bill");
        expect(v.lines.find((l) => l.sku === "HTF101")?.notBilled).toBe(true);
    });
});

describe("pack sizes (ULINE bills by the case)", () => {
    it("converts a case bill to shelf units instead of calling it over billed", () => {
        // ULINE bills 1 CASE at $120; the desk received 12 units at $10.
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-101", receivedQty: 12, poUnitPrice: 10 }],
            [{ sku: "S-101", qty: 1, unitPrice: 120 }],
            { billTotal: 120 },
        );

        expect(v.disposition).toBe("load");
        expect(v.overBilled).toBe(false);
        expect(v.lines[0].billedQty).toBe(12);
    });

    it("still catches a real overbill after conversion", () => {
        // Bills 2 cases (24 units) at $120/case, but only 12 arrived.
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-101", receivedQty: 12, poUnitPrice: 10 }],
            [{ sku: "S-101", qty: 2, unitPrice: 120 }],
            { billTotal: 240 },
        );

        expect(v.disposition).toBe("hold");
    });

    it("refuses to convert a messy ratio and still holds a bill that exceeds delivery", () => {
        // 12 received vs 30 billed is ratio 0.4 — not a pack size. No conversion
        // may be applied, and the bill claims more than arrived, so HOLD.
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-101", receivedQty: 12, poUnitPrice: 10 }],
            [{ sku: "S-101", qty: 30, unitPrice: 10 }],
            { billTotal: 300 },
        );

        expect(v.disposition).toBe("hold");
        expect(v.underDelivered).toBe(true);
        expect(v.lines[0].billedQty).toBe(30);
    });

    it("does not convert a near-but-not-exact pack ratio", () => {
        // ratio 12/3.9 = 3.08 — outside the 2% window, so it stays 3.9 billed.
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-101", receivedQty: 12, poUnitPrice: 10 }],
            [{ sku: "S-101", qty: 3.9, unitPrice: 30.77 }],
            { billTotal: 120 },
        );

        expect(v.lines[0].billedQty).toBe(3.9);
    });
});

describe("honesty guards", () => {
    it("never invents a pairing between two identical bill candidates", () => {
        const v = checkDeliveryAgainstBill(
            [
                { sku: "BASLCE103", receivedQty: 50, poUnitPrice: 13 },
                { sku: "BASLPE103", receivedQty: 50, poUnitPrice: 13 },
            ],
            [{ sku: "", description: "Pumpkin", qty: 50, unitPrice: 13 }],
        );

        // Unpairable, so both delivered lines read as not-billed.
        expect(v.lines.every((l) => l.notBilled)).toBe(true);
    });

    it("says review when nothing has arrived and there is no bill", () => {
        const v = checkDeliveryAgainstBill([], []);

        expect(v.disposition).toBe("review");
        expect(v.headline).toContain("Nothing to compare");
    });

    it("says delivered-not-billed when goods arrived with no bill", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "CW101", receivedQty: 40, poUnitPrice: 12.5 }],
            [],
        );

        expect(v.disposition).toBe("review");
        expect(v.headline).toContain("no bill");
    });

    it("flags a bill total above its readable lines", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "BASLPE103", receivedQty: 50, poUnitPrice: 13 }],
            [{ sku: "BASLPE103", qty: 50, unitPrice: 13 }],
            { billTotal: 720 },
        );

        expect(v.disposition).toBe("hold");
        expect(v.reasons.join(" ")).toContain("exceeds its readable lines");
    });
});

describe("blank bills (complete-or-unknown)", () => {
    it("never says safe-to-load for a bill with no readable amount", () => {
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-101", receivedQty: 12, poUnitPrice: 10 }],
            [{ sku: "S-101", qty: 12, unitPrice: 0 }],
            { billTotal: 0 },
        );

        expect(v.disposition).toBe("review");
        expect(v.headline).not.toContain("Safe to load");
        expect(v.headline).toContain("unreadable");
    });
});

describe("OCR debris on the bill SKU (ULINE 125429)", () => {
    it("pairs S-473824 to S-4738 when qty and price agree", () => {
        // ULINE glues the case count onto the part number: S-4738 + 24.
        const v = checkDeliveryAgainstBill(
            [
                { sku: "S-4738", receivedQty: 1000, poUnitPrice: 2.43 },
                { sku: "S-17888", receivedQty: 14, poUnitPrice: 30.8 },
            ],
            [
                { sku: "S-473824", qty: 1000, unitPrice: 2.43, description: 'X 14 X 10" CORRUGATED BOXES' },
                { sku: "S-17888", qty: 14, unitPrice: 30.8 },
            ],
            { billTotal: 2861.2 },
        );

        expect(v.disposition).toBe("load");
        expect(v.overBilled).toBe(false);
        expect(v.lines.find((l) => l.sku === "S-4738")?.notDelivered).toBe(false);
    });

    it("does not pair a debris SKU whose price disagrees", () => {
        // Same prefix, but $3.00 billed vs $2.43 agreed — a real price problem.
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-4738", receivedQty: 1000, poUnitPrice: 2.43 }],
            [{ sku: "S-473824", qty: 1000, unitPrice: 3.0 }],
            { billTotal: 3000 },
        );

        expect(v.disposition).toBe("hold");
    });

    it("pairs on price agreement even when quantities differ", () => {
        // Billed 900 vs received 1000 at the same $2.43 is a genuine short
        // delivery on the SAME product — pair it so the shortage is named.
        const v = checkDeliveryAgainstBill(
            [{ sku: "S-4738", receivedQty: 1000, poUnitPrice: 2.43 }],
            [{ sku: "S-473824", qty: 900, unitPrice: 2.43 }],
            { billTotal: 2187 },
        );

        expect(v.lines[0].sku).toBe("S-4738");
        expect(v.lines[0].notDelivered).toBe(false);
    });
});

describe("ambiguous bill lines are not accusations", () => {
    it("does not charge an overbill for a line that names no delivered item", () => {
        // "S-23343" could be S-23343BL-M or S-23343L-M — identical qty and price.
        const v = checkDeliveryAgainstBill(
            [
                { sku: "S-23343BL-M", receivedQty: 2, poUnitPrice: 21 },
                { sku: "S-23343L-M", receivedQty: 2, poUnitPrice: 21 },
            ],
            [{ sku: "S-23343", qty: 2, unitPrice: 21 }],
            { billTotal: 42 },
        );

        expect(v.disposition).toBe("hold");
        expect(v.overBilled).toBe(false);
        expect(v.overBilledAmount).toBe(0);
        expect(v.headline).toContain("do not name a delivered item");
    });
});
