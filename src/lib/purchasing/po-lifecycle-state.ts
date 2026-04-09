import type { POCompletionState } from "./po-completion-state";
import { findLatestTrustworthyTrackingEvidence, type POShippingEvidence } from "./po-lifecycle-evidence";

export type POLifecycleStage =
    | "draft_created"
    | "committed"
    | "sent"
    | "vendor_acknowledged"
    | "tracking_unavailable"
    | "in_transit"
    | "moving_with_tracking"
    | "received"
    | "ap_follow_up"
    | "complete";

export interface POLifecycleEvidenceInput {
    committedAt?: string | null;
    poSentAt?: string | null;
    vendorAcknowledgedAt?: string | null;
    shippingEvidence: POShippingEvidence[];
    receiveDate?: string | null;
    completionState?: POCompletionState | null;
    trackingRequestedAt?: string | null;
    trackingRequestCount?: number | null;
    lastMovementSummary?: string | null;
}

const TRACKING_REQUEST_DELAY_MS = 3 * 24 * 60 * 60 * 1000;
const TRACKING_REQUEST_COOLDOWN_MS = 2 * 24 * 60 * 60 * 1000;

function hasBroadShippingEvidence(input: POLifecycleEvidenceInput): boolean {
    return input.shippingEvidence.length > 0;
}

function hasTrustworthyTracking(input: POLifecycleEvidenceInput): boolean {
    return !!findLatestTrustworthyTrackingEvidence(input.shippingEvidence);
}

function hasTrackingRequest(input: POLifecycleEvidenceInput): boolean {
    return !!input.trackingRequestedAt || (input.trackingRequestCount || 0) > 0;
}

export function derivePOLifecycleState(input: POLifecycleEvidenceInput): POLifecycleStage {
    if (input.receiveDate) {
        if (input.completionState === "complete") return "complete";
        if (input.completionState) return "ap_follow_up";
        return "received";
    }

    if (hasTrustworthyTracking(input)) return "moving_with_tracking";
    if (hasBroadShippingEvidence(input) && hasTrackingRequest(input)) return "tracking_unavailable";
    if (hasBroadShippingEvidence(input)) return "in_transit";
    if (input.vendorAcknowledgedAt) return "vendor_acknowledged";
    if (input.poSentAt) return "sent";
    if (input.committedAt) return "committed";
    return "draft_created";
}

export function shouldRequestTrackingFollowUp(
    input: POLifecycleEvidenceInput,
    now: Date = new Date(),
): boolean {
    if (!input.poSentAt) return false;
    if (hasTrustworthyTracking(input)) return false;
    if (!hasBroadShippingEvidence(input)) return false;

    const sentAtMs = new Date(input.poSentAt).getTime();
    if (Number.isNaN(sentAtMs)) return false;
    if (now.getTime() - sentAtMs < TRACKING_REQUEST_DELAY_MS) return false;

    const lastRequestMs = input.trackingRequestedAt ? new Date(input.trackingRequestedAt).getTime() : null;
    if (lastRequestMs && !Number.isNaN(lastRequestMs) && now.getTime() - lastRequestMs < TRACKING_REQUEST_COOLDOWN_MS) {
        return false;
    }

    return true;
}
