/**
 * @file    uline-confirmation.test.ts
 * @purpose Unit tests for Uline confirmation parse + required Ship Via gate.
 * @author  Hermia
 * @created 2026-08-05
 */
import { describe, expect, it } from "vitest";
import {
    ULINE_REQUIRED_SHIP_VIA,
    checkUlineShipVia,
    isUlineRequiredShipVia,
    parseUlineConfirmationEmail,
} from "./uline-confirmation";

describe("isUlineRequiredShipVia", () => {
    it("accepts canonical Freight Collect FEDEX FREIGHT", () => {
        expect(isUlineRequiredShipVia("Freight Collect FEDEX FREIGHT")).toBe(true);
        expect(isUlineRequiredShipVia(ULINE_REQUIRED_SHIP_VIA)).toBe(true);
    });

    it("accepts case/spacing variants", () => {
        expect(isUlineRequiredShipVia("FREIGHT COLLECT  FedEx Freight")).toBe(true);
        expect(isUlineRequiredShipVia("Ship Via: Freight Collect / FEDEX FREIGHT")).toBe(true);
        expect(isUlineRequiredShipVia("freight-collect fedex-freight")).toBe(true);
    });

    it("rejects prepaid, parcel, UPS, missing", () => {
        expect(isUlineRequiredShipVia("")).toBe(false);
        expect(isUlineRequiredShipVia(null)).toBe(false);
        expect(isUlineRequiredShipVia("UPS Ground")).toBe(false);
        expect(isUlineRequiredShipVia("FEDEX GROUND")).toBe(false);
        expect(isUlineRequiredShipVia("Freight Prepaid FEDEX FREIGHT")).toBe(false);
        expect(isUlineRequiredShipVia("Freight Collect")).toBe(false); // carrier missing
        expect(isUlineRequiredShipVia("FEDEX FREIGHT")).toBe(false); // collect missing
    });
});

describe("checkUlineShipVia", () => {
    it("ok on required method", () => {
        const r = checkUlineShipVia("Freight Collect FEDEX FREIGHT");
        expect(r.ok).toBe(true);
        expect(r.reasons).toEqual([]);
    });

    it("flags wrong methods with actionable reasons", () => {
        const r = checkUlineShipVia("UPS Ground");
        expect(r.ok).toBe(false);
        expect(r.reasons.some((x) => /Freight Collect/i.test(x))).toBe(true);
        expect(r.reasons.some((x) => /FEDEX FREIGHT/i.test(x))).toBe(true);
    });
});

describe("parseUlineConfirmationEmail shipVia", () => {
    it("extracts SHIP VIA from confirmation body", () => {
        const body = `
            ORDER # 99112233
            PO # 125999
            ORDER DATE 08/01/2026
            CUSTOMER NUMBER 12345
            SHIP VIA Freight Collect FEDEX FREIGHT
            TERMS NET 30
            QUANTITY U/M ITEM# DESCRIPTION UNIT EXT
            1 EA S-4122 BOX 1.00 1.00 T
            SUB-TOTAL $1.00
            TOTAL $1.00
        `;
        const parsed = parseUlineConfirmationEmail("Uline Order Confirmation", body, "msg-1");
        expect(parsed).not.toBeNull();
        expect(isUlineRequiredShipVia(parsed!.shipVia)).toBe(true);
    });
});
