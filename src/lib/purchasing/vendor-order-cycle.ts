/**
 * @file    src/lib/purchasing/vendor-order-cycle.ts
 * @purpose Vendor-level order cycle guard. Prevents fragmented purchase
 *          orders by detecting whether a vendor already has an active
 *          committed/open PO within the current 30-day cycle.
 *
 *          Uses Finale PO history as source of truth. Canceled and dropship
 *          POs do not count — they don't lock the cycle.
 *
 *          Exception path: proven sale/surge/build-critical demand can
 *          bypass the routine cadence lock with evidence attached.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/finale/purchasing
 *
 * BACKGROUND:
 *   Fragmentation patterns observed at Grassroots (14 POs/year, 2 committed
 *   May 2026 POs) and TeaLAB (2 May POs 12 days apart). The item-level
 *   guard (lead time + 30 days) was insufficient — once a PO is committed,
 *   later SKUs could trigger a second vendor PO in the same month.
 *
 *   This module adds a vendor-level pre-create/pre-order gate that asks:
 *   "Does this vendor already have a routine PO this cycle?"
 *   If yes → routine_locked (block autonomous creation)
 *   If no  → clear (proceed)
 *   If exception → exception_allowed (bypass with evidence)
 */

import { FinaleClient } from "@/lib/finale/client";

// ── Types ───────────────────────────────────────────────────────────────────

export type VendorCycleDecision =
    | "clear"
    | "reuse_draft"
    | "routine_locked"
    | "exception_allowed";

export interface VendorCycleResult {
    decision: VendorCycleDecision;
    blockingPOs: Array<{
        orderId: string;
        orderDate: string;
        status: string;
        supplier: string;
    }>;
    exceptionEvidence?: {
        reason: "sale_demand" | "surge_demand" | "build_critical" | "zero_runway" | "human_override";
        detail: string;
    };
    ignoredCanceled: number;
    ignoredDropship: number;
}

export interface VendorCycleCheck {
    vendorPartyId: string;
    vendorName: string;
    exceptionReason?: VendorCycleResult["exceptionEvidence"];
}

// ── Constants ───────────────────────────────────────────────────────────────

const CYCLE_WINDOW_DAYS = 30;
const CYCLE_WINDOW_MS = CYCLE_WINDOW_DAYS * 86400000;

// Statuses that block the cycle for routine replenishment
const BLOCKING_STATUSES = new Set([
    "ORDER_COMMITTED",
    "ORDER_OPEN",
    "ORDER_SENT",
    "ORDER_RECEIVED",
    "PARTIALLY_RECEIVED",
]);

// Statuses that are ignored (don't lock the cycle)
const IGNORED_STATUSES = new Set([
    "ORDER_CANCELED",
    "ORDER_DROPSHIP",
]);

// ── Pure Classifier ─────────────────────────────────────────────────────────

/**
 * Evaluate whether a vendor is eligible for a new routine PO this cycle.
 *
 * @param pos - Array of recent POs for this vendor (last 45-60 days)
 * @param check - The vendor + optional exception evidence
 * @returns VendorCycleResult with decision and blocking PO details
 */
export function evaluateVendorCycle(
    pos: Array<{
        orderId: string;
        orderDate: string | null;
        status: string;
        supplier: string;
        isDropship?: boolean;
        isCanceled?: boolean;
    }>,
    check: VendorCycleCheck,
): VendorCycleResult {
    const now = Date.now();
    const cutoff = now - CYCLE_WINDOW_MS;

    const blockingPOs: VendorCycleResult["blockingPOs"] = [];
    let ignoredCanceled = 0;
    let ignoredDropship = 0;

    for (const po of pos) {
        const orderDate = po.orderDate ? new Date(po.orderDate).getTime() : 0;
        const isRecent = orderDate >= cutoff;

        // Canceled POs don't lock the cycle
        if (po.status === "ORDER_CANCELED" || po.isCanceled) {
            ignoredCanceled++;
            continue;
        }

        // Dropship POs don't lock the cycle
        if (po.isDropship) {
            ignoredDropship++;
            continue;
        }

        // Only consider POs within the cycle window
        if (!isRecent) continue;

        // Active/recent POs with blocking statuses
        if (BLOCKING_STATUSES.has(po.status)) {
            blockingPOs.push({
                orderId: po.orderId,
                orderDate: po.orderDate || "",
                status: po.status,
                supplier: po.supplier,
            });
        }
    }

    // ── Decision logic ──────────────────────────────────────────────────

    // No blocking POs → clear to proceed
    if (blockingPOs.length === 0) {
        return { decision: "clear", blockingPOs: [], ignoredCanceled, ignoredDropship };
    }

    // Exception evidence overrides the cycle lock
    if (check.exceptionReason) {
        // Surge / build-critical / sale demand → allowed with evidence
        if (
            check.exceptionReason.reason === "sale_demand" ||
            check.exceptionReason.reason === "surge_demand" ||
            check.exceptionReason.reason === "build_critical" ||
            check.exceptionReason.reason === "zero_runway" ||
            check.exceptionReason.reason === "human_override"
        ) {
            return {
                decision: "exception_allowed",
                blockingPOs,
                exceptionEvidence: check.exceptionReason,
                ignoredCanceled,
                ignoredDropship,
            };
        }
    }

    // Has blocking POs + no exception → locked for routine replenishment
    return {
        decision: "routine_locked",
        blockingPOs,
        ignoredCanceled,
        ignoredDropship,
    };
}

/**
 * Check if a draft PO should be reused (same vendor has an editable draft).
 * Only applies when the vendor has an ORDER_DRAFT PO in the cycle window.
 */
export function findReusableDraft(pos: Array<{
    orderId: string;
    status: string;
    orderDate: string | null;
}>): { orderId: string } | null {
    const cutoff = Date.now() - CYCLE_WINDOW_MS;

    for (const po of pos) {
        const orderDate = po.orderDate ? new Date(po.orderDate).getTime() : 0;
        if (po.status === "ORDER_DRAFT" && orderDate >= cutoff) {
            return { orderId: po.orderId };
        }
    }
    return null;
}

/**
 * Format a vendor cycle result for human-readable display.
 * Used in dashboard panels and Telegram messages.
 */
export function formatCycleResult(result: VendorCycleResult): string {
    switch (result.decision) {
        case "clear":
            return "✅ Clear — no active POs this cycle.";

        case "routine_locked":
            const poList = result.blockingPOs
                .map(po => `${po.orderId} (${po.status})`)
                .join(", ");
            return `🔒 Routine locked by: ${poList}. Surge/build exception available.`;

        case "exception_allowed":
            return `⚠️ Exception: ${result.exceptionEvidence?.detail || "surge demand"} (bypassing cycle lock on ${result.blockingPOs.map(po => po.orderId).join(", ")})`;

        case "reuse_draft":
            return "📝 Reuse existing draft PO.";

        default:
            return "Unknown cycle state.";
    }
}

/**
 * Map raw PO records into the shape expected by evaluateVendorCycle.
 * Thin adapter used by the purchasing dashboard API route.
 */
export function mapRecentPOsToVendorCyclePOs(recentPOs: Array<{
    orderId: string;
    orderDate: string | null;
    status: string;
    supplier: string;
    isDropship?: boolean;
    isCanceled?: boolean;
}>): Array<{
    orderId: string;
    orderDate: string | null;
    status: string;
    supplier: string;
    isDropship?: boolean;
    isCanceled?: boolean;
}> {
    return recentPOs;
}

/**
 * Classify a vendor's order cycle status from their recent PO history.
 * Convenience wrapper around evaluateVendorCycle used by the dashboard.
 */
export function classifyVendorOrderCycle(
    recentPOs: Array<{
        orderId: string;
        orderDate: string | null;
        status: string;
        supplier: string;
        isDropship?: boolean;
        isCanceled?: boolean;
    }>,
    vendorPartyId: string,
    vendorName: string,
): VendorCycleResult {
    return evaluateVendorCycle(recentPOs, { vendorPartyId, vendorName });
}
