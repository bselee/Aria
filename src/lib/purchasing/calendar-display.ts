import type { FullPO } from "../finale/client";
import { carrierUrl, type TrackingStatus } from "../carriers/tracking-service";
import type { PurchasingLifecycleState } from "./calendar-lifecycle";

export interface CalendarTrackingEntry {
    trackingNumber: string;
    displayTracking: string;
    statusDisplay?: string | null;
    publicUrl?: string | null;
}

export interface PurchasingCalendarEventShape {
    title: string;
    description: string;
    eventDate: string;
    colorId: string;
    signature: string;
}

function toDateOnly(dateStr: string | null | undefined): string | null {
    if (!dateStr) return null;
    const isoPrefix = /^(\d{4}-\d{2}-\d{2})/.exec(dateStr);
    if (isoPrefix) return isoPrefix[1];
    const parsed = new Date(dateStr);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function formatCalendarDate(dateStr: string | null | undefined): string {
    const dateOnly = toDateOnly(dateStr);
    if (!dateOnly) return "Unknown";
    return new Date(`${dateOnly}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Denver",
    });
}

export function addCalendarDays(dateStr: string, days: number): string {
    const dateOnly = toDateOnly(dateStr) ?? dateStr;
    const date = new Date(`${dateOnly}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export function normalizeTrackingDisplay(trackingNumber: string): string {
    return trackingNumber.includes(":::") ? trackingNumber.replace(":::", " ") : trackingNumber;
}

export function buildTrackingEntries(
    trackingNumbers: string[],
    prefetchedStatuses?: Map<string, TrackingStatus | null>,
): CalendarTrackingEntry[] {
    return trackingNumbers.map((trackingNumber) => {
        const status = prefetchedStatuses?.get(trackingNumber) ?? null;
        return {
            trackingNumber,
            displayTracking: normalizeTrackingDisplay(trackingNumber),
            statusDisplay: status?.display ?? null,
            publicUrl: status?.public_url ?? carrierUrl(trackingNumber),
        };
    });
}

export function buildPurchasingCalendarEventTitle(
    po: Pick<FullPO, "orderId" | "vendorName">,
    lifecycle: PurchasingLifecycleState,
): string {
    return `${lifecycle.titleEmoji} PO #${po.orderId} - ${po.vendorName}`;
}

export function buildPurchasingCalendarEventDescription(input: {
    po: Pick<FullPO, "orderId" | "orderDate" | "receiveDate" | "items" | "finaleUrl"> & {
        sentAt?: string | null;
    };
    expectedDate: string;
    leadProvenance: string;
    trackingEntries: CalendarTrackingEntry[];
    lifecycle: PurchasingLifecycleState;
}): string {
    const { po, expectedDate, leadProvenance, trackingEntries, lifecycle } = input;
    const lines: string[] = [];

    lines.push(`Sent: ${formatCalendarDate(po.sentAt || po.orderDate)}`);

    if (lifecycle.isReceived && po.receiveDate) {
        const expectedMs = new Date(`${(toDateOnly(expectedDate) ?? expectedDate)}T12:00:00Z`).getTime();
        const actualMs = new Date(`${(toDateOnly(po.receiveDate) ?? po.receiveDate)}T12:00:00Z`).getTime();
        const diffDays = Math.round((actualMs - expectedMs) / 86_400_000);
        const timing = diffDays === 0 ? "on time" : diffDays > 0 ? `${diffDays}d late` : `${Math.abs(diffDays)}d early`;
        lines.push(`Received: ${formatCalendarDate(po.receiveDate)} (${timing})`);
    } else if (!lifecycle.isCancelled) {
        lines.push(`Expected: ${formatCalendarDate(expectedDate)} (${leadProvenance})`);
    }

    if (trackingEntries.length > 0) {
        lines.push("Tracking:");
        for (const entry of trackingEntries) {
            const suffix = entry.statusDisplay ? ` (${entry.statusDisplay})` : "";
            lines.push(`- ${entry.displayTracking}${suffix}`);
            if (entry.publicUrl) lines.push(`  ${entry.publicUrl}`);
        }
    } else if (!lifecycle.isReceived && !lifecycle.isCancelled) {
        lines.push("Tracking: Awaiting Tracking");
    }

    const itemLines = po.items.slice(0, 5).map((item) => `${item.productId} x ${item.quantity.toLocaleString()}`);
    if (po.items.length > 5) itemLines.push(`+ ${po.items.length - 5} more`);
    lines.push(`Items: ${itemLines.join(", ")}`);
    lines.push(`Status: ${lifecycle.statusLabel}`);

    if (lifecycle.isDeliveredAwaitingReceipt) {
        lines.push("Receipt: Tracking shows delivered - verify receiving in Finale");
    } else if (!lifecycle.isReceived && !lifecycle.isCancelled) {
        lines.push("Receipt: Not Yet Received");
    }

    lines.push(`Finale PO: ${po.finaleUrl}`);
    return lines.join("\n");
}

export function buildPurchasingCalendarEventSignature(event: {
    title: string;
    description: string;
    eventDate: string;
    colorId: string;
}): string {
    return JSON.stringify([event.title, event.description, event.eventDate, event.colorId]);
}

export function shouldSyncPurchasingCalendarEvent(existing: {
    status?: string | null;
    last_tracking?: string | null;
    event_signature?: string | null;
}, next: {
    status: string;
    trackingHash: string;
    signature: string;
}): boolean {
    return (
        existing.status !== next.status ||
        (existing.last_tracking ?? "") !== next.trackingHash ||
        (existing.event_signature ?? "") !== next.signature
    );
}

export function buildPurchasingCalendarEvent(input: {
    po: Pick<FullPO, "orderId" | "vendorName" | "orderDate" | "receiveDate" | "items" | "finaleUrl"> & {
        sentAt?: string | null;
    };
    lifecycle: PurchasingLifecycleState;
    expectedDate: string;
    leadProvenance: string;
    trackingEntries: CalendarTrackingEntry[];
    eventDate: string;
}): PurchasingCalendarEventShape {
    const title = buildPurchasingCalendarEventTitle(input.po, input.lifecycle);
    const description = buildPurchasingCalendarEventDescription({
        po: input.po,
        expectedDate: input.expectedDate,
        leadProvenance: input.leadProvenance,
        trackingEntries: input.trackingEntries,
        lifecycle: input.lifecycle,
    });
    const colorId = input.lifecycle.colorId;
    return {
        title,
        description,
        eventDate: input.eventDate,
        colorId,
        signature: buildPurchasingCalendarEventSignature({
            title,
            description,
            eventDate: input.eventDate,
            colorId,
        }),
    };
}
