/**
 * @file    src/lib/purchasing/vendor-po-requirement.test.ts
 * @purpose Unit tests for vendor PO requirement detection.
 * @author  Hermia
 * @created 2026-08-01
 *
 * IMPORTANT: These tests mock @/lib/db — they must NOT hit live PostgREST.
 * A broken mock that reached the live DB caused a serious incident here.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock @/lib/db BEFORE importing the module under test
vi.mock("@/lib/db", () => ({
  createClient: vi.fn(),
}));

// Import after mock is set up
import { createClient } from "@/lib/db";
import {
  loadPoRequirementMap,
  vendorRequiresPo,
  clearPoRequirementCache,
} from "./vendor-po-requirement";

/** Type helper for the mock query builder returned by createClient().from().select() */
function makeMockDb(result: { data: unknown; error: unknown } | Error) {
  const mockFrom = vi.fn().mockReturnThis();
  const mockSelect = vi
    .fn()
    .mockResolvedValue(result instanceof Error ? { data: null, error: result } : result);

  const mockClient = {
    from: vi.fn(() => ({
      select: mockSelect,
      from: mockFrom,
    })),
  };

  vi.mocked(createClient).mockReturnValue(mockClient as any);
  return { mockClient, mockFrom, mockSelect };
}

describe("vendorRequiresPo (pure function)", () => {
  it("returns true for an unknown vendor (default)", () => {
    const map = new Map<string, boolean>();
    expect(vendorRequiresPo("Some Unknown Vendor", map)).toBe(true);
  });

  it("returns false for a flagged vendor", () => {
    const map = new Map<string, boolean>([["FedEx", false]]);
    expect(vendorRequiresPo("FedEx", map)).toBe(false);
  });

  it("returns true for an empty map", () => {
    const map = new Map<string, boolean>();
    expect(vendorRequiresPo("FedEx", map)).toBe(true);
  });

  it("returns true when the vendor is explicitly in the map as true", () => {
    const map = new Map<string, boolean>([["TeraGanix", true]]);
    expect(vendorRequiresPo("TeraGanix", map)).toBe(true);
  });

  it("handles case/whitespace differences (map is case-sensitive)", () => {
    // The map is loaded from DB with exact names; a vendor_profiles row
    // for "FedEx" does NOT match "fedex" or " FedEx "
    const map = new Map<string, boolean>([["FedEx", false]]);
    expect(vendorRequiresPo("fedex", map)).toBe(true); // wrong case → not found → true
    expect(vendorRequiresPo(" FedEx ", map)).toBe(false); // trimmed → matches
  });

  it("returns true for null/empty vendor name", () => {
    const map = new Map<string, boolean>([["FedEx", false]]);
    expect(vendorRequiresPo("", map)).toBe(true);
    expect(vendorRequiresPo("   ", map)).toBe(true);
    expect(vendorRequiresPo(null as unknown as string, map)).toBe(true);
  });

  it("returns false for multiple flagged vendors", () => {
    const map = new Map<string, boolean>([
      ["FedEx", false],
      ["Logan Labs LLC", false],
      ["Culligan Water", false],
    ]);
    expect(vendorRequiresPo("FedEx", map)).toBe(false);
    expect(vendorRequiresPo("Logan Labs LLC", map)).toBe(false);
    expect(vendorRequiresPo("Culligan Water", map)).toBe(false);
    expect(vendorRequiresPo("TeraGanix", map)).toBe(true); // not flagged
  });
});

describe("loadPoRequirementMap (DB-backed, cached)", () => {
  beforeEach(() => {
    clearPoRequirementCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearPoRequirementCache();
  });

  it("loads and returns a map from DB", async () => {
    makeMockDb({
      data: [
        { vendor_name: "FedEx", requires_po: false },
        { vendor_name: "Logan Labs LLC", requires_po: false },
        { vendor_name: "TeraGanix", requires_po: true },
      ],
      error: null,
    });

    const map = await loadPoRequirementMap();
    expect(map.get("FedEx")).toBe(false);
    expect(map.get("Logan Labs LLC")).toBe(false);
    expect(map.get("TeraGanix")).toBe(true);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("uses cached result within TTL (60s)", async () => {
    makeMockDb({
      data: [{ vendor_name: "FedEx", requires_po: false }],
      error: null,
    });

    await loadPoRequirementMap(); // first call — hits DB
    await loadPoRequirementMap(); // second call — should use cache
    expect(createClient).toHaveBeenCalledTimes(1); // still only 1 DB call
  });

  it("returns empty map on DB error and does not throw", async () => {
    makeMockDb(new Error("Connection refused"));

    const map = await loadPoRequirementMap();
    expect(map.size).toBe(0);
    // Should not throw
  });

  it("returns empty map on PostgREST error object", async () => {
    makeMockDb({
      data: null,
      error: new Error("PostgREST 503: schema cache loading"),
    });

    const map = await loadPoRequirementMap();
    expect(map.size).toBe(0);
  });

  it("returns empty map on null/empty data", async () => {
    makeMockDb({ data: null, error: null });

    const map = await loadPoRequirementMap();
    expect(map.size).toBe(0);
  });

  it("refreshes cache after TTL expires", async () => {
    vi.useFakeTimers();
    // First load
    makeMockDb({
      data: [{ vendor_name: "FedEx", requires_po: false }],
      error: null,
    });

    await loadPoRequirementMap();

    // Second load after advancing time past TTL
    vi.advanceTimersByTime(61_000);

    // Reset mock for second call
    makeMockDb({
      data: [
        { vendor_name: "FedEx", requires_po: false },
        { vendor_name: "Logan Labs LLC", requires_po: false },
      ],
      error: null,
    });

    // Need to re-mock since we're using fake timers
    const map = await loadPoRequirementMap();
    expect(map.size).toBe(2);
  });

  it("clearPoRequirementCache forces a fresh load", async () => {
    makeMockDb({
      data: [{ vendor_name: "FedEx", requires_po: false }],
      error: null,
    });

    await loadPoRequirementMap();
    clearPoRequirementCache();

    makeMockDb({
      data: [{ vendor_name: "Logan Labs LLC", requires_po: false }],
      error: null,
    });

    const map = await loadPoRequirementMap();
    expect(map.has("FedEx")).toBe(false); // cache was cleared, fresh load
    expect(map.has("Logan Labs LLC")).toBe(true);
  });
});
