import { createClient } from "../supabase";
import type { PurchasesGuidanceComparisonResult } from "../purchasing/purchases-guidance-comparison";

export interface PurchasesGuidanceSummary {
  totalItems: number;
  agreesWithPolicy: number;
  overstatesNeed: number;
  understatesNeed: number;
  alreadyOnOrder: number;
  missingInFinale: number;
  needsManualReview: number;
}

export interface PurchasesGuidanceStateInput {
  sourceKey?: string;
  status: "success" | "failed";
  refreshedAt: string;
  lastSuccessAt?: string | null;
  summary: PurchasesGuidanceSummary;
  guidanceItems?: unknown[];
  comparisons?: unknown[];
  error?: string | null;
}

export interface PurchasesGuidanceStateRecord extends PurchasesGuidanceStateInput {
  sourceKey: string;
}

const DEFAULT_SOURCE_KEY = "basauto-purchases";

export function summarizePurchasesGuidanceClassifications(
  comparisons: Array<Pick<PurchasesGuidanceComparisonResult, "classification">>,
): PurchasesGuidanceSummary {
  return {
    totalItems: comparisons.length,
    agreesWithPolicy: comparisons.filter((item) => item.classification === "agrees_with_policy").length,
    overstatesNeed: comparisons.filter((item) => item.classification === "guidance_overstates_need").length,
    understatesNeed: comparisons.filter((item) => item.classification === "guidance_understates_need").length,
    alreadyOnOrder: comparisons.filter((item) => item.classification === "already_on_order").length,
    missingInFinale: comparisons.filter((item) => item.classification === "missing_in_finale").length,
    needsManualReview: comparisons.filter((item) => item.classification === "needs_manual_review").length,
  };
}

export function buildPurchasesGuidanceStatePayload(input: PurchasesGuidanceStateInput) {
  return {
    source_key: input.sourceKey ?? DEFAULT_SOURCE_KEY,
    status: input.status,
    refreshed_at: input.refreshedAt,
    last_success_at: input.lastSuccessAt ?? null,
    summary: input.summary,
    guidance_items: input.guidanceItems ?? [],
    comparisons: input.comparisons ?? [],
    error: input.error ?? null,
    updated_at: new Date().toISOString(),
  };
}

function mapPurchasesGuidanceState(row: any): PurchasesGuidanceStateRecord | null {
  if (!row?.source_key) return null;

  return {
    sourceKey: row.source_key,
    status: row.status,
    refreshedAt: row.refreshed_at,
    lastSuccessAt: row.last_success_at ?? null,
    summary: row.summary ?? summarizePurchasesGuidanceClassifications([]),
    guidanceItems: row.guidance_items ?? [],
    comparisons: row.comparisons ?? [],
    error: row.error ?? null,
  };
}

export async function getPurchasesGuidanceState(
  sourceKey: string = DEFAULT_SOURCE_KEY,
): Promise<PurchasesGuidanceStateRecord | null> {
  const supabase = createClient();
  if (!supabase) {
    console.warn("[purchases-guidance-state] Supabase unavailable");
    return null;
  }

  const { data, error } = await supabase
    .from("purchases_guidance_state")
    .select("*")
    .eq("source_key", sourceKey)
    .maybeSingle();

  if (error) {
    console.error("[purchases-guidance-state] Fetch failed:", error.message);
    return null;
  }

  return mapPurchasesGuidanceState(data);
}

export async function upsertPurchasesGuidanceState(input: PurchasesGuidanceStateInput): Promise<string | null> {
  const supabase = createClient();
  if (!supabase) {
    console.warn("[purchases-guidance-state] Supabase unavailable");
    return null;
  }

  const payload = buildPurchasesGuidanceStatePayload(input);
  const { data, error } = await supabase
    .from("purchases_guidance_state")
    .upsert(payload, { onConflict: "source_key" })
    .select("source_key")
    .single();

  if (error) {
    console.error("[purchases-guidance-state] Upsert failed:", error.message);
    return null;
  }

  return data?.source_key ?? null;
}
