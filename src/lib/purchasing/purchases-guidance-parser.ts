export type PurchasesGuidanceMetrics = {
  purchaseAgainBy: string;
  recommendedReorderQty: string;
  supplierLeadTime: string;
  remaining: string;
  last30DaysSold: string;
  last90DaysSold: string;
  dailyVelocity: string;
  ninetyDayConsumed: string;
  avgBuildConsumption: string;
  daysBuildsLeft: string;
  lastReceived: string;
  ytdQtyBought: string;
  ytdPurchaseCost: string;
  cogsExclShip: string;
  ytdQtySold: string;
  ytdRevenue: string;
  itemMargin: string;
};

export type PurchasesGuidanceBaseItem = {
  sku: string;
  description: string;
  urgency: string;
};

export type PurchasesGuidanceRawItem = PurchasesGuidanceBaseItem & {
  metricGroups: string[][];
};

const METRIC_LABELS: Record<string, keyof PurchasesGuidanceMetrics> = {
  "PURCHASE AGAIN BY": "purchaseAgainBy",
  "RECOMMENDED REORDER QUANTITY": "recommendedReorderQty",
  "SUPPLIER LEAD TIME": "supplierLeadTime",
  REMAINING: "remaining",
  "LAST 30 DAYS SOLD": "last30DaysSold",
  "LAST 90 DAYS SOLD": "last90DaysSold",
  "DAILY VELOCITY": "dailyVelocity",
  "90 DAY CONSUMED": "ninetyDayConsumed",
  "AVG BUILD CONSUMPTION": "avgBuildConsumption",
  "DAYS/BUILDS LEFT": "daysBuildsLeft",
  "LAST RECEIVED": "lastReceived",
  "YTD QTY BOUGHT": "ytdQtyBought",
  "YTD PURCHASE COST": "ytdPurchaseCost",
  "COGS EXCLUDING SHIP": "cogsExclShip",
  "YTD QTY SOLD": "ytdQtySold",
  "YTD REVENUE": "ytdRevenue",
  "ITEM MARGIN BEFORE SHIPPING": "itemMargin",
};

export function createEmptyPurchasesGuidanceMetrics(): PurchasesGuidanceMetrics {
  return {
    purchaseAgainBy: "",
    recommendedReorderQty: "",
    supplierLeadTime: "",
    remaining: "",
    last30DaysSold: "",
    last90DaysSold: "",
    dailyVelocity: "",
    ninetyDayConsumed: "",
    avgBuildConsumption: "",
    daysBuildsLeft: "",
    lastReceived: "",
    ytdQtyBought: "",
    ytdPurchaseCost: "",
    cogsExclShip: "",
    ytdQtySold: "",
    ytdRevenue: "",
    itemMargin: "",
  };
}

function normalizeMetricText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeMetricLabel(text: string): string {
  return normalizeMetricText(text).toUpperCase();
}

export function parsePurchasesGuidanceMetricGroups(metricGroups: string[][]): PurchasesGuidanceMetrics {
  const metrics = createEmptyPurchasesGuidanceMetrics();

  for (const group of metricGroups) {
    const segments = group.map(normalizeMetricText).filter(Boolean);
    let pendingMetricKey: keyof PurchasesGuidanceMetrics | null = null;

    for (const segment of segments) {
      const labelKey = METRIC_LABELS[normalizeMetricLabel(segment)];
      if (labelKey) {
        pendingMetricKey = labelKey;
        continue;
      }

      if (pendingMetricKey && !metrics[pendingMetricKey]) {
        metrics[pendingMetricKey] = segment;
        pendingMetricKey = null;
      }
    }
  }

  return metrics;
}

export function parsePurchasesGuidanceItem(rawItem: PurchasesGuidanceRawItem): PurchasesGuidanceBaseItem & PurchasesGuidanceMetrics {
  return {
    sku: rawItem.sku,
    description: rawItem.description,
    urgency: rawItem.urgency,
    ...parsePurchasesGuidanceMetricGroups(rawItem.metricGroups),
  };
}
