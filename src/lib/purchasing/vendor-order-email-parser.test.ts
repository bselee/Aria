/**
 * @file    src/lib/purchasing/vendor-order-email-parser.test.ts
 * @purpose Real-email fixtures for Uline/Axiom/BFG draft-PO proposals.
 * @author  Hermia
 * @created 2026-08-13
 */
import { describe, it, expect } from "vitest";
import {
  parseUlineConfirmation,
  parseAxiomInvoice,
  parseBfgOrder,
  buildDraftPoProposal,
  htmlToRows,
  extractCaseSizeHint,
  resolvePackMultiplier,
  detectVendorOrderEmail,
} from "./vendor-order-email-parser";

const ULINE_SUBJECT = "ULINE ORDER CONFIRMATION # 57764019 PO# 125173";
const ULINE_BODY = [
  "ORDER # 57764019",
  "PO # 125173",
  "CUSTOMER NUMBER | SHIP VIA | ORDER DATE | SHIP DATE | TERMS |",
  "9897269 | FRT COLLECT | 08/12/26 | 08/12/26 | NET 30 |",
  "QUANTITY | U/M | ITEM NUMBER | DESCRIPTION | UNIT PRICE | EXT. PRICE |",
  '48 | RL | S-445 | ULINE INDUSTRIAL TAPE | 3.15 | 151.20 | T |',
  '1 | EA | H-596 | TAPE DISPENSER | .00 | .00 | |',
  "| | | THIS ITEM AT NO CHARGE | | | |",
  '1,500 | EA | S-4796 | 22 X 14 X 6" CORRUGATED BOXES | 1.99 | 2,985.00 | T |',
  "1 | EA | S-24389 | RAY-BAN | .00 | .00 | |",
  "| | | THIS ITEM AT NO CHARGE | | | |",
  "SUB-TOTAL",
  "3,136.20 |",
  "SALES TAX",
  "145.83 |",
  "SHIPPING/HANDLING",
  "1.50 |",
  "TOTAL",
  "3,283.53 |",
].join("\n");

const ULINE_KIT_BODY = [
  "ORDER # 56464679",
  "PO # 125127",
  "QUANTITY | U/M | ITEM NUMBER | DESCRIPTION | UNIT PRICE | EXT. PRICE |",
  '500 | EA | S-4738 | 24 X 14 X 10" CORRUGATED BOXES | 2.29 | 1,145.00 | T |',
  "480 | KT | S-13505B | F-STYLE JUGS BULK PACK - 32 OZ, WHITE | 1.25 | 600.00 | T |",
  "480 | EA | S-13505B-JUG | 1 QUART F-STYLE JUG-WHITE | .00 | .00 | |",
  "| | | PART OF KIT | | | |",
  "480 | EA | S-13505CAP | 33/400 WHITE PP CAP 120/CT | .00 | .00 | |",
  "| | | PART OF KIT | | | |",
  "240 | KT | S-10748B | F-STYLE JUGS BULK PACK - 1 GALLON, WHITE | 1.65 | 396.00 | T |",
  "240 | EA | S-13507CAP | 38/400 WHITE PP CAP 60/BG | .00 | .00 | |",
  "| | | PART OF KIT | | | |",
  "240 | EA | S-10748B-JUG | 1 GALLON F-STYLE JUG- WHITE | .00 | .00 | |",
  "| | | PART OF KIT | | | |",
  "SUB-TOTAL",
  "2,141.00 |",
  "TOTAL",
  "2,242.06 |",
].join("\n");

const AXIOM_SUBJECT = "AxiomPrint.com - Invoice INV131210";
const AXIOM_BODY = [
  "INVOICE:",
  "INV131210",
  "BALANCE:",
  "$432.05",
  "Job Name: GBB07 |",
  "Product: | Roll Labels |",
  'Size: | 4.25" w x 4.5" h |',
  "Material: | White Matte BOPP |",
].join("\n");

const BFG_SUBJECT = "BFGSupply.Com - Order";
const BFG_BODY = [
  "Order#: 3259787",
  "Customer #: 822767",
  "Customer: BUILDASOIL LLC",
  "Customer PO #:",
  "Detail Information",
  "Qty | Item # | Item Description | Unit Price | Ext Price |",
  "80 | HGC724946 | Gro Pro 25in Heavy Duty Saucer w/ Tall Sides Black(10/CS) | 9.87 | 789.60 |",
  "Order Sub Total: | $789.60 |",
  "Sub Total: | $789.60 |",
  "Shipping: | $200.00 |",
  "Tax: | $0.00 |",
  "Total: | $989.60 |",
].join("\n");

const finaleOk = async (sku: string) =>
  ["S-445", "S-4796", "H-596", "S-4738", "S-13505B", "S-10748B", "GBB07"].includes(sku.toUpperCase());

describe("htmlToRows / hints", () => {
  it("preserves table cells", () => {
    expect(htmlToRows("<tr><td>80</td><td>HGC724946</td></tr>")).toContain("80 | HGC724946");
  });
  it("extracts (10/CS) case hint", () => {
    expect(extractCaseSizeHint("Saucer Black(10/CS)")).toBe(10);
    expect(extractCaseSizeHint("plain")).toBeNull();
  });
});

describe("Uline — clean order", () => {
  const order = parseUlineConfirmation(ULINE_SUBJECT, ULINE_BODY);
  it("order + PO from subject", () => {
    expect(order.orderNumber).toBe("57764019");
    expect(order.poNumber).toBe("125173");
  });
  it("parses comma qty and promos", () => {
    expect(order.lines.find((l) => l.vendorItemNumber === "S-4796")?.quantity).toBe(1500);
    expect(order.lines.find((l) => l.vendorItemNumber === "S-24389")?.isNoCharge).toBe(true);
  });
  it("money block", () => {
    expect(order.totals.subtotal).toBe(3136.2);
    expect(order.totals.total).toBe(3283.53);
  });
  it("proposal clean when SKUs exist; EA stays eaches", async () => {
    const p = await buildDraftPoProposal(order, finaleOk);
    expect(p.resolved.map((r) => r.productId).sort()).toEqual(["S-445", "S-4796"]);
    expect(p.resolved.find((r) => r.productId === "S-4796")?.packMultiplier).toBe(1);
    expect(p.promoLines).toHaveLength(2);
    expect(p.subtotalReconciles).toBe(true);
    expect(p.needsReview).toBe(false);
  });
});

describe("Uline — kits + letter-suffix SKUs", () => {
  const order = parseUlineConfirmation("ULINE ORDER CONFIRMATION # 56464679 PO# 125127", ULINE_KIT_BODY);
  it("captures kit parents S-13505B / S-10748B", () => {
    expect(order.lines.map((l) => l.vendorItemNumber)).toEqual(
      expect.arrayContaining(["S-4738", "S-13505B", "S-10748B", "S-13505B-JUG", "S-13505CAP"]),
    );
  });
  it("kit components are no-charge", () => {
    expect(order.lines.find((l) => l.vendorItemNumber === "S-13505B-JUG")?.isKitComponent).toBe(true);
    expect(order.lines.find((l) => l.vendorItemNumber === "S-13505B-JUG")?.isNoCharge).toBe(true);
  });
  it("subtotal reconciles (1145+600+396=2141)", () => {
    const sum = order.lines.filter((l) => !l.isNoCharge).reduce((s, l) => s + l.extendedPrice, 0);
    expect(sum).toBeCloseTo(2141, 2);
    expect(order.totals.subtotal).toBe(2141);
  });
  it("KT + pack registry forces review with eaches conversion", async () => {
    const packs = new Map([
      ["S-13505B", { unitsPerPack: 120, packUnit: "case" }],
      ["S-10748B", { unitsPerPack: 60, packUnit: "case" }],
      ["S-4738", { unitsPerPack: 20, packUnit: "bundle" }],
    ]);
    const p = await buildDraftPoProposal(order, finaleOk, packs);
    const jug = p.resolved.find((r) => r.productId === "S-13505B");
    // KT → apply registry 120
    expect(jug?.packMultiplier).toBe(120);
    expect(jug?.quantity).toBe(480 * 120);
    expect(p.needsReview).toBe(true);
    // S-4738 is EA — registry NOT auto-applied (messy inventory rule)
    const box = p.resolved.find((r) => r.productId === "S-4738");
    expect(box?.packMultiplier).toBe(1);
    expect(box?.quantity).toBe(500);
  });
});

describe("Axiom", () => {
  it("Job Name is product; missing qty → needsReview", async () => {
    const order = parseAxiomInvoice(AXIOM_SUBJECT, AXIOM_BODY);
    expect(order.lines[0].vendorItemNumber).toBe("GBB07");
    const p = await buildDraftPoProposal(order, finaleOk);
    expect(p.needsReview).toBe(true);
  });
});

describe("BFG Supply — real 2026-08-12 order", () => {
  const order = parseBfgOrder(BFG_SUBJECT, BFG_BODY);
  it("parses order header + line", () => {
    expect(order.orderNumber).toBe("3259787");
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].vendorItemNumber).toBe("HGC724946");
    expect(order.lines[0].quantity).toBe(80);
    expect(order.lines[0].caseSizeHint).toBe(10);
    expect(order.totals.total).toBe(989.6);
    expect(order.totals.shipping).toBe(200);
  });
  it("unresolved when SKU missing in Finale; (10/CS) would convert if mapped", async () => {
    const p = await buildDraftPoProposal(order, async () => false);
    expect(p.unresolved).toHaveLength(1);
    expect(p.needsReview).toBe(true);

    const mapped = await buildDraftPoProposal(order, async () => true);
    expect(mapped.resolved[0].packMultiplier).toBe(10);
    expect(mapped.resolved[0].quantity).toBe(800);
    expect(mapped.resolved[0].unitPrice).toBeCloseTo(0.987, 3);
    expect(mapped.needsReview).toBe(true); // pack conversion always reviews
  });
});

describe("detectVendorOrderEmail", () => {
  it("routes senders", () => {
    expect(detectVendorOrderEmail("a@uline.com", "ULINE ORDER CONFIRMATION # 1")).toBe("uline");
    expect(detectVendorOrderEmail("paymentsupport@axiomprint.com", "AxiomPrint.com - Invoice INV1")).toBe("axiom");
    expect(detectVendorOrderEmail("bfgweborders@bfgsupply.com", "BFGSupply.Com - Order")).toBe("bfg");
    expect(detectVendorOrderEmail("spam@x.com", "hi")).toBeNull();
  });
});

describe("resolvePackMultiplier policy", () => {
  it("EA ignores registry", () => {
    const r = resolvePackMultiplier(
      {
        vendorItemNumber: "S-4738",
        description: "boxes",
        quantity: 500,
        unitOfMeasure: "EA",
        caseSizeHint: null,
        unitPrice: 2.29,
        extendedPrice: 1145,
        isNoCharge: false,
        isKitComponent: false,
        taxable: true,
      },
      { unitsPerPack: 20, packUnit: "bundle" },
    );
    expect(r.multiplier).toBe(1);
    expect(r.source).toBe("vendor_uom_ea");
  });
});
