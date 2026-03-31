import { describe, expect, it, vi } from "vitest";
import {
  normalizeVendorChipLabel,
  extractVendorChipNames,
  waitForVendorChips,
  waitForVendorPanelReady,
  clickVendorChip,
} from "@/lib/purchasing/purchases-scraper-nav";

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

  it("waits for vendor chips before scraping", async () => {
    const page = {
      waitForFunction: vi.fn().mockResolvedValue(null),
    } as any;
    await waitForVendorChips(page);
    expect(page.waitForFunction).toHaveBeenCalled();
  });

  it("waits for vendor panel readiness with a changed heading and SKU card", async () => {
    const page = {
      waitForFunction: vi.fn().mockResolvedValue(null),
    } as any;
    await waitForVendorPanelReady(page, "previous");
    expect(page.waitForFunction).toHaveBeenCalled();
  });

  it("requeries chip with the vendor name pattern on each click", async () => {
    const clickCalls: string[] = [];
    const locatorCalls: string[] = [];
    const page = {
      locator: () => {
        locatorCalls.push("button");
        return {
          filter: () => ({
            first: () => ({
              waitFor: () => Promise.resolve(),
              click: () => {
                clickCalls.push("clicked");
                return Promise.resolve();
              },
            }),
          }),
        };
      },
    } as any;
    await clickVendorChip(page, "ULINE");
    await clickVendorChip(page, "Axiom Print");
    expect(clickCalls).toHaveLength(2);
    expect(locatorCalls).toHaveLength(2);
  });
});
