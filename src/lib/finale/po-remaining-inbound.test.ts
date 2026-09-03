/**
 * @file    src/lib/finale/po-remaining-inbound.test.ts
 * @purpose Tests for the phantom on-order fix. Every fixture below is a REAL
 *          shape observed in Finale on 2026-08-21 while researching why the
 *          POs backing OVERBUY_RISK verdicts were 98-182 days old.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    vitest
 * @env     none
 */

import { describe, it, expect } from "vitest";
import {
    parseFinaleQty,
    remainingInboundQty,
    isFullyReceivedStatus,
} from "./po-remaining-inbound";

describe("parseFinaleQty", () => {
    it("parses comma-formatted Finale strings", () => {
        expect(parseFinaleQty("1,300")).toBe(1300);
        expect(parseFinaleQty("50")).toBe(50);
    });
    it("treats Finale's '--' sentinel as untracked", () => {
        expect(parseFinaleQty("--")).toBeNull();
    });
    it("handles null / undefined / empty / junk", () => {
        expect(parseFinaleQty(null)).toBeNull();
        expect(parseFinaleQty(undefined)).toBeNull();
        expect(parseFinaleQty("")).toBeNull();
        expect(parseFinaleQty("abc")).toBeNull();
    });
    it("passes through real numbers, rejects NaN/Infinity", () => {
        expect(parseFinaleQty(240)).toBe(240);
        expect(parseFinaleQty(0)).toBe(0);
        expect(parseFinaleQty(NaN)).toBeNull();
        expect(parseFinaleQty(Infinity)).toBeNull();
    });
});

describe("remainingInboundQty — real Finale fixtures", () => {
    it("PO#124394 S-4122: Committed but FULLY RECEIVED 182d ago → 0 (the phantom)", () => {
        expect(
            remainingInboundQty({
                quantity: 500,
                productUnitsOrdered: "500",
                productUnitsReceived: "500",
                productUnitsRemainingToBePackedShippedOrReceived: "0",
            }),
        ).toBe(0);
    });

    it("PO#124623 S-4122: 1,300 ordered / 1,300 received → 0 (comma parsing)", () => {
        expect(
            remainingInboundQty({
                quantity: 1300,
                productUnitsOrdered: "1,300",
                productUnitsReceived: "1,300",
                productUnitsRemainingToBePackedShippedOrReceived: "0",
            }),
        ).toBe(0);
    });

    it("PO#125215 ALK101: genuinely open, 50 inbound → 50 (must NOT be suppressed)", () => {
        expect(
            remainingInboundQty({
                quantity: 50,
                productUnitsOrdered: "50",
                productUnitsReceived: "0",
                productUnitsRemainingToBePackedShippedOrReceived: "50",
            }),
        ).toBe(50);
    });

    it("PO#124636 ULS455: order 'Partially received' but THIS line settled → 0", () => {
        // Line-level truth beats the order-level roll-up: the PO is partially
        // received overall, yet this SKU's line has nothing left to arrive.
        expect(
            remainingInboundQty({
                quantity: 250,
                productUnitsOrdered: "250",
                productUnitsReceived: "250",
                productUnitsRemainingToBePackedShippedOrReceived: "0",
            }),
        ).toBe(0);
    });

    it("partially received line credits only the outstanding balance", () => {
        expect(
            remainingInboundQty({
                quantity: 1000,
                productUnitsOrdered: "1,000",
                productUnitsReceived: "400",
                productUnitsRemainingToBePackedShippedOrReceived: "600",
            }),
        ).toBe(600);
    });

    it("PO#125221 ULS455 Draft: all receipt fields '--' → falls back to ordered qty", () => {
        // A Draft PO cannot have received anything, so quantity IS the balance.
        expect(
            remainingInboundQty({
                quantity: 240,
                productUnitsOrdered: "--",
                productUnitsReceived: "--",
                productUnitsRemainingToBePackedShippedOrReceived: "--",
            }),
        ).toBe(240);
    });

    it("derives remaining from ordered − received when remaining is untracked", () => {
        expect(
            remainingInboundQty({
                quantity: 100,
                productUnitsOrdered: "100",
                productUnitsReceived: "30",
                productUnitsRemainingToBePackedShippedOrReceived: "--",
            }),
        ).toBe(70);
    });

    it("floors over-receipt at 0 rather than returning a negative credit", () => {
        expect(
            remainingInboundQty({
                quantity: 100,
                productUnitsOrdered: "100",
                productUnitsReceived: "120",
                productUnitsRemainingToBePackedShippedOrReceived: "--",
            }),
        ).toBe(0);
        expect(
            remainingInboundQty({
                productUnitsRemainingToBePackedShippedOrReceived: "-5",
            }),
        ).toBe(0);
    });

    it("returns 0 when the line carries no usable numbers at all", () => {
        expect(remainingInboundQty({})).toBe(0);
        expect(
            remainingInboundQty({
                quantity: "--",
                productUnitsOrdered: "--",
                productUnitsReceived: "--",
                productUnitsRemainingToBePackedShippedOrReceived: "--",
            }),
        ).toBe(0);
    });

    it("prefers Finale's remaining field over ordered−received when they conflict", () => {
        // Finale's own answer wins; we do not second-guess it.
        expect(
            remainingInboundQty({
                productUnitsOrdered: "1,000",
                productUnitsReceived: "0",
                productUnitsRemainingToBePackedShippedOrReceived: "0",
            }),
        ).toBe(0);
    });
});

describe("isFullyReceivedStatus", () => {
    it("detects Finale's fully-received extended status", () => {
        expect(isFullyReceivedStatus("Committed · Fully received")).toBe(true);
        expect(isFullyReceivedStatus("committed · fully received")).toBe(true);
    });
    it("does not match partial / not-received / draft", () => {
        expect(isFullyReceivedStatus("Committed · Partially received")).toBe(false);
        expect(isFullyReceivedStatus("Committed · Not received")).toBe(false);
        expect(isFullyReceivedStatus("Draft · Not received")).toBe(false);
        expect(isFullyReceivedStatus(null)).toBe(false);
        expect(isFullyReceivedStatus(undefined)).toBe(false);
    });
});
