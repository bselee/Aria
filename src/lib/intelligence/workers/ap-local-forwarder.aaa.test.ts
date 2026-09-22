import { describe, expect, it } from "vitest";

import { extractAaaProNumber, buildAaaCooperFilename } from "./ap-local-forwarder";

describe("extractAaaProNumber", () => {
    it("extracts Pro# from 'Invoice Stmt - Cust ... Pro#: 64058450'", () => {
        expect(extractAaaProNumber("Invoice Stmt - Cust 0001159492 Pro#: 64058450")).toBe("64058450");
    });

    it("extracts Pro# without colon ('Pro # 64058448')", () => {
        expect(extractAaaProNumber("Invoice Stmt - Cust 0001159492 Pro # 64058448")).toBe("64058448");
    });

    it("extracts a bare Pro# subject", () => {
        expect(extractAaaProNumber("  64058905 ")).toBe("64058905");
    });

    it("returns null when no Pro#", () => {
        expect(extractAaaProNumber("Account 1159492 - BUILDASOIL")).toBeNull();
    });
});

describe("buildAaaCooperFilename", () => {
    it("labels the invoice with the Pro#", () => {
        expect(buildAaaCooperFilename("64058450")).toBe("64058450_AAA_Cooper_Transportation.pdf");
    });
});
