/**
 * @file    active-po-status.test.ts
 * @purpose Active Purchases must accept BOTH Finale and po-sync status vocab.
 *          Cache path was returning 0 because po-sync writes `open` while
 *          the consumer only admitted `committed`/`completed`.
 * @author  Hermia
 * @created 2026-09-21
 * @deps    vitest, ./active-po-status
 */

import { describe, expect, it } from "vitest";
import { isActivePoStatus } from "./active-po-status";

describe("isActivePoStatus", () => {
    it("treats Finale Committed as active", () => {
        expect(isActivePoStatus("Committed")).toBe(true);
        expect(isActivePoStatus("committed")).toBe(true);
    });

    it("treats po-sync open as active (Committed is rewritten to open before cache)", () => {
        expect(isActivePoStatus("open")).toBe(true);
    });

    it("treats Finale Completed as active (live path already did)", () => {
        expect(isActivePoStatus("Completed")).toBe(true);
        expect(isActivePoStatus("completed")).toBe(true);
    });

    it("treats partial as active", () => {
        expect(isActivePoStatus("partial")).toBe(true);
        expect(isActivePoStatus("Partial")).toBe(true);
    });

    it("rejects normalized received — that is terminal, not Active", () => {
        expect(isActivePoStatus("received")).toBe(false);
        expect(isActivePoStatus("Received")).toBe(false);
    });

    it("rejects closed / cancelled", () => {
        expect(isActivePoStatus("closed")).toBe(false);
        expect(isActivePoStatus("Cancelled")).toBe(false);
        expect(isActivePoStatus("Canceled")).toBe(false);
    });

    it("rejects empty / unknown", () => {
        expect(isActivePoStatus("")).toBe(false);
        expect(isActivePoStatus(null)).toBe(false);
        expect(isActivePoStatus(undefined)).toBe(false);
        expect(isActivePoStatus("unknown")).toBe(false);
    });
});
