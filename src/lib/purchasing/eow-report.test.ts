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
  priceVendorName,
  researchHit,
  shortPriceNote,
  keepSilentVendorDelay,
  isPartialReceived,
  isPartialFromFinaleReceive,
  minRunway,
  parseVendorDueFromText,
  delayedVendorNote,
  daysBetween,
  openPricingWins,
  keepUpcomingAmount,
  prettyUserLogin,
  receiverFromStatusHistory,
  poLines,
  skuListOf,
  lineQtyOf,
  withQty,
  withinDays,
  boxDimKey,
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

  it("shortens price-update notes and names Concentrates", () => {
    expect(
      shortPriceNote(
        "Kayla",
        "RE: PO 125257",
        "Hi Bill! Unfortunately, the shortage on fish meal has created a huge inflation on the material. The new price on a pallet is $84.39."
      )
    ).toBe("FM104 raised. Cut to 1 pallet.");
    expect(priceVendorName("Kayla Hale <Kayla@concentratesnw.com>", "ack")).toBe("Concentrates");
  });

  it("researchHit returns company and product, not email snippets", () => {
    expect(
      researchHit("Lauren Taranow <lauren@symtonbsf.com>", "Re: Frass by the tote", "price per tote is $250")
    ).toEqual({
      sku: "",
      vendor: "Symton",
      note: "Frass tote. Freight on us. 2/mo. Testing pending.",
    });
    expect(
      researchHit(
        "Green Cover Seed <support@greencoverseed.zohodesk.com>",
        "[## 31853 ##] Cover crop",
        "mix and shipping"
      )?.vendor
    ).toBe("Green Cover");
    expect(
      researchHit(
        "Green Cover Seed <support@greencoverseed.zohodesk.com>",
        "[## 31853 ##] Cover crop",
        "mix and shipping"
      )?.note
    ).toContain("$1.74/lb");
    expect(researchHit("HVH <info@hvhindustrial.com>", "vacuum pumps", "DVP distributor")).toBeNull();
    expect(researchHit("Landon <landon@drivensol.com>", "soil bags quote", "MOQ bags")).toBeNull();
  });

  it("Rootwise delayed only when a SKU is close to out of stock", () => {
    expect(keepSilentVendorDelay("Rootwise Soil Dynamics", 137)).toBe(false);
    expect(keepSilentVendorDelay("Rootwise Soil Dynamics", 63)).toBe(false);
    expect(keepSilentVendorDelay("Rootwise Soil Dynamics", 21)).toBe(true);
    expect(keepSilentVendorDelay("Rootwise Soil Dynamics", null)).toBe(false);
    expect(keepSilentVendorDelay("Certis USA", 142)).toBe(true);
    expect(minRunway([137, 63])).toBe(63);
  });

  it("drops partial receipts from delayed", () => {
    expect(isPartialReceived(400, 560)).toBe(true);
    expect(isPartialReceived(0, 960)).toBe(false);
    expect(
      isPartialFromFinaleReceive(null, "2026-05-19", "2026-10-19")
    ).toBe(true);
    expect(
      isPartialFromFinaleReceive("2026-08-19", "2026-05-19", "2026-10-19")
    ).toBe(false);
  });

  it("reads Certis backorder month and North Mason silence from email", () => {
    expect(
      parseVendorDueFromText("I am sorry to say but we are now on backorder until January, 2027.\n\nLee")
    ).toBe("2027-01-01");
    expect(
      parseVendorDueFromText(
        "We are trying to get it done. There have been staffing issues we are working through. I’ll know by Friday when it can be done."
      )
    ).toBeNull();
    expect(
      delayedVendorNote({
        emailDueIso: "2027-01-01",
        pgEtaIso: "2026-08-19",
        lastVendorReplyIso: "2026-08-12",
        todayIso: "2026-10-19",
        backorder: true,
      })
    ).toBe("Backorder Jan 2027");
    expect(
      delayedVendorNote({
        emailDueIso: null,
        pgEtaIso: "2026-06-25",
        lastVendorReplyIso: "2026-07-23",
        todayIso: "2026-10-19",
      })
    ).toBe("No reply since 7/23");
    expect(daysBetween("2026-04-29", "2026-10-19")).toBe(173);
  });

  it("pricing wins stay until resolved and upcoming floor drops trivia", () => {
    const open = openPricingWins();
    expect(open.every((w) => !w.resolved)).toBe(true);
    expect(
      openPricingWins([{ sku: "X", product: "p", vendor: "V", detail: "d", annual: "$1", status: "s", resolved: true }])
    ).toEqual([]);
    expect(keepUpcomingAmount(36)).toBe(false);
    expect(keepUpcomingAmount(0)).toBe(true);
    expect(keepUpcomingAmount(133)).toBe(true);
  });

  it("sums duplicate PO lines and keeps SKU/qty aligned", () => {
    const items = [
      { productId: "S-1665", quantity: 1 },
      { productId: "A", quantity: 3 },
      { productId: "S-1665", quantity: 2 },
    ];
    expect(poLines(items)).toEqual([
      { id: "S-1665", qty: 3 },
      { id: "A", qty: 3 },
    ]);
    expect(skuListOf(items)).toBe("S-1665, A");
    expect(lineQtyOf(items)).toBe("3, 3");
    expect(withQty(skuListOf(items), lineQtyOf(items))).toBe("S-1665 ×3, A ×3");
    expect(poLines("not json")).toEqual([]);
    expect(poLines([{ quantity: 5 }])).toEqual([]);
  });

  it("pools the same carton size across vendor SKUs", () => {
    // Uline lists 30x15x15, our build lists 15x15x30 — same carton.
    expect(boxDimKey('Corrugated Boxes - (30"x15"x15") /15')).toBe("15x15x30");
    expect(boxDimKey('Corrugated Boxes - (15"x15"x30") /15')).toBe("15x15x30");
    expect(boxDimKey('30"x15"x15" Box Build - 15/Unit')).toBe("15x15x30");
    expect(boxDimKey("Corrugated Boxes - (24x16x6)")).toBe("6x16x24");
    expect(boxDimKey("Non-Metallic Handy Box")).toBeNull();
    expect(boxDimKey("Coconut Water Powder - (20kilo Box - 44lb) Raw")).toBeNull();
  });

  it("resolves the receiving user from shipment status history", () => {
    expect(
      receiverFromStatusHistory([
        { statusId: null, txStamp: 1792184734, userLoginUrl: "/buildasoilorganics/api/userlogin/nicholas.kubin" },
        { statusId: "SHIPMENT_DELIVERED", txStamp: 1792184736, userLoginUrl: "/buildasoilorganics/api/userlogin/nicholas.kubin" },
      ])
    ).toBe("NK");
    expect(receiverFromStatusHistory([])).toBe("");
    expect(receiverFromStatusHistory(null)).toBe("");
    expect(prettyUserLogin("bill")).toBe("Bill");
    expect(prettyUserLogin("bill.selee")).toBe("BS");
  });
});
