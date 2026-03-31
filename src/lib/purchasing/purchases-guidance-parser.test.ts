import { describe, expect, it } from "vitest";
import {
  createEmptyPurchasesGuidanceMetrics,
  parsePurchasesGuidanceItem,
  parsePurchasesGuidanceMetricGroups,
} from "@/lib/purchasing/purchases-guidance-parser";

describe("purchases guidance parser", () => {
  it("maps structured metric groups into typed guidance fields", () => {
    const metrics = parsePurchasesGuidanceMetricGroups([
      ["PURCHASE AGAIN BY", "Apr 12, 2026"],
      ["RECOMMENDED REORDER QUANTITY", "250"],
      ["SUPPLIER LEAD TIME", "14 days"],
      ["REMAINING", "83"],
      ["DAILY VELOCITY", "2.6/day"],
      ["DAYS/BUILDS LEFT", "31 days / 5 builds"],
      ["YTD REVENUE", "$5,210.11"],
      ["ITEM MARGIN BEFORE SHIPPING", "41.2%"],
    ]);

    expect(metrics.purchaseAgainBy).toBe("Apr 12, 2026");
    expect(metrics.recommendedReorderQty).toBe("250");
    expect(metrics.supplierLeadTime).toBe("14 days");
    expect(metrics.remaining).toBe("83");
    expect(metrics.dailyVelocity).toBe("2.6/day");
    expect(metrics.daysBuildsLeft).toBe("31 days / 5 builds");
    expect(metrics.ytdRevenue).toBe("$5,210.11");
    expect(metrics.itemMargin).toBe("41.2%");
  });

  it("parses multiple label/value pairs from a wider metric group", () => {
    const metrics = parsePurchasesGuidanceMetricGroups([
      [
        "LAST 30 DAYS SOLD",
        "14",
        "LAST 90 DAYS SOLD",
        "42",
        "90 DAY CONSUMED",
        "38",
        "AVG BUILD CONSUMPTION",
        "0.9/day",
      ],
    ]);

    expect(metrics.last30DaysSold).toBe("14");
    expect(metrics.last90DaysSold).toBe("42");
    expect(metrics.ninetyDayConsumed).toBe("38");
    expect(metrics.avgBuildConsumption).toBe("0.9/day");
  });

  it("fills missing metrics with blanks", () => {
    expect(parsePurchasesGuidanceMetricGroups([])).toEqual(createEmptyPurchasesGuidanceMetrics());
  });

  it("combines base item data with parsed metrics", () => {
    const item = parsePurchasesGuidanceItem({
      sku: "BLM201",
      description: "3mm to Blusoak Tee",
      urgency: "PURCHASE",
      metricGroups: [
        ["PURCHASE AGAIN BY", "Apr 14, 2026"],
        ["RECOMMENDED REORDER QUANTITY", "50"],
      ],
    });

    expect(item).toMatchObject({
      sku: "BLM201",
      description: "3mm to Blusoak Tee",
      urgency: "PURCHASE",
      purchaseAgainBy: "Apr 14, 2026",
      recommendedReorderQty: "50",
    });
  });
});
