/**
 * @file    src/lib/ap/payments-out.test.ts
 * @purpose Behaviour lock for Payments Out parsing and bill allocation.
 * @author  Hermia
 * @created 2026-10-26
 * @deps    vitest, ./payments-out, ./overdue-bills
 * @env     none
 */
import { describe, expect, it } from "vitest";
import { applyPayments, parsePaymentsCsv } from "./payments-out";
import { buildOverdueModel, parseBillsCsv } from "./overdue-bills";

const BILLS_HEADER =
  "Invoice no.,Description,Vendor,Chart of account,Item,Bill type,Created date,PO no.,Invoice date,Due date,Approval status,Currency,Invoice amount,Balance due,Payment status,Process date,Type ➔ Arrival date,Payment amount";

const BILLS_CSV = `\uFEFF${BILLS_HEADER}
6401,,Coastal Freight Lines,Shipping,,Manual,10/26/2026,,06/20/2026,06/27/2026,Unassigned,USD,411.73,411.73,Unpaid,10/27/2026,ePayment --> 10/28,411.73
6402,,Coastal Freight Lines,Shipping,,Manual,10/26/2026,,06/23/2026,06/30/2026,Unassigned,USD,547.86,547.86,Unpaid,10/27/2026,ePayment --> 10/28,547.86
U1,,Uline,Shipping Supplies,,Manual,10/26/2026,,10/07/2026,10/14/2026,Unassigned,USD,"1,987.76","1,987.76",Unpaid,10/27/2026,ePayment --> 10/28,1987.76
U2,,Uline,Shipping Supplies,,Manual,10/26/2026,,10/10/2026,10/17/2026,Unassigned,USD,"2,262.99","2,262.99",Unpaid,10/27/2026,ePayment --> 10/28,2262.99
136044,,"Logan Labs, LLC",Cost of Sales,,Auto-saved,10/26/2026,,10/15/2026,10/15/2026,Unassigned,USD,162,162,Unpaid,10/27/2026,Check --> 10/30,162
B1,,Berger Horticultural Products LTD,Inventory,,Manual,10/26/2026,,04/23/2026,08/21/2026,Unassigned,USD,"13,981.50","13,981.50",Unpaid,10/27/2026,ePayment --> 10/28,13981.50
`;

const PAYMENTS_HEADER =
  "Confirmation number,Vendor,Process date,Payment status,Payment method,Payment amount,Arrival date,Invoice number,Paid from,Expires on,Vendor credit,Currency";

const PAYMENTS_CSV = `\uFEFF${PAYMENTS_HEADER}
P1 - 1,Coastal Freight Lines,"Oct 27, 2026",Scheduled,ePayment,500.00,"Oct 28, 2026",Multiple,Relay ****2318,,0,USD
P1 - 2,Uline,"Oct 27, 2026",Scheduled,ePayment,"4,250.75","Oct 28, 2026",Multiple,Relay ****2318,,0,USD
P1 - 3,"Logan Labs, LLC","Oct 27, 2026",Scheduled,Check,162.00,"Oct 30, 2026",136044,Relay ****2318,,0,USD
P1 - 4,Uline,"Oct 27, 2026",Scheduled,ePayment,100.00,"Oct 28, 2026",Multiple,Relay ****2318,,0,USD
P1 - 5,Berger Horticultural Products LTD,"Oct 27, 2026",Scheduled,ePayment,"13,000.00","Oct 28, 2026",B1,Relay ****2318,,0,USD
P1 - 6,Coastal Freight Lines,"Sep 28, 2026",Cleared,ePayment,999.00,"Sep 29, 2026",Multiple,Relay ****2318,,0,USD
P1 - 7,Berger Horticultural Products LTD,"Oct 27, 2026",Voided,ePayment,"13,981.50","Oct 28, 2026",B1,Relay ****2318,,0,USD
`;

const AS_OF = "2026-10-26";

describe("parsePaymentsCsv", () => {
  const rows = parsePaymentsCsv(PAYMENTS_CSV);

  it("reads 7 rows with ISO dates and numeric amounts", () => {
    expect(rows).toHaveLength(7);
    expect(rows[0].processDate).toBe("2026-10-27");
    expect(rows[0].arrivalDate).toBe("2026-10-28");
    expect(rows[1].amount).toBe(4250.75);
    expect(rows[2].vendor).toBe("Logan Labs, LLC");
    expect(rows[2].invoiceNumber).toBe("136044");
  });

  it("returns an empty array for a header-only file", () => {
    expect(parsePaymentsCsv(PAYMENTS_HEADER)).toEqual([]);
  });
});

describe("applyPayments", () => {
  const bills = parseBillsCsv(BILLS_CSV);
  const payments = parsePaymentsCsv(PAYMENTS_CSV);
  const result = applyPayments(bills, payments, AS_OF);
  const paidOf = (vendor: string, invoice: string): number => {
    const bill = bills.find((b) => b.vendor === vendor && b.invoiceNo === invoice);
    return bill ? (result.paidByBill.get(`${bill.vendor}|${bill.invoiceNo}|${bill.dueDate}|${bill.balanceDue}`) ?? 0) : -1;
  };

  it("applies a specific invoice payment exactly", () => {
    expect(paidOf("Logan Labs, LLC", "136044")).toBe(162);
  });

  it("allocates a Multiple payment across the oldest invoices first", () => {
    expect(paidOf("Coastal Freight Lines", "6401")).toBe(411.73);
    expect(paidOf("Coastal Freight Lines", "6402")).toBeCloseTo(88.27, 2);
    expect(paidOf("Uline", "U1")).toBe(1987.76);
    expect(paidOf("Uline", "U2")).toBe(2262.99);
  });

  it("applies a partial payment and leaves the remainder open", () => {
    expect(paidOf("Berger Horticultural Products LTD", "B1")).toBe(13000);
  });

  it("ignores payments processed before the as-of date", () => {
    expect(result.rows.some((r) => r.payment.confirmation === "P1 - 6")).toBe(false);
    expect(paidOf("Coastal Freight Lines", "6402")).toBeLessThan(547.86);
  });

  it("ignores voided payments", () => {
    expect(result.rows.some((r) => r.payment.confirmation === "P1 - 7")).toBe(false);
  });

  it("totals what applied and reports what could not land", () => {
    expect(result.totalApplied).toBeCloseTo(17912.75, 2);
    expect(result.unapplied).toEqual([
      { vendor: "Uline", invoiceNumber: "Multiple", amount: 100 },
    ]);
    expect(result.totalUnapplied).toBeCloseTo(100, 2);
    expect(result.rows).toHaveLength(5);
  });
});

describe("buildOverdueModel with payments", () => {
  const model = buildOverdueModel(BILLS_CSV, AS_OF, "bills.csv", "2026-10-26T15:00:00Z", PAYMENTS_CSV);

  it("drops fully paid bills and keeps the remainder", () => {
    expect(model.overdue.map((b) => b.invoiceNo)).toEqual(["6402", "B1"]);
    expect(model.totalOverdue).toBeCloseTo(459.59 + 981.5, 2);
  });

  it("keeps the billed amount alongside what was paid", () => {
    const aaa = model.overdue.find((b) => b.invoiceNo === "6402");
    expect(aaa?.originalBalance).toBe(547.86);
    expect(aaa?.paidAmount).toBeCloseTo(88.27, 2);
    expect(aaa?.balanceDue).toBeCloseTo(459.59, 2);
  });

  it("summarizes the batch and the unapplied remainder", () => {
    expect(model.paymentSummary?.applied).toHaveLength(4);
    expect(model.paymentSummary?.totalApplied).toBeCloseTo(17912.75, 2);
    expect(model.paymentSummary?.unappliedCount).toBe(1);
    expect(model.paymentSummary?.totalUnapplied).toBeCloseTo(100, 2);
  });

  it("leaves paymentSummary null when no payments file is supplied", () => {
    const plain = buildOverdueModel(BILLS_CSV, AS_OF, "bills.csv", "2026-10-26T15:00:00Z");
    expect(plain.paymentSummary).toBeNull();
    expect(plain.totalOverdue).toBeCloseTo(19353.84, 2);
  });
});
