export type POShippingEvidenceKind =
    | "vendor_eta"
    | "vendor_shipment"
    | "invoice_shipment"
    | "tracking"
    | "bol"
    | "tracking_unavailable";

export interface POShippingEvidence {
    kind: POShippingEvidenceKind;
    source: string;
    happenedAt: string;
    summary: string;
    trustworthyTracking: boolean;
}

function byHappenedAtDesc(a: POShippingEvidence, b: POShippingEvidence): number {
    return new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime();
}

export function appendShippingEvidence(
    existing: POShippingEvidence[],
    incoming: POShippingEvidence,
): POShippingEvidence[] {
    const deduped = existing.some((entry) =>
        entry.kind === incoming.kind &&
        entry.source === incoming.source &&
        entry.happenedAt === incoming.happenedAt &&
        entry.summary === incoming.summary,
    );

    if (deduped) return [...existing].sort(byHappenedAtDesc);
    return [...existing, incoming].sort(byHappenedAtDesc);
}

export function findLatestTrustworthyTrackingEvidence(
    evidence: POShippingEvidence[],
): POShippingEvidence | null {
    return [...evidence]
        .filter((entry) => entry.trustworthyTracking)
        .sort(byHappenedAtDesc)[0] || null;
}

export function summarizeMovementUpdate(
    previousSummary: string | null | undefined,
    latestTrackingEvidence: POShippingEvidence | null | undefined,
): string | null {
    if (!latestTrackingEvidence?.trustworthyTracking) return null;
    if (!latestTrackingEvidence.summary.trim()) return null;
    return latestTrackingEvidence.summary === (previousSummary || null)
        ? null
        : latestTrackingEvidence.summary;
}
