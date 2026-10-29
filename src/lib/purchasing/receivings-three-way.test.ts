/**
 * @file    receivings-three-way.test.ts
 * @purpose Unit tests for the Receivings 3-way stamp (WS4). The failure modes
 *          that matter are the ones where a row would read "matched" without
 *          anything having been compared, so those are tested as hard as the
 *          happy path.
 */

import { describe, expect, it } from "vitest";

import { buildReceivingsThreeWay, bucketDiscrepancy } from "./receivings-three-way";
import type { ThreeWayDiscrepancy } from "./three-way-match";

function discrepancy(overrides: Partial<ThreeWayDiscrepancy> = {}): ThreeWayDiscrepancy {
  return {
    productId: "S-1000",
    kind: "price_variance",
    blocking: true,
    dollarImpact: 10,
    message: "S-1000: PO $10.00/unit vs invoice $11.00/unit (10.0% variance).",
    ...overrides,
  };
}

describe("bucketDiscrepancy", () => {
  it("buckets per-line kinds", () => {
    expect(bucketDiscrepancy(discrepancy())).toBe("price");
    expect(bucketDiscrepancy(discrepancy({ kind: "qty_over_billed" }))).toBe("qty");
    expect(bucketDiscrepancy(discrepancy({ kind: "qty_short_received" }))).toBe("qty");
    expect(bucketDiscrepancy(discrepancy({ kind: "qty_over_received" }))).toBe("qty");
    expect(bucketDiscrepancy(discrepancy({ kind: "line_not_on_po" }))).toBe("sku");
  });

  it("buckets a money-named line as freight / tax / fee, not as a price or SKU diff", () => {
    expect(
      bucketDiscrepancy(
        discrepancy({ productId: "FREIGHT", kind: "line_not_on_po", message: "FREIGHT: invoiced but not present on the PO." }),
      ),
    ).toBe("freight");
    expect(
      bucketDiscrepancy(
        discrepancy({ productId: "SHIPPING", message: "SHIPPING: PO $0.00/unit vs invoice $45.00/unit." }),
      ),
    ).toBe("freight");
    expect(
      bucketDiscrepancy(discrepancy({ productId: "SALES TAX", kind: "line_not_on_po", message: "SALES TAX: not on PO" })),
    ).toBe("tax");
    expect(
      bucketDiscrepancy(discrepancy({ productId: "HANDLING", kind: "line_not_on_po", message: "HANDLING: not on PO" })),
    ).toBe("fee");
  });
});

describe("buildReceivingsThreeWay", () => {
  it("reads clean when ordered, received and billed agree", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125429",
      items: [
        { productId: "S-17888", orderedQty: 14, receivedQty: 14, unitPrice: 12.5 },
        { productId: "S-2200", orderedQty: 1, receivedQty: 1, unitPrice: 100 },
      ],
      invoiceLines: [
        { sku: "S-17888", qty: 14, unitPrice: 12.5 },
        { sku: "s-2200", qty: 1, unitPrice: 100 },
      ],
      invoice: { total: 275, freight: 0 },
      poFreight: 0,
    });

    expect(stamp.verdict).toBe("matched");
    expect(stamp.canComplete).toBe(true);
    expect(stamp.variances).toEqual([]);
    expect(stamp.bucket).toEqual([]);
    expect(stamp.incompleteReason).toBeNull();
    expect(stamp.lines.map((l) => l.productId)).toEqual(["S-17888", "S-2200"]);
    expect(stamp.lines[0]).toMatchObject({ poQty: 14, receivedQty: 14, invoiceQty: 14 });
  });

  it("names a price variance (125341: bill $1,105 vs PO $163)", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125341",
      items: [{ productId: "OMP102", orderedQty: 1, receivedQty: 1, unitPrice: 163 }],
      invoiceLines: [{ sku: "OMP102", qty: 1, unitPrice: 1105 }],
      invoice: { total: 1105 },
      poFreight: null,
    });

    expect(stamp.verdict).toBe("exception");
    expect(stamp.canComplete).toBe(false);
    expect(stamp.bucket).toEqual(["price"]);
    expect(stamp.variances[0]).toMatchObject({ bucket: "price", blocking: true, count: 1 });
    expect(stamp.variances[0].dollarImpact).toBeCloseTo(942, 2);
  });

  // ── The plan's Pitfall: an all-zero PO price side must never read matched ──
  it("never reads matched when the PO carries no unit prices", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125999",
      items: [{ productId: "S-17888", orderedQty: 14, receivedQty: 14, unitPrice: 0 }],
      invoiceLines: [{ sku: "S-17888", qty: 14, unitPrice: 12.5 }],
      invoice: { total: 175 },
      poFreight: 0,
    });

    expect(stamp.verdict).toBe("incomplete");
    expect(stamp.verdict).not.toBe("matched");
    expect(stamp.canComplete).toBe(false);
    expect(stamp.incompleteReason).toBe("po_prices_missing");
    expect(stamp.variances).toEqual([]);
  });

  it("never reads matched when the bill has an amount but no readable lines", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125888",
      items: [{ productId: "S-17888", orderedQty: 14, receivedQty: 14, unitPrice: 12.5 }],
      invoiceLines: [],
      invoice: { total: 175 },
    });

    expect(stamp.verdict).toBe("incomplete");
    expect(stamp.incompleteReason).toBe("invoice_lines_unreadable");
  });

  it("treats a matched bill with no readable amount as incomplete", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125378",
      items: [{ productId: "NOV-1", orderedQty: 5, receivedQty: 5, unitPrice: 20 }],
      invoiceLines: [{ sku: "NOV-1", qty: 5, unitPrice: 20 }],
      invoice: { total: 0 },
    });

    expect(stamp.verdict).toBe("incomplete");
    expect(stamp.incompleteReason).toBe("invoice_amount_unknown");
  });

  it("reports no_invoice when the PO has no matched bill", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125381",
      items: [{ productId: "S-17888", orderedQty: 1, receivedQty: 1, unitPrice: 10 }],
      invoiceLines: [],
      invoice: null,
    });

    expect(stamp.verdict).toBe("incomplete");
    expect(stamp.incompleteReason).toBe("no_invoice");
    expect(stamp.canComplete).toBe(false);
  });

  it("does not fabricate an overbill when receipt quantities are unknown (cold cache)", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125408",
      items: [{ productId: "S-17888", orderedQty: 50, receivedQty: null, unitPrice: 10 }],
      invoiceLines: [{ sku: "S-17888", qty: 50, unitPrice: 10 }],
      invoice: { total: 500 },
      poFreight: 0,
    });

    expect(stamp.verdict).toBe("matched");
    expect(stamp.canComplete).toBe(true);
    expect(stamp.lines[0].receivedQty).toBeNull();
    expect(stamp.discrepancies).toEqual([]);
  });

  it("buckets an over-billed quantity as qty", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125415",
      items: [{ productId: "MILES-1", orderedQty: 10, receivedQty: 10, unitPrice: 20 }],
      invoiceLines: [{ sku: "MILES-1", qty: 12, unitPrice: 20 }],
      invoice: { total: 240 },
      poFreight: 0,
    });

    expect(stamp.verdict).toBe("exception");
    expect(stamp.bucket).toEqual(["qty"]);
    expect(stamp.variances[0].blocking).toBe(true);
  });

  it("buckets a billed SKU that is not on the PO as sku", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125500",
      items: [{ productId: "S-17888", orderedQty: 2, receivedQty: 2, unitPrice: 10 }],
      invoiceLines: [
        { sku: "S-17888", qty: 2, unitPrice: 10 },
        { sku: "S-90001", qty: 1, unitPrice: 55 },
      ],
      invoice: { total: 75 },
      poFreight: 0,
    });

    expect(stamp.verdict).toBe("exception");
    expect(stamp.bucket).toEqual(["sku"]);
    expect(stamp.variances[0].messages[0]).toMatch(/not present on the PO/);
  });

  it("aligns SKUs by exact equality only (S-4738 is not S-473824)", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125429",
      items: [{ productId: "S-4738", orderedQty: 3, receivedQty: 3, unitPrice: 5 }],
      invoiceLines: [{ sku: "S-473824", qty: 3, unitPrice: 5 }],
      invoice: { total: 15 },
      poFreight: 0,
    });

    // The PO line is never billed (excluded), the bill line is not on the PO.
    expect(stamp.bucket).toEqual(["sku"]);
    expect(stamp.verdict).toBe("exception");
    expect(stamp.lines).toHaveLength(1);
  });

  it("chips freight billed above what the PO carried, and withholds READY", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125393",
      items: [{ productId: "S-17888", orderedQty: 1, receivedQty: 1, unitPrice: 10 }],
      invoiceLines: [{ sku: "S-17888", qty: 1, unitPrice: 10 }],
      invoice: { total: 55, freight: 45 },
      poFreight: 0,
    });

    // The line comparison itself is clean — the bill's freight is the variance.
    expect(stamp.verdict).toBe("matched");
    expect(stamp.canComplete).toBe(false);
    expect(stamp.bucket).toEqual(["freight"]);
    expect(stamp.variances[0]).toMatchObject({ bucket: "freight", source: "header", blocking: true });
    expect(stamp.variances[0].dollarImpact).toBeCloseTo(45, 2);
  });

  it("ignores a trivial freight rounding difference", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125600",
      items: [{ productId: "S-17888", orderedQty: 1, receivedQty: 1, unitPrice: 10 }],
      invoiceLines: [{ sku: "S-17888", qty: 1, unitPrice: 10 }],
      invoice: { total: 10.5, freight: 0.5 },
      poFreight: 0,
    });

    expect(stamp.canComplete).toBe(true);
    expect(stamp.variances).toEqual([]);
  });

  it("skips the freight comparison when PO freight cannot be derived", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125601",
      items: [{ productId: "S-17888", orderedQty: 1, receivedQty: 1, unitPrice: 10 }],
      invoiceLines: [{ sku: "S-17888", qty: 1, unitPrice: 10 }],
      invoice: { total: 55, freight: 45 },
      poFreight: null,
    });

    expect(stamp.canComplete).toBe(true);
  });

  it("keeps buckets in fixed display order", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125700",
      items: [
        { productId: "A", orderedQty: 1, receivedQty: 1, unitPrice: 10 },
        { productId: "B", orderedQty: 1, receivedQty: 1, unitPrice: 10 },
      ],
      invoiceLines: [
        { sku: "A", qty: 3, unitPrice: 10 },
        { sku: "B", qty: 1, unitPrice: 30 },
        { sku: "ZZZ", qty: 1, unitPrice: 5 },
      ],
      invoice: { total: 95, freight: 30 },
      poFreight: 0,
    });

    expect(stamp.bucket).toEqual(["freight", "sku", "price", "qty"]);
  });

  it("counts invoice lines that carry money but no SKU instead of silently dropping them", () => {
    const stamp = buildReceivingsThreeWay({
      orderId: "125800",
      items: [{ productId: "S-17888", orderedQty: 1, receivedQty: 1, unitPrice: 10 }],
      invoiceLines: [
        { sku: "S-17888", qty: 1, unitPrice: 10 },
        { sku: null, description: "misc", qty: 1, unitPrice: 12 },
      ],
      invoice: { total: 22 },
      poFreight: 0,
    });

    expect(stamp.unmatchedInvoiceLines).toBe(1);
    expect(stamp.verdict).toBe("matched");
  });
});
