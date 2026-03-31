import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getGuidanceStateMock,
  refreshGuidanceMock,
} = vi.hoisted(() => ({
  getGuidanceStateMock: vi.fn(),
  refreshGuidanceMock: vi.fn(),
}));

vi.mock("@/lib/storage/purchases-guidance-state", () => ({
  getPurchasesGuidanceState: getGuidanceStateMock,
}));

vi.mock("@/lib/purchasing/purchases-guidance-refresh", () => ({
  refreshPurchasesGuidanceSnapshot: refreshGuidanceMock,
}));

import { GET, POST } from "./route";

describe("dashboard purchasing guidance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the latest persisted guidance state", async () => {
    getGuidanceStateMock.mockResolvedValue({
      status: "success",
      refreshedAt: "2026-03-31T12:00:00.000Z",
      summary: { totalItems: 5 },
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: {
        status: "success",
        refreshedAt: "2026-03-31T12:00:00.000Z",
        summary: { totalItems: 5 },
      },
    });
  });

  it("runs a refresh and returns the latest comparison summary", async () => {
    refreshGuidanceMock.mockResolvedValue({
      status: "success",
      refreshedAt: "2026-03-31T13:00:00.000Z",
      lastSuccessAt: "2026-03-31T13:00:00.000Z",
      summary: {
        totalItems: 7,
        agreesWithPolicy: 4,
        overstatesNeed: 1,
        understatesNeed: 1,
        alreadyOnOrder: 1,
        missingInFinale: 0,
        needsManualReview: 0,
      },
      comparisons: [],
      guidanceItems: [],
    });

    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "success",
      summary: {
        totalItems: 7,
        overstatesNeed: 1,
      },
    });
  });
});
