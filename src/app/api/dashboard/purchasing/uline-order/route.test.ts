import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  launchUlineSessionMock,
  openUlinePasteItemsPageMock,
  convertMock,
  scrapeObservedMock,
  syncPricesMock,
  verifyMock,
  finaleCtorMock,
} = vi.hoisted(() => ({
  launchUlineSessionMock: vi.fn(),
  openUlinePasteItemsPageMock: vi.fn(),
  convertMock: vi.fn(),
  scrapeObservedMock: vi.fn(),
  syncPricesMock: vi.fn(),
  verifyMock: vi.fn(),
  finaleCtorMock: vi.fn(),
}));

vi.mock("@/lib/purchasing/uline-session", () => ({
  launchUlineSession: launchUlineSessionMock,
  openUlinePasteItemsPage: openUlinePasteItemsPageMock,
}));

vi.mock("@/lib/purchasing/uline-ordering", () => ({
  convertFinaleItemToUlineOrder: convertMock,
}));

vi.mock("@/lib/purchasing/uline-cart-live", () => ({
  scrapeObservedUlineCartRows: scrapeObservedMock,
  syncVerifiedUlineCartPricesToDraftPO: syncPricesMock,
}));

vi.mock("@/cli/order-uline-cart", () => ({
  verifyUlineCart: verifyMock,
}));

vi.mock("@/lib/finale/client", () => ({
  FinaleClient: finaleCtorMock,
}));

import { POST } from "./route";

describe("dashboard uline order route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockImplementation((selector: string) => {
        if (selector === "text=Paste Items Page" || selector === "#txtPaste") return Promise.resolve(undefined);
        return Promise.reject(new Error("not found"));
      }),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      $: vi.fn().mockResolvedValue({
        isVisible: vi.fn().mockResolvedValue(true),
        click: vi.fn().mockResolvedValue(undefined),
      }),
      getByRole: vi.fn().mockReturnValue({
        first: () => ({
          isVisible: vi.fn().mockResolvedValue(false),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      $eval: vi.fn().mockRejectedValue(new Error("no error text")),
    };

    const context = {
      pages: vi.fn().mockReturnValue([page]),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };

    launchUlineSessionMock.mockResolvedValue({
      context,
      close: vi.fn().mockResolvedValue(undefined),
    });
    openUlinePasteItemsPageMock.mockResolvedValue(undefined);

    convertMock.mockImplementation(({ finaleSku, finaleEachQuantity, finaleUnitPrice }: any) => ({
      finaleSku,
      ulineModel: finaleSku === "ULS455" ? "S-4551" : finaleSku,
      quantity: finaleSku === "S-3902" ? 1 : finaleEachQuantity,
      unitPrice: finaleSku === "S-3902" ? 195 : finaleUnitPrice,
      finaleUnitPrice,
      orderUnitEaches: finaleSku === "S-3902" ? 5000 : 1,
      effectiveEachQuantity: finaleSku === "S-3902" ? 5000 : finaleEachQuantity,
      quantityStep: 1,
      description: finaleSku,
      guardrailWarnings: [],
    }));

    scrapeObservedMock.mockResolvedValue([
      { ulineModel: "S-3902", quantity: 1, unitPrice: 230, lineTotal: 230 },
      { ulineModel: "S-4551", quantity: 105, unitPrice: 4.22, lineTotal: 443.1 },
    ]);

    verifyMock.mockReturnValue({
      status: "verified",
      matchedModels: ["S-3902", "S-4551"],
      missingModels: [],
      quantityMismatches: [],
      unexpectedModels: [],
    });

    syncPricesMock.mockResolvedValue(2);
    finaleCtorMock.mockImplementation(function MockFinaleClient(this: any) {
      this.updateOrderItemPrice = vi.fn();
    });
  });

  it("writes verified cart pricing back to the bound draft PO", async () => {
    const response = await POST(
      new Request("http://localhost/api/dashboard/purchasing/uline-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftPO: "124554",
          items: [
            { productId: "S-3902", quantity: 1000, unitPrice: 0.039 },
            { productId: "ULS455", quantity: 100, unitPrice: 2.43 },
          ],
        }),
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(finaleCtorMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ finaleSku: "S-3902", finaleUnitPrice: 0.039, orderUnitEaches: 5000 }),
        expect.objectContaining({ finaleSku: "ULS455", finaleUnitPrice: 2.43 }),
      ]),
      expect.any(Array),
    );
    expect(syncPricesMock).toHaveBeenCalledWith(
      expect.anything(),
      "124554",
      expect.arrayContaining([
        expect.objectContaining({ finaleSku: "S-3902", finaleUnitPrice: 0.039 }),
        expect.objectContaining({ finaleSku: "ULS455", finaleUnitPrice: 2.43 }),
      ]),
      expect.any(Array),
      expect.objectContaining({ status: "verified" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      itemsAdded: 2,
      priceUpdatesApplied: 2,
    });
  });

  it("returns a review-needed result when the cart cannot be verified", async () => {
    scrapeObservedMock.mockResolvedValue([]);
    verifyMock.mockReturnValue({
      status: "unverified",
      matchedModels: [],
      missingModels: ["S-3902"],
      quantityMismatches: [],
      unexpectedModels: [],
    });

    const response = await POST(
      new Request("http://localhost/api/dashboard/purchasing/uline-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftPO: "124554",
          items: [
            { productId: "S-3902", quantity: 1000, unitPrice: 0.039 },
          ],
        }),
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(syncPricesMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      itemsAdded: 0,
      priceUpdatesApplied: 0,
    });
  });
});
