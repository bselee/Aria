/**
 * @file    active-purchases-movement.ts
 * @purpose Pure, testable derivation of the per-PO "movement" story for Active
 *          Purchases: tracking status, ETA, carrier, invoice state, and the
 *          PO ↔ tracking ↔ invoice correlation counts. No DB access — feeds
 *          the ActivePurchase.movement computed field.
 * @author  BuildASoil
 * @deps    carrierUrl (tracking-service)
 */

import { carrierUrl } from "@/lib/carriers/tracking-service";
import {
    earliestDeliveredAt,
    formatReceiptLagBadge,
    hoursSinceDelivered,
    receiptLagLevel,
    type ReceiptLagLevel,
} from "@/lib/tracking/delivered-unreceived";

export type MovementStatus =
    | "none"
    | "candidate"
    | "in_transit"
    | "out_for_delivery"
    | "delivered"
    | "exception"
    | "stale";

export type MovementEvidenceLevel = "confirmed" | "candidate" | "none";

export type InvoiceMovementState = "none" | "pending_ap" | "paid" | "matched" | "discrepancy";

export interface PurchaseMovement {
    status: MovementStatus;
    trackingNumbers: string[]; // confirmed first, then candidate, then legacy
    primaryEta: string | null;
    primaryCarrier: string | null;
    primaryUrl: string | null;
    evidenceLevel: MovementEvidenceLevel;
    /** Carrier delivered_at (earliest) when status is delivered. */
    deliveredAt: string | null;
    /** Whole hours since deliveredAt (null if not delivered). */
    hoursSinceDelivered: number | null;
    /**
     * Lag vs Finale receive — only meaningful when movement is delivered and
     * the PO is not isReceived (caller must not show escalate if already received).
     */
    receiptLag: ReceiptLagLevel;
    /** Ready-to-render badge text for delivered/unreceived. */
    receiptLagLabel: string | null;
    invoice: {
        state: InvoiceMovementState;
        invoiceId?: string;
        hasTrackingFromInvoice: boolean;
    };
    correlation: {
        orphanTrackingCount: number;
        poLinkedShipmentCount: number;
        lastSource: string | null;
    };
}

/** Minimal shipment shape — matches ShipmentRecord plus the evidence classification. */
export interface MovementShipmentInput {
    tracking_number: string;
    public_tracking_url: string | null;
    carrier_name: string | null;
    status_category: string | null;
    estimated_delivery_at: string | null;
    delivered_at?: string | null;
    last_checked_at: string | null;
    last_source: string | null;
    source_refs?: Array<{ source: string; seenAt?: string | null }>;
    evidenceLevel: "confirmed" | "candidate";
}

export interface PurchaseMovementInput {
    shipments: MovementShipmentInput[];
    legacyTrackingNumbers: string[];
    invoiceStatus?: string | null;
    invoiceId?: string;
    hasDiscrepancies?: boolean;
    /** When true, receipt lag is forced to ok (Finale already received). */
    isReceived?: boolean;
    now?: string;
}

const STALE_MS = 24 * 60 * 60 * 1000;

/** Sources that prove tracking was embedded in an invoice / BOL document. */
const INVOICE_TRACKING_SOURCES = new Set(["ap_invoice", "bol_pdf", "email_ingest_bol_vision"]);

const PAID_INVOICE_STATUSES = new Set(["matched_approved", "reconciled", "approved", "paid"]);
// "matched" = matched to the PO and done; matched_review intentionally falls
// through to pending_ap so the strip's amber "INV AP" matches the panel's
// existing amber "Pending Approval" action badge.
const MATCHED_INVOICE_STATUSES = new Set(["matched"]);

function toTime(value: string | null | undefined): number {
    if (!value) return NaN;
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? NaN : t;
}

export function deriveInvoiceMovementState(input: {
    invoiceStatus?: string | null;
    hasDiscrepancies?: boolean;
}): InvoiceMovementState {
    if (input.hasDiscrepancies) return "discrepancy";
    const status = String(input.invoiceStatus || "").trim().toLowerCase();
    if (!status) return "none";
    if (PAID_INVOICE_STATUSES.has(status)) return "paid";
    if (MATCHED_INVOICE_STATUSES.has(status)) return "matched";
    return "pending_ap";
}

function shipmentHasInvoiceTracking(shipment: MovementShipmentInput): boolean {
    if (shipment.last_source && INVOICE_TRACKING_SOURCES.has(shipment.last_source)) return true;
    return (shipment.source_refs || []).some((ref) => INVOICE_TRACKING_SOURCES.has(ref.source));
}

function pickPrimaryShipment(shipments: MovementShipmentInput[]): MovementShipmentInput | null {
    if (shipments.length === 0) return null;
    const confirmed = shipments.filter((s) => s.evidenceLevel === "confirmed");
    const pool = confirmed.length > 0 ? confirmed : shipments;
    // Prefer non-delivered legs; earliest ETA wins; tiebreak on most recently checked.
    const active = pool.filter((s) => s.status_category !== "delivered");
    const candidates = active.length > 0 ? active : pool;
    return [...candidates].sort((a, b) => {
        const ea = toTime(a.estimated_delivery_at) || Number.MAX_SAFE_INTEGER;
        const eb = toTime(b.estimated_delivery_at) || Number.MAX_SAFE_INTEGER;
        if (ea !== eb) return ea - eb;
        const ta = toTime(a.last_checked_at) || 0;
        const tb = toTime(b.last_checked_at) || 0;
        return tb - ta;
    })[0];
}

function uniqueTrackingNumbers(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const trimmed = String(value || "").trim();
        if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        result.push(trimmed);
    }
    return result;
}

/**
 * Build the single PO-centric movement story from shipment evidence,
 * legacy tracking numbers, and invoice state. Fail-open: any missing input
 * degrades to "none" / empty correlation rather than throwing.
 */
export function derivePurchaseMovement(input: PurchaseMovementInput): PurchaseMovement {
    const now = toTime(input.now) || Date.now();
    const shipments = input.shipments || [];
    const legacyTrackingNumbers = input.legacyTrackingNumbers || [];
    const confirmedShipments = shipments.filter((s) => s.evidenceLevel === "confirmed");

    const evidenceLevel: MovementEvidenceLevel =
        confirmedShipments.length > 0
            ? "confirmed"
            : shipments.length > 0 || legacyTrackingNumbers.length > 0
                ? "candidate"
                : "none";

    let status: MovementStatus;
    if (shipments.length === 0 && legacyTrackingNumbers.length === 0) {
        status = "none";
    } else if (evidenceLevel === "candidate") {
        status = "candidate";
    } else if (confirmedShipments.some((s) => s.status_category === "exception")) {
        status = "exception";
    } else if (confirmedShipments.every((s) => s.status_category === "delivered")) {
        status = "delivered";
    } else if (confirmedShipments.some((s) => s.status_category === "out_for_delivery")) {
        status = "out_for_delivery";
    } else {
        const activeConfirmed = confirmedShipments.filter((s) => s.status_category !== "delivered");
        const allStale = activeConfirmed.every((s) => {
            const checked = toTime(s.last_checked_at);
            if (Number.isNaN(checked)) return true; // never carrier-checked = stale
            return now - checked > STALE_MS;
        });
        status = allStale ? "stale" : "in_transit";
    }

    const primary = pickPrimaryShipment(shipments);
    const primaryEta =
        primary?.estimated_delivery_at ||
        shipments.find((s) => s.estimated_delivery_at)?.estimated_delivery_at ||
        null;

    // Confirmed first, then candidate shipments, then legacy (unbacked) numbers.
    const trackingNumbers = uniqueTrackingNumbers([
        ...confirmedShipments.map((s) => s.tracking_number),
        ...shipments.filter((s) => s.evidenceLevel !== "confirmed").map((s) => s.tracking_number),
        ...legacyTrackingNumbers,
    ]);

    const shipmentTracking = new Set(shipments.map((s) => s.tracking_number.toLowerCase()));
    const orphanTrackingCount = legacyTrackingNumbers.filter(
        (t) => !shipmentTracking.has(String(t || "").trim().toLowerCase()),
    ).length;

    // Most recent evidence source across source_refs, else last_source.
    let lastSource: string | null = null;
    let lastSeen = -1;
    for (const shipment of shipments) {
        for (const ref of shipment.source_refs || []) {
            const seenAt = toTime(ref.seenAt);
            if (seenAt > lastSeen) {
                lastSeen = seenAt;
                lastSource = ref.source;
            }
        }
        if (!lastSource && shipment.last_source) lastSource = shipment.last_source;
    }

    const invoiceState = deriveInvoiceMovementState({
        invoiceStatus: input.invoiceStatus,
        hasDiscrepancies: input.hasDiscrepancies,
    });

    // Delivered lag vs Finale receive (warehouse owns receive — we only flag)
    const deliveredAt =
        status === "delivered"
            ? earliestDeliveredAt(
                confirmedShipments.map((s) => ({
                    status_category: s.status_category,
                    delivered_at: s.delivered_at ?? null,
                })),
            )
            : null;
    const hours =
        deliveredAt && !input.isReceived
            ? hoursSinceDelivered(deliveredAt, now)
            : null;
    const lag: ReceiptLagLevel =
        status === "delivered" && !input.isReceived
            ? receiptLagLevel(hours)
            : "ok";
    const receiptLagLabel =
        status === "delivered" && !input.isReceived && hours != null
            ? formatReceiptLagBadge(hours, lag)
            : status === "delivered" && !input.isReceived
                ? formatReceiptLagBadge(0, "ok")
                : null;

    return {
        status,
        trackingNumbers,
        primaryEta,
        primaryCarrier: primary?.carrier_name || null,
        primaryUrl: primary
            ? primary.public_tracking_url || carrierUrl(primary.tracking_number)
            : null,
        evidenceLevel,
        deliveredAt,
        hoursSinceDelivered: hours,
        receiptLag: lag,
        receiptLagLabel,
        invoice: {
            state: invoiceState,
            ...(input.invoiceId ? { invoiceId: input.invoiceId } : {}),
            hasTrackingFromInvoice: shipments.some(shipmentHasInvoiceTracking),
        },
        correlation: {
            orphanTrackingCount,
            poLinkedShipmentCount: shipments.length,
            lastSource,
        },
    };
}
