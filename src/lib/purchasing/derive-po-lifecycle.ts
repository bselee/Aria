export type POLifecycleState =
    | 'sent'
    | 'vendor_acknowledged'
    | 'tracking_unavailable'
    | 'moving_with_tracking'
    | 'ap_follow_up'
    | 'human_escalated';

export interface POLifecycleEvidence {
    sentDate?: string;
    acknowledgmentDate?: string;
    trackingNumbers?: string[];
    trackingStatuses?: string[];
    apFollowUpReason?: string;
    followUpSentAt?: string;
    humanReplyDetectedAt?: string;
    computedAt: string;
}

export interface POLifecycleResult {
    state: POLifecycleState;
    evidence: POLifecycleEvidence;
}

export interface POInput {
    id: string;
    sentDate?: string | null;
    hasTracking?: boolean;
    hasVendorAck?: boolean;
    hasInvoice?: boolean;
    followUpSentAt?: string | null;
    trackingNumbers?: string[];
    acknowledgmentDate?: string | null;
    trackingRequestCount?: number;
    shippingEvidenceCount?: number;
    humanReplyDetectedAt?: string | null;
}

export function derivePOLifecycleState(po: POInput): POLifecycleResult {
    const now = new Date().toISOString();

    const evidence: POLifecycleEvidence = {
        sentDate: po.sentDate ?? now,
        computedAt: now,
    };

    if (po.trackingNumbers?.length) {
        evidence.trackingNumbers = po.trackingNumbers;
    }
    if (po.acknowledgmentDate) {
        evidence.acknowledgmentDate = po.acknowledgmentDate;
    }
    if (po.followUpSentAt) {
        evidence.followUpSentAt = po.followUpSentAt;
    }
    if (po.humanReplyDetectedAt) {
        evidence.humanReplyDetectedAt = po.humanReplyDetectedAt;
    }

    if (po.humanReplyDetectedAt) {
        return { state: 'human_escalated', evidence };
    }

    if (po.hasVendorAck && po.hasTracking) {
        return { state: 'moving_with_tracking', evidence };
    }

    if (po.hasVendorAck && !po.hasTracking) {
        return { state: 'vendor_acknowledged', evidence };
    }

    if (po.hasInvoice && !po.hasTracking && !po.hasVendorAck) {
        evidence.apFollowUpReason = 'invoice_received_without_tracking_or_acknowledgment';
        return { state: 'ap_follow_up', evidence };
    }

    if (!po.hasVendorAck && po.followUpSentAt) {
        return { state: 'tracking_unavailable', evidence };
    }

    return { state: 'sent', evidence };
}

export const FOLLOW_UP_TEMPLATES_L1 = [
    "Hi,\n\nFollowing up on PO #{po} sent {date}. Do you have an expected ship date or tracking?\n\nThanks!",
    "Hi,\n\nChecking in on PO #{po} — any update on tracking or estimated arrival?\n\nThanks!",
    "Hi,\n\nJust wanted to check on PO #{po} sent {date}. Tracking or ETA would be great!\n\nThanks!",
    "Hi,\n\nFollowing up on our PO #{po}. Do you have shipping info or an ETA?\n\nThanks!",
    "Hi,\n\nPO #{po} from {date} — do you have tracking or ship date?\n\nThanks!",
] as const;

export const FOLLOW_UP_TEMPLATES_L2 = [
    "Hi,\n\nFollowing up again on PO #{po} sent {date}. We really need the tracking or ship date to plan our receiving.\n\nThanks!",
    "Hi,\n\nHaven't heard back on PO #{po}. Do you have an ETA or tracking info?\n\nThanks!",
    "Hi,\n\nChecking in again on PO #{po}. Any shipping updates or tracking?\n\nThanks!",
    "Hi,\n\nStill waiting on tracking for PO #{po} from {date}. Can you help?\n\nThanks!",
] as const;

export function getFollowUpTemplate(index: number): string {
    return FOLLOW_UP_TEMPLATES_L1[index % FOLLOW_UP_TEMPLATES_L1.length];
}

export function getFollowUpTemplateL2(index: number): string {
    return FOLLOW_UP_TEMPLATES_L2[index % FOLLOW_UP_TEMPLATES_L2.length];
}

export function shouldUseL2FollowUp(trackingRequestCount: number): boolean {
    return trackingRequestCount >= 2;
}

/**
 * Returns true when a tracking follow-up should be sent.
 * After 2 follow-ups with no response, returns false — escalation to human should happen instead.
 */
export function shouldRequestTrackingFollowUp(
    trackingRequestCount: number,
    shippingEvidenceCount: number,
    hasVendorAck: boolean
): boolean {
    if (trackingRequestCount >= 2 && shippingEvidenceCount === 0) return false;
    if (!hasVendorAck && trackingRequestCount === 0) return true;
    if (hasVendorAck && shippingEvidenceCount === 0 && trackingRequestCount < 2) return true;
    return false;
}
