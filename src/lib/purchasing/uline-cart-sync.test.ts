import { describe, it, expect } from "vitest";
import {
    planCartToPOSync,
    formatSyncPlanForCLI,
    type ExpectedItem,
    type ObservedUlineCartRow,
} from "./uline-cart-sync";
import type { CartVerificationResult } from "../../cli/order-uline-cart";

function expected(over: Partial<ExpectedItem> = {}): ExpectedItem {
    return {
        finaleSku: "S-1234",
        ulineModel: "S-1234",
        quantity: 10,
        unitPrice: 5.5,
        ...over,
    };
}

function observed(over: Partial<ObservedUlineCartRow> = {}): ObservedUlineCartRow {
    return {
        ulineModel: "S-1234",
        quantity: 10,
        unitPrice: 5.5,
        lineTotal: 55,
        ...over,
    };
}

function verification(over: Partial<CartVerificationResult> = {}): CartVerificationResult {
    return {
        status: "verified",
        matchedModels: [],
        missingModels: [],
        quantityMismatches: [],
        unexpectedModels: [],
        ...over,
    };
}

// ── planCartToPOSync ───────────────────────────────────────────────────────

describe("planCartToPOSync — exact match", () => {
    it("emits no drift when cart matches PO exactly", () => {
        const plan = planCartToPOSync(
            [expected({ ulineModel: "S-1234" })],
            [observed({ ulineModel: "S-1234" })],
            verification({ matchedModels: ["S-1234"] }),
        );
        expect(plan.hasDrift).toBe(false);
        expect(plan.matched).toEqual(["S-1234"]);
    });
});

describe("planCartToPOSync — extras in cart (manual adds)", () => {
    it("captures items in cart not on PO with qty + price from cart", () => {
        // Will manually added S-9999 before running the script.
        const plan = planCartToPOSync(
            [expected({ ulineModel: "S-1234" })],
            [
                observed({ ulineModel: "S-1234" }),
                observed({ ulineModel: "S-9999", quantity: 4, unitPrice: 12.5 }),
            ],
            verification({
                matchedModels: ["S-1234"],
                unexpectedModels: ["S-9999"],
            }),
        );
        expect(plan.hasDrift).toBe(true);
        expect(plan.addToPO).toHaveLength(1);
        expect(plan.addToPO[0]).toEqual({
            ulineModel: "S-9999",
            quantity: 4,
            unitPrice: 12.5,
            suggestedFinaleSku: "S-9999",
        });
    });

    it("handles missing cart price gracefully (passes null through)", () => {
        const plan = planCartToPOSync(
            [],
            [observed({ ulineModel: "S-7777", quantity: 2, unitPrice: null })],
            verification({ unexpectedModels: ["S-7777"] }),
        );
        expect(plan.addToPO[0].unitPrice).toBeNull();
    });
});

describe("planCartToPOSync — missing from cart (out of stock / removed)", () => {
    it("flags PO items not present in cart for removal review", () => {
        const plan = planCartToPOSync(
            [
                expected({ ulineModel: "S-1234", finaleSku: "S-1234" }),
                expected({ ulineModel: "S-5678", finaleSku: "S-5678", quantity: 20 }),
            ],
            [observed({ ulineModel: "S-1234" })],
            verification({
                matchedModels: ["S-1234"],
                missingModels: ["S-5678"],
            }),
        );
        expect(plan.removeFromPO).toHaveLength(1);
        expect(plan.removeFromPO[0]).toEqual({
            finaleSku: "S-5678",
            ulineModel: "S-5678",
            quantity: 20,
        });
    });
});

describe("planCartToPOSync — quantity mismatch (Will reduced)", () => {
    it("captures qty diff with PO follows cart", () => {
        // Aria suggested 50, Will reduced to 30 in cart.
        const plan = planCartToPOSync(
            [expected({ ulineModel: "S-1234", quantity: 50 })],
            [observed({ ulineModel: "S-1234", quantity: 30 })],
            verification({
                quantityMismatches: [{
                    ulineModel: "S-1234",
                    expectedQuantity: 50,
                    observedQuantity: 30,
                }],
            }),
        );
        expect(plan.updateQuantity).toHaveLength(1);
        expect(plan.updateQuantity[0]).toEqual({
            finaleSku: "S-1234",
            ulineModel: "S-1234",
            poQuantity: 50,
            cartQuantity: 30,
            unitPrice: 5.5,
        });
    });
});

describe("planCartToPOSync — combined drift scenario", () => {
    it("handles all three drift types together", () => {
        const plan = planCartToPOSync(
            [
                expected({ ulineModel: "S-MATCH", finaleSku: "S-MATCH" }),
                expected({ ulineModel: "S-REDUCED", finaleSku: "S-REDUCED", quantity: 100 }),
                expected({ ulineModel: "S-DROPPED", finaleSku: "S-DROPPED", quantity: 5 }),
            ],
            [
                observed({ ulineModel: "S-MATCH" }),
                observed({ ulineModel: "S-REDUCED", quantity: 50 }),
                observed({ ulineModel: "S-MANUAL", quantity: 2, unitPrice: 99 }),
            ],
            verification({
                matchedModels: ["S-MATCH"],
                quantityMismatches: [{ ulineModel: "S-REDUCED", expectedQuantity: 100, observedQuantity: 50 }],
                missingModels: ["S-DROPPED"],
                unexpectedModels: ["S-MANUAL"],
            }),
        );
        expect(plan.hasDrift).toBe(true);
        expect(plan.addToPO).toHaveLength(1);
        expect(plan.removeFromPO).toHaveLength(1);
        expect(plan.updateQuantity).toHaveLength(1);
        expect(plan.matched).toEqual(["S-MATCH"]);
    });
});

// ── formatSyncPlanForCLI ───────────────────────────────────────────────────

describe("formatSyncPlanForCLI", () => {
    it("renders 'matches PO exactly' when no drift", () => {
        const out = formatSyncPlanForCLI({
            addToPO: [], removeFromPO: [], updateQuantity: [],
            matched: ["S-1234", "S-5678"], hasDrift: false,
        });
        expect(out).toMatch(/matches PO exactly/);
        expect(out).toMatch(/2 items/);
    });

    it("renders each drift section when present", () => {
        const out = formatSyncPlanForCLI({
            addToPO: [{ ulineModel: "S-X", quantity: 3, unitPrice: 5, suggestedFinaleSku: "S-X" }],
            removeFromPO: [{ ulineModel: "S-Y", finaleSku: "S-Y", quantity: 1 }],
            updateQuantity: [{ ulineModel: "S-Z", finaleSku: "S-Z", poQuantity: 10, cartQuantity: 5 }],
            matched: [],
            hasDrift: true,
        });
        expect(out).toMatch(/In cart, NOT on PO/);
        expect(out).toMatch(/On PO, NOT in cart/);
        expect(out).toMatch(/Quantity mismatches/);
        expect(out).toMatch(/S-X/);
        expect(out).toMatch(/S-Y/);
        expect(out).toMatch(/S-Z/);
    });
});
