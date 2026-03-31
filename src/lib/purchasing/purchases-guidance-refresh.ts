import { FinaleClient, type FinaleProductDetail } from "../finale/client";
import { assessPurchasingGroups, type AssessedPurchasingLine } from "./assessment-service";
import {
  comparePurchasesGuidanceItem,
  type PurchasesGuidanceComparisonResult,
} from "./purchases-guidance-comparison";
import {
  scrapePurchasesGuidanceViaCDP,
  type PurchasesGuidanceDataset,
} from "./purchases-guidance-scraper";
import {
  summarizePurchasesGuidanceClassifications,
  upsertPurchasesGuidanceState,
  type PurchasesGuidanceStateInput,
} from "../storage/purchases-guidance-state";

type GuidanceRefreshFinaleClient = Pick<FinaleClient, "getPurchasingIntelligenceForSkus" | "lookupProduct">;

export interface RefreshPurchasesGuidanceOptions {
  scrapeGuidance?: () => Promise<PurchasesGuidanceDataset>;
  finaleClient?: GuidanceRefreshFinaleClient;
  upsertState?: (input: PurchasesGuidanceStateInput) => Promise<string | null>;
  daysBack?: number;
}

export interface RefreshPurchasesGuidanceResult {
  status: "success" | "failed";
  refreshedAt: string;
  lastSuccessAt: string | null;
  summary: ReturnType<typeof summarizePurchasesGuidanceClassifications>;
  comparisons: PurchasesGuidanceComparisonResult[];
  guidanceItems: Array<{ vendorName: string; sku: string; urgency: string }>;
  error?: string;
}

function flattenGuidanceItems(dataset: PurchasesGuidanceDataset) {
  return Object.entries(dataset).flatMap(([vendorName, items]) =>
    items.map((item) => ({
      vendorName,
      ...item,
    })),
  );
}

function buildAssessmentIndex(lines: AssessedPurchasingLine[]): Map<string, AssessedPurchasingLine> {
  return new Map(lines.map((line) => [line.item.productId.toUpperCase(), line]));
}

async function findFinaleProduct(
  finaleClient: GuidanceRefreshFinaleClient,
  cache: Map<string, FinaleProductDetail | null>,
  sku: string,
): Promise<FinaleProductDetail | null> {
  const normalizedSku = sku.toUpperCase();
  if (cache.has(normalizedSku)) return cache.get(normalizedSku) ?? null;

  const product = await finaleClient.lookupProduct(normalizedSku);
  cache.set(normalizedSku, product);
  return product;
}

export async function refreshPurchasesGuidanceSnapshot(
  options: RefreshPurchasesGuidanceOptions = {},
): Promise<RefreshPurchasesGuidanceResult> {
  const refreshedAt = new Date().toISOString();
  const scrapeGuidance = options.scrapeGuidance ?? (() => scrapePurchasesGuidanceViaCDP());
  const finaleClient = options.finaleClient ?? new FinaleClient();
  const upsertState = options.upsertState ?? upsertPurchasesGuidanceState;
  const daysBack = options.daysBack ?? 90;

  try {
    const dataset = await scrapeGuidance();
    const flattenedItems = flattenGuidanceItems(dataset);
    const uniqueSkus = [...new Set(flattenedItems.map((item) => item.sku.toUpperCase()))];
    const groups = await finaleClient.getPurchasingIntelligenceForSkus(uniqueSkus, daysBack);
    const assessment = assessPurchasingGroups(groups);
    const assessmentIndex = buildAssessmentIndex(assessment.groups.flatMap((group) => group.items));
    const finaleProductCache = new Map<string, FinaleProductDetail | null>();

    const comparisons: PurchasesGuidanceComparisonResult[] = [];
    for (const guidanceItem of flattenedItems) {
      const assessedLine = assessmentIndex.get(guidanceItem.sku.toUpperCase()) ?? null;
      const finaleProduct = assessedLine
        ? ({ productId: guidanceItem.sku } as FinaleProductDetail)
        : await findFinaleProduct(finaleClient, finaleProductCache, guidanceItem.sku);

      comparisons.push(comparePurchasesGuidanceItem({
        vendorName: guidanceItem.vendorName,
        guidanceItem,
        assessedLine,
        finaleProduct,
      }));
    }

    const summary = summarizePurchasesGuidanceClassifications(comparisons);
    await upsertState({
      status: "success",
      refreshedAt,
      lastSuccessAt: refreshedAt,
      summary,
      guidanceItems: flattenedItems.map((item) => ({
        vendorName: item.vendorName,
        sku: item.sku,
        urgency: item.urgency,
      })),
      comparisons,
      error: null,
    });

    return {
      status: "success",
      refreshedAt,
      lastSuccessAt: refreshedAt,
      summary,
      comparisons,
      guidanceItems: flattenedItems.map((item) => ({
        vendorName: item.vendorName,
        sku: item.sku,
        urgency: item.urgency,
      })),
    };
  } catch (error: any) {
    const summary = summarizePurchasesGuidanceClassifications([]);
    const message = error?.message ?? "Unknown purchases guidance refresh error";

    await upsertState({
      status: "failed",
      refreshedAt,
      lastSuccessAt: null,
      summary,
      guidanceItems: [],
      comparisons: [],
      error: message,
    });

    return {
      status: "failed",
      refreshedAt,
      lastSuccessAt: null,
      summary,
      comparisons: [],
      guidanceItems: [],
      error: message,
    };
  }
}
