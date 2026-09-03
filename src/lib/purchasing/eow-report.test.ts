/**
 * @file    eow-report.test.ts
 * @purpose Unit tests for Friday purchasing-week helpers
 * @author  Hermia
 * @created 2026-09-03
 * @deps    vitest, eow-report
 * @env     none
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  excludeManualVendor,
  invoiceAmountLabel,
  isDropshipVendor,
  isStatement,
  mdFromIso,
  mondayOf,
  money,
  needByIso,
  withinDays,
} from "./eow-report";

describe("eow-report", () => {
  it("mondayOf lands on Monday even when today is Thursday", () => {
    expect(mondayOf("2026-09-03")).toBe("2026-08-31");
  });

  it("addDays and mdFromIso format teammate dates", () => {
    expect(addDays("2026-08-31", 4)).toBe("2026-09-04");
    expect(mdFromIso("2026-09-11")).toBe("9/11");
  });

  it("treats AAA Cooper Stmt subjects as invoices", () => {
    expect(
      isStatement(
        "AAA COOPER TRANSPORTATION <act.statement@aaacooper.com>",
        "Invoice Stmt - Cust 0001159492 Pro#: 64058444",
        "64058444_AAA_Cooper_Transportation.pdf"
      )
    ).toBe(false);
  });

  it("treats Berger RELEVE as a statement", () => {
    expect(
      isStatement("Recevable Berger", "STATEMENT/RELEVÉ DE COMPTE", "BUIAS1.pdf")
    ).toBe(true);
  });

  it("labels dropship blanks Dropshipped and keeps verified dollars", () => {
    expect(isDropshipVendor("AutoPot")).toBe(true);
    expect(invoiceAmountLabel("AutoPot", 0)).toBe("Dropshipped");
    expect(invoiceAmountLabel("Uline", 234)).toBe("$234");
    expect(invoiceAmountLabel("Logan Labs", 0)).toBe("");
  });

  it("hides ASLE / Sticker Giant from upcoming", () => {
    expect(excludeManualVendor("ASLE", "OAG229")).toBe(true);
    expect(excludeManualVendor("Rootwise", "RMC104")).toBe(false);
  });

  it("upcoming 30-day window uses runway as needed-by", () => {
    expect(needByIso("2026-09-03", 0)).toBe("2026-09-03");
    expect(needByIso("2026-09-03", 29.7)).toBe("2026-10-02");
    expect(withinDays("2026-10-03", "2026-09-03", 30)).toBe(true);
    expect(withinDays("2026-10-06", "2026-09-03", 30)).toBe(false);
    expect(money(27433.19)).toBe("$27,433");
  });
});
