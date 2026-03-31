import { describe, expect, it } from "vitest";

import {
  buildPurchasesGuidanceStatePayload,
  summarizePurchasesGuidanceClassifications,
} from "./purchases-guidance-state";

describe("summarizePurchasesGuidanceClassifications", () => {
  it("counts comparison buckets for dashboard-friendly summaries", () => {
    const summary = summarizePurchasesGuidanceClassifications([
      { classification: "agrees_with_policy" },
      { classification: "agrees_with_policy" },
      { classification: "guidance_overstates_need" },
      { classification: "guidance_understates_need" },
      { classification: "already_on_order" },
      { classification: "missing_in_finale" },
      { classification: "needs_manual_review" },
    ] as any);

    expect(summary).toEqual({
      totalItems: 7,
      agreesWithPolicy: 2,
      overstatesNeed: 1,
      understatesNeed: 1,
      alreadyOnOrder: 1,
      missingInFinale: 1,
      needsManualReview: 1,
    });
  });
});

describe("buildPurchasesGuidanceStatePayload", () => {
  it("builds a stable persisted state payload", () => {
    const payload = buildPurchasesGuidanceStatePayload({
      status: "success",
      sourceKey: "basauto-purchases",
      refreshedAt: "2026-03-31T12:00:00.000Z",
      lastSuccessAt: "2026-03-31T12:00:00.000Z",
      guidanceItems: [{ vendorName: "ULINE", sku: "S-4128" }],
      comparisons: [{ sku: "S-4128", classification: "agrees_with_policy" }],
      summary: {
        totalItems: 1,
        agreesWithPolicy: 1,
        overstatesNeed: 0,
        understatesNeed: 0,
        alreadyOnOrder: 0,
        missingInFinale: 0,
        needsManualReview: 0,
      },
    });

    expect(payload).toMatchObject({
      source_key: "basauto-purchases",
      status: "success",
      refreshed_at: "2026-03-31T12:00:00.000Z",
      last_success_at: "2026-03-31T12:00:00.000Z",
      summary: {
        totalItems: 1,
        agreesWithPolicy: 1,
      },
      guidance_items: [{ vendorName: "ULINE", sku: "S-4128" }],
      comparisons: [{ sku: "S-4128", classification: "agrees_with_policy" }],
      error: null,
    });
    expect(payload.updated_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
