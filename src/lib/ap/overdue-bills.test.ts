/**
 * @file    src/lib/ap/overdue-bills.test.ts
 * @purpose Behaviour lock for overdue-bill parsing, aging and Friday run planning.
 * @author  Hermia
 * @created 2026-10-26
 * @deps    vitest, ./overdue-bills
 * @env     none
 */
import { describe, expect, it } from "vitest";
import {
  bucketOf,
  buildOverdueModel,
  buildPaymentPlan,
  daysBetween,
  firstFridayAfter,
  isoFromUs,
  money,
  parseBillsCsv,
  selectOverdue,
  sumAmount,
} from "./overdue-bills";

const HEADER =
  "Invoice no.,Description,Vendor,Chart of account,Item,Bill type,Created date,PO no.,Invoice date,Due date,Approval status,Currency,Invoice amount,Balance due,Payment status,Process date,Type ➔ Arrival date,Payment amount";

const CSV = `\uFEFF${HEADER}
64471690,,AAA Cooper Transportation,Shipping,  ,Manual,10/26/2026,,06/20/2026,06/27/2026,Unassigned,USD,411.73,411.73,Unpaid,10/27/2026,ePayment --> 10/28,411.73
"10,222,026",,Miles Filippelli,Inventory,,Manual,10/22/2026,,10/22/2026,10/22/2026,Unassigned,USD,"1,250.00",650.00,Unpaid,10/27/2026,ePayment --> 10/28,650.00
9-388-19130,,FedEx,Freight,,Manual,10/26/2026,,07/21/2026,07/21/2026,Unassigned,USD,16589.60,16589.60,Unpaid,10/27/2026,Check --> 10/30,16589.60
136333,,Logan Labs LLC,Cost of Sales,,Auto-saved,10/25/2026,,10/25/2026,10/25/2026,Unassigned,USD,81,81,Unpaid,10/27/2026,Check --> 10/30,81
999001,,Paid Vendor,Inventory,,Manual,10/01/2026,,09/01/2026,09/01/2026,Unassigned,USD,500,0,Paid,09/02/2026,ePayment --> 09/03,500
999002,,Future Vendor,Inventory,,Manual,10/20/2026,,10/20/2026,12/01/2026,Unassigned,USD,300,300,Unpaid,11/26/2026,ePayment --> 11/27,300
`;

const AS_OF = "2026-10-26";

describe("parseBillsCsv", () => {
  it("strips the BOM and keeps quoted commas in invoice numbers and amounts", () => {
    const rows = parseBillsCsv(CSV);
    expect(rows).toHaveLength(6);
    expect(rows[1].invoiceNo).toBe("10,222,026");
    expect(rows[1].invoiceAmount).toBe(1250);
    expect(rows[1].balanceDue).toBe(650);
    expect(rows[0].vendor).toBe("AAA Cooper Transportation");
    expect(rows[0].processDate).toBe("2026-10-27");
  });

  it("returns an empty array for a header-only file", () => {
    expect(parseBillsCsv(HEADER)).toEqual([]);
  });
});

describe("date helpers", () => {
  it("converts Bill.com MM/DD/YYYY to ISO", () => {
    expect(isoFromUs("6/7/2026")).toBe("2026-06-07");
    expect(isoFromUs("11/21/2026")).toBe("2026-11-21");
    expect(isoFromUs("n/a")).toBe("");
  });

  it("counts whole days between ISO dates", () => {
    expect(daysBetween("2026-06-27", "2026-10-26")).toBe(121);
    expect(daysBetween("2026-10-26", "2026-10-26")).toBe(0);
  });

  it("finds the next Friday strictly after a Monday", () => {
    expect(firstFridayAfter("2026-10-26")).toBe("2026-10-30");
    expect(firstFridayAfter("2026-10-30")).toBe("2026-11-06");
  });
});

describe("selectOverdue", () => {
  const overdue = selectOverdue(parseBillsCsv(CSV), AS_OF);

  it("keeps only past-due bills with a balance, oldest first", () => {
    expect(overdue.map((b) => b.invoiceNo)).toEqual([
      "64471690",
      "9-388-19130",
      "10,222,026",
      "136333",
    ]);
    expect(overdue[0].daysOverdue).toBe(121);
    expect(overdue[2].daysOverdue).toBe(4);
  });

  it("drops paid bills and bills due in the future", () => {
    expect(overdue.some((b) => b.vendor === "Paid Vendor")).toBe(false);
    expect(overdue.some((b) => b.vendor === "Future Vendor")).toBe(false);
  });

  it("ages into the right bucket", () => {
    expect(overdue.map((b) => bucketOf(b.daysOverdue))).toEqual(["90+", "90+", "1-14", "1-14"]);
  });
});

describe("buildPaymentPlan", () => {
  const bills = parseBillsCsv(CSV);
  const overdue = selectOverdue(bills, AS_OF);
  const runs = buildPaymentPlan(overdue, AS_OF, bills, 3);

  it("lays out four Fridays and leaves the last one with no catch-up", () => {
    expect(runs.map((r) => r.date)).toEqual([
      "2026-10-30",
      "2026-11-06",
      "2026-11-13",
      "2026-11-20",
    ]);
    expect(runs[3].bills).toHaveLength(0);
    expect(runs[3].overdueAmount).toBe(0);
  });

  it("never plans a FedEx bill", () => {
    const planned = runs.flatMap((r) => r.bills.map((b) => b.invoiceNo));
    expect(planned).not.toContain("9-388-19130");
  });

  it("plans every payable bill exactly once", () => {
    const planned = runs.flatMap((r) => r.bills);
    const payable = overdue.filter((b) => !/^fedex/i.test(b.vendor));
    expect(planned).toHaveLength(payable.length);
    expect(sumAmount(planned)).toBeCloseTo(sumAmount(payable), 2);
    expect(new Set(planned.map((b) => b.invoiceNo)).size).toBe(payable.length);
  });

  it("pays the oldest band first", () => {
    expect(runs[0].bills.every((b) => b.daysOverdue > 60)).toBe(true);
    expect(runs[1].bills.length === 0 || runs[1].bills.every((b) => b.daysOverdue > 14)).toBe(true);
    expect(runs[2].bills.every((b) => b.daysOverdue <= 14)).toBe(true);
  });
});

describe("buildOverdueModel", () => {
  const model = buildOverdueModel(CSV, AS_OF, "fixture.csv", "2026-10-26T14:00:00Z");

  it("separates verify-only vendors from the payable stack", () => {
    expect(model.excluded.map((b) => b.invoiceNo)).toEqual(["9-388-19130"]);
    expect(model.excludedAmount).toBe(16589.6);
    expect(model.totalOverdue).toBeCloseTo(411.73 + 650 + 81, 2);
    expect(model.totalOverdueIncludingExcluded).toBeCloseTo(411.73 + 650 + 81 + 16589.6, 2);
  });

  it("reports aging buckets that reconcile to the payable total", () => {
    const bucketSum = model.buckets.reduce((a, b) => a + b.amount, 0);
    expect(bucketSum).toBeCloseTo(model.totalOverdue, 2);
  });

  it("formats currency with cents", () => {
    expect(money(16589.6)).toBe("$16,589.60");
  });
});
