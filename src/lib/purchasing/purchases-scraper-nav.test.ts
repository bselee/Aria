import { describe, expect, it } from "vitest";
import { normalizeVendorChipLabel, extractVendorChipNames } from "@/lib/purchasing/purchases-scraper-nav";

describe("purchases scraper navigation helpers", () => {
  it("normalizes vendor chip labels", () => {
    expect(normalizeVendorChipLabel("ULINE7")).toBe("ULINE");
    expect(normalizeVendorChipLabel("Axiom Print9")).toBe("Axiom Print");
    expect(normalizeVendorChipLabel("Purchases")).toBeNull();
    expect(normalizeVendorChipLabel("   Clarke  1  ")).toBe("Clarke");
  });

  it("extracts unique vendor names from button snapshots", () => {
    const buttons = [
      { text: "ULINE7", isVisible: true },
      { text: "Axiom Print9", isVisible: true },
      { text: "Axiom Print9", isVisible: true },
      { text: "Purchases", isVisible: true },
      { text: "Thornvin1", isVisible: false },
    ];

    expect(extractVendorChipNames(buttons)).toEqual(["ULINE", "Axiom Print"]);
  });
});
