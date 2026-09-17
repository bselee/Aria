import { describe, expect, it } from "vitest";

import { isStatementSubject } from "./ap-local-forwarder";

describe("isStatementSubject", () => {
    it("catches 'Statement from LOGAN LABS LLC' (bill 3457 regression)", () => {
        expect(isStatementSubject("Statement from LOGAN LABS LLC")).toBe(true);
    });

    it("catches French Berger statement subject", () => {
        expect(isStatementSubject("STATEMENT/RELEVÉ DE COMPTE")).toBe(true);
        expect(isStatementSubject("Relevé de compte")).toBe(true);
    });

    it("catches monthly/account statement subjects", () => {
        expect(isStatementSubject("Monthly Statement")).toBe(true);
        expect(isStatementSubject("Statement of Account")).toBe(true);
    });

    it("does NOT catch AAA Cooper 'Invoice Stmt … Pro#' (that is an invoice)", () => {
        expect(isStatementSubject("Invoice Stmt - Cust 0001159492 Pro#: 64058448")).toBe(false);
        expect(isStatementSubject("Invoice Statement - Cust 0001159492 Pro#: 64058448")).toBe(false);
    });

    it("does NOT catch a normal invoice subject", () => {
        expect(isStatementSubject("Invoice 3457 from LOGAN LABS LLC")).toBe(false);
        expect(isStatementSubject("Uline Invoice 211897049 ID# 16")).toBe(false);
    });
});
