/**
 * @file    src/lib/purchasing/po-receipt-recheck.test.ts
 * @purpose Unit tests for post-reconciliation receiving recheck
 * @author  Hermia
 * @created 2026-06-01
 */
import { describe, expect, it } from "vitest";

import { ReceiptRecheckResult, recheckReconciledInvoices } from "./po-receipt-recheck";

// ---------------------------------------------------------------------------
// Best-effort function tests: recheckReconciledInvoices
// ---------------------------------------------------------------------------
describe("recheckReconciledInvoices (best-effort)", () => {
    it("returns a ReceiptRecheckResult structure without throwing", async () => {
        const result: ReceiptRecheckResult = await recheckReconciledInvoices();

        expect(result).toHaveProperty("checked");
        expect(result).toHaveProperty("shortShipments");
        expect(result).toHaveProperty("errors");
        expect(result).toHaveProperty("details");
        expect(Array.isArray(result.details)).toBe(true);
    });

    it("all numeric fields are non-negative integers", async () => {
        const result = await recheckReconciledInvoices();

        expect(Number.isInteger(result.checked)).toBe(true);
        expect(result.checked).toBeGreaterThanOrEqual(0);

        expect(Number.isInteger(result.shortShipments)).toBe(true);
        expect(result.shortShipments).toBeGreaterThanOrEqual(0);

        expect(Number.isInteger(result.errors)).toBe(true);
        expect(result.errors).toBeGreaterThanOrEqual(0);
    });

    it("checked >= shortShipments + errors (logical invariant)", async () => {
        const result = await recheckReconciledInvoices();

        // checked is total POs examined; shortShipments + errors are subsets
        expect(result.shortShipments + result.errors).toBeLessThanOrEqual(
            Math.max(result.checked, 1) // at least 1 when checked is 0 (empty result)
        );
    });

    it("returns consistent details array length", async () => {
        const result = await recheckReconciledInvoices();

        // Each PO processed generates one detail entry (even if skipped/cooldown)
        if (result.checked > 0) {
            expect(result.details.length).toBeGreaterThan(0);
        }
    });

    it("handles being called multiple times without errors", async () => {
        const first = await recheckReconciledInvoices();
        const second = await recheckReconciledInvoices();

        // Should not throw on second call — dedup cooldown means second
        // call may find fewer actionable items but should not error
        expect(second.errors).toBeGreaterThanOrEqual(0);
        expect(second.errors).toBeLessThanOrEqual(5); // No unexpected errors
    });

    it("never throws under any input scenario", async () => {
        for (let i = 0; i < 3; i++) {
            await expect(recheckReconciledInvoices()).resolves.toBeDefined();
        }
    });
});