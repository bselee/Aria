import { describe, expect, it } from "vitest";
import {
  extractVendorChipNames,
  normalizeVendorChipLabel,
} from "./scrape-purchases";

describe("normalizeVendorChipLabel", () => {
  it("strips trailing count badges from vendor chip text", () => {
    expect(normalizeVendorChipLabel("AC Infinity Inc. 1")).toBe("AC Infinity Inc.");
    expect(normalizeVendorChipLabel("ULINE7")).toBe("ULINE");
  });

  it("rejects navigation tabs and utility buttons", () => {
    expect(normalizeVendorChipLabel("Purchases")).toBeNull();
    expect(normalizeVendorChipLabel("Overdue History")).toBeNull();
    expect(normalizeVendorChipLabel("Tutorial")).toBeNull();
  });
});

describe("extractVendorChipNames", () => {
  it("returns stable vendor names from visible chip-like buttons", () => {
    expect(
      extractVendorChipNames([
        { text: "Purchases", isVisible: true },
        { text: "AC Infinity Inc. 1", isVisible: true },
        { text: "Amazon 4", isVisible: true },
        { text: "ULINE7", isVisible: true },
        { text: "Hidden Vendor 2", isVisible: false },
      ]),
    ).toEqual(["AC Infinity Inc.", "Amazon", "ULINE"]);
  });
});
