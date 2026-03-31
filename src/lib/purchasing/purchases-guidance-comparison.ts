import type { AssessedPurchasingLine } from "./assessment-service";
import type { PurchasesGuidanceBaseItem } from "./purchases-guidance-parser";
import type { FinaleProductDetail } from "../finale/client";

export type PurchasesGuidanceClassification =
  | "agrees_with_policy"
  | "guidance_overstates_need"
  | "guidance_understates_need"
  | "already_on_order"
  | "missing_in_finale"
  | "needs_manual_review";

export interface PurchasesGuidanceComparisonInput {
  vendorName: string;
  guidanceItem: PurchasesGuidanceBaseItem;
  assessedLine: AssessedPurchasingLine | null;
  finaleProduct: FinaleProductDetail | null;
}

export interface PurchasesGuidanceComparisonResult {
  vendorName: string;
  sku: string;
  description: string;
  guidanceUrgency: string;
  classification: PurchasesGuidanceClassification;
  policyDecision: AssessedPurchasingLine["assessment"]["decision"] | null;
  confidence: AssessedPurchasingLine["assessment"]["confidence"] | null;
  recommendedQty: number | null;
  reasonCodes: string[];
  explanation: string;
}

function isGuidanceActionable(urgency: string): boolean {
  return ["URGENT", "OVERDUE", "PURCHASE"].includes(urgency.trim().toUpperCase());
}

function isPolicyActionable(decision: AssessedPurchasingLine["assessment"]["decision"]): boolean {
  return decision === "order" || decision === "reduce";
}

function buildExplanation(guidanceUrgency: string, policyExplanation: string | null, fallback: string): string {
  const parts = [`Guidance site urgency: ${guidanceUrgency || "none"}.`];
  if (policyExplanation) parts.push(`Shared policy: ${policyExplanation}`);
  else parts.push(fallback);
  return parts.join(" ");
}

export function comparePurchasesGuidanceItem(
  input: PurchasesGuidanceComparisonInput,
): PurchasesGuidanceComparisonResult {
  const { guidanceItem, assessedLine, finaleProduct, vendorName } = input;

  if (!finaleProduct && !assessedLine) {
    return {
      vendorName,
      sku: guidanceItem.sku,
      description: guidanceItem.description,
      guidanceUrgency: guidanceItem.urgency,
      classification: "missing_in_finale",
      policyDecision: null,
      confidence: null,
      recommendedQty: null,
      reasonCodes: [],
      explanation: buildExplanation(
        guidanceItem.urgency,
        null,
        "SKU was not found in Finale or the shared purchasing assessment.",
      ),
    };
  }

  if (!assessedLine) {
    return {
      vendorName,
      sku: guidanceItem.sku,
      description: guidanceItem.description,
      guidanceUrgency: guidanceItem.urgency,
      classification: "needs_manual_review",
      policyDecision: null,
      confidence: null,
      recommendedQty: null,
      reasonCodes: [],
      explanation: buildExplanation(
        guidanceItem.urgency,
        null,
        "SKU exists in Finale but is not currently represented in the shared purchasing assessment.",
      ),
    };
  }

  const { assessment, candidate } = assessedLine;
  const baseResult = {
    vendorName,
    sku: guidanceItem.sku,
    description: guidanceItem.description,
    guidanceUrgency: guidanceItem.urgency,
    policyDecision: assessment.decision,
    confidence: assessment.confidence,
    recommendedQty: assessment.recommendedQty,
    reasonCodes: assessment.reasonCodes,
  };

  if (assessment.decision === "manual_review") {
    return {
      ...baseResult,
      classification: "needs_manual_review",
      explanation: buildExplanation(guidanceItem.urgency, assessment.explanation, "Manual review is required."),
    };
  }

  if (
    assessment.reasonCodes.includes("on_order_already_covers_need") ||
    (assessment.decision === "hold" && (candidate.stockOnOrder > 0 || candidate.openPOs.length > 0))
  ) {
    return {
      ...baseResult,
      classification: "already_on_order",
      explanation: buildExplanation(
        guidanceItem.urgency,
        assessment.explanation,
        "Open purchasing coverage already exists for this SKU.",
      ),
    };
  }

  const guidanceActionable = isGuidanceActionable(guidanceItem.urgency);
  const policyActionable = isPolicyActionable(assessment.decision);

  if (guidanceActionable && !policyActionable) {
    return {
      ...baseResult,
      classification: "guidance_overstates_need",
      explanation: buildExplanation(
        guidanceItem.urgency,
        assessment.explanation,
        "The guidance site looks more urgent than the shared purchasing policy.",
      ),
    };
  }

  if (!guidanceActionable && policyActionable) {
    return {
      ...baseResult,
      classification: "guidance_understates_need",
      explanation: buildExplanation(
        guidanceItem.urgency,
        assessment.explanation,
        "The guidance site is quieter than the shared purchasing policy.",
      ),
    };
  }

  return {
    ...baseResult,
    classification: "agrees_with_policy",
    explanation: buildExplanation(
      guidanceItem.urgency,
      assessment.explanation,
      "The guidance site agrees with the shared purchasing policy.",
    ),
  };
}
