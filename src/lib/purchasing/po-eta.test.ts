/**
 * @file po-eta.test.ts
 * @purpose Lock the evidence order: real tracking first, PO date last.
 * @author Hermia
 * @created 2026-11-09
 * @deps vitest, ./po-eta
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../builds/lead-time-service", () => ({
  leadTimeService: {
    getForVendor: vi.fn(async () => ({ days: 14, label: "14d test median" })),
  },
}));

import { resolvePoEta, withVendorSlip } from "./po-eta";

const TODAY = "2026-11-09";
const base = { vendorName: "ULINE", today: TODAY };

describe("resolvePoEta", () => {
  it("prefers the carrier delivery scan over everything", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
      plannedReceiveDate: "2026-11-20",
      vendorStatedEta: "2026-11-18",
      shipment: { deliveredAt: "2026-11-07T15:00:00Z", estimatedDeliveryAt: "2026-11-08T15:00:00Z" },
    });
    expect(eta.date).toBe("2026-11-07");
    expect(eta.provenance).toBe("delivered");
  });

  it("uses the carrier ETA over a vendor or planned date", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
      plannedReceiveDate: "2026-11-20",
      vendorStatedEta: "2026-11-18",
      shipment: { estimatedDeliveryAt: "2026-11-12T09:00:00Z" },
    });
    expect(eta.date).toBe("2026-11-12");
    expect(eta.provenance).toBe("carrier");
  });

  it("ignores a carrier ETA that is already in the past", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
      shipment: { estimatedDeliveryAt: "2026-10-30T09:00:00Z" },
    });
    expect(eta.provenance).not.toBe("carrier");
    expect(eta.date > TODAY).toBe(true);
  });

  it("uses a vendor-stated date over the Finale planned date", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
      plannedReceiveDate: "2026-11-20",
      vendorStatedEta: "2026-11-18",
    });
    expect(eta.date).toBe("2026-11-18");
    expect(eta.provenance).toBe("vendor");
  });

  it("uses the Finale planned date when no real evidence exists", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
      plannedReceiveDate: "2026-11-20",
    });
    expect(eta.date).toBe("2026-11-20");
    expect(eta.provenance).toBe("finale_planned");
  });

  it("falls back to order date plus lead time", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
    });
    expect(eta.date).toBe("2026-11-15");
    expect(eta.provenance).toBe("lead_time");
    expect(eta.label).toContain("14d");
  });

  it("falls back to today with no order date at all", async () => {
    const eta = await resolvePoEta({ ...base });
    expect(eta.date).toBe(TODAY);
    expect(eta.provenance).toBe("fallback");
  });

  it("ignores a vendor date that is already in the past", async () => {
    const eta = await resolvePoEta({
      ...base,
      orderDate: "2026-11-01",
      vendorStatedEta: "2026-10-01",
    });
    expect(eta.provenance).not.toBe("vendor");
  });

  it("never throws on a malformed order date — falls back to today", async () => {
    const eta = await resolvePoEta({ ...base, orderDate: "not-a-date" });
    expect(eta.date).toBe(TODAY);
    expect(eta.provenance).toBe("fallback");
  });

  describe("withVendorSlip", () => {
    it("pushes a forecast date out to the vendor's p90", () => {
      expect(withVendorSlip("2026-11-18", "lead_time", 9)).toBe("2026-11-27");
      expect(withVendorSlip("2026-11-20", "finale_planned", 4)).toBe("2026-11-24");
    });

    it("never moves real movement evidence", () => {
      expect(withVendorSlip("2026-11-18", "delivered", 9)).toBe("2026-11-18");
      expect(withVendorSlip("2026-11-18", "carrier", 9)).toBe("2026-11-18");
      expect(withVendorSlip("2026-11-18", "vendor", 9)).toBe("2026-11-18");
    });

    it("leaves the date alone when there is no measurable slip", () => {
      expect(withVendorSlip("2026-11-18", "lead_time", 0)).toBe("2026-11-18");
      expect(withVendorSlip("2026-11-18", "lead_time", -3)).toBe("2026-11-18");
      expect(withVendorSlip(null, "lead_time", 9)).toBeNull();
    });
  });
});
