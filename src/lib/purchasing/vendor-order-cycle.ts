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
    blockingPO: {
        orderId: string;
        orderDate: string;
        status: string;
        supplier: string;
    } | null;
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
 * Normalize vendor status strings (handles "Committed" -> "ORDER_COMMITTED", etc.)
 */
export function normalizeStatus(status: string): string {
    const s = (status || "").trim().toUpperCase();
    if (s === "COMMITTED") return "ORDER_COMMITTED";
    if (s === "OPEN") return "ORDER_OPEN";
    if (s === "SENT") return "ORDER_SENT";
    if (s === "RECEIVED") return "ORDER_RECEIVED";
    if (s === "DRAFT") return "ORDER_DRAFT";
    if (s === "CANCELED") return "ORDER_CANCELED";
    if (s === "DROPSHIP") return "ORDER_DROPSHIP";
    return s;
}

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
    // Guard: Finale API or upstream transform may produce non-array data
    // under error conditions, causing "a is not iterable" in for-of below.
    if (!Array.isArray(pos)) {
        return { decision: "clear", blockingPOs: [], ignoredCanceled: 0, ignoredDropship: 0 };
    }

    const now = Date.now();
    const cutoff = now - CYCLE_WINDOW_MS;

    const blockingPOs: VendorCycleResult["blockingPOs"] = [];
    let ignoredCanceled = 0;
    let ignoredDropship = 0;

    for (const po of pos) {
        const orderDate = po.orderDate ? new Date(po.orderDate).getTime() : 0;
        const isRecent = orderDate >= cutoff;
        const normalized = normalizeStatus(po.status);

        // Canceled POs don't lock the cycle
        if (normalized === "ORDER_CANCELED" || po.isCanceled) {
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
        if (BLOCKING_STATUSES.has(normalized)) {
            blockingPOs.push({
                orderId: po.orderId,
                orderDate: po.orderDate || "",
                status: po.status,
                supplier: po.supplier,
            });
        }
    }

    // ── Decision logic ──────────────────────────────────────────────────

    const primaryBlockingPO = blockingPOs[0] ?? null;

    // No blocking POs → clear to proceed
    if (blockingPOs.length === 0) {
        return { decision: "clear", blockingPOs: [], blockingPO: null, ignoredCanceled, ignoredDropship };
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
                blockingPO: primaryBlockingPO,
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
        blockingPO: primaryBlockingPO,
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
        const normalized = normalizeStatus(po.status);
        if (normalized === "ORDER_DRAFT" && orderDate >= cutoff) {
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

export function classifyVendorOrderCycle(params: {
    vendorPartyId: string;
    vendorName: string;
    recentPOs: Array<{
        orderId: string;
        orderDate: string | null;
        status: string;
        supplier: string;
        vendorName?: string;
        vendorPartyId?: string;
        isDropship?: boolean;
        isCanceled?: boolean;
    }>;
}): VendorCycleResult & { summary: string } {
    const matchingPOs = params.recentPOs.filter(po => {
        if (po.vendorPartyId && po.vendorPartyId === params.vendorPartyId) return true;
        const poSupplier = (po.supplier || po.vendorName || "").toLowerCase().trim();
        const groupName = params.vendorName.toLowerCase().trim();
        return poSupplier.includes(groupName) || groupName.includes(poSupplier);
    });

    const result = evaluateVendorCycle(matchingPOs, {
        vendorPartyId: params.vendorPartyId,
        vendorName: params.vendorName,
    });
    return { ...result, summary: formatCycleResult(result) };
}


/**
 * Build vendor cycle map for groups of purchasing intelligence.
 * Used by the ULINE automated ordering tool and CLI tools.
 */
export function buildVendorCycleMapForGroups(
    groups: any[],
    recentPOs: any[],
): Record<string, VendorCycleResult> {
    const result: Record<string, VendorCycleResult> = {};
    for (const group of groups) {
        const matchingPOs = recentPOs.filter(po => {
            if (po.vendorPartyId && po.vendorPartyId === group.vendorPartyId) return true;
            const poSupplier = (po.supplier || po.vendorName || "").toLowerCase().trim();
            const groupName = group.vendorName.toLowerCase().trim();
            return poSupplier.includes(groupName) || groupName.includes(poSupplier);
        });

        const mappedPOs = matchingPOs.map(po => ({
            orderId: po.orderId,
            orderDate: po.orderDate,
            status: po.status || po.statusId || "",
            supplier: po.supplier || po.vendorName || "",
            isDropship: po.isDropship || false,
            isCanceled: po.isCanceled || po.status === "ORDER_CANCELED" || false,
        }));

        // Try to find if any item in the group items has zero runway or is build critical to pass as exceptionReason
        let exceptionReason: VendorCycleCheck["exceptionReason"] = undefined;
        if (Array.isArray(group.items)) {
            for (const item of group.items) {
                if (item.urgency === "critical" && (item.adjustedRunwayDays ?? 999) <= (item.leadTimeDays ?? 0)) {
                    exceptionReason = {
                        reason: "zero_runway",
                        detail: `Critical runway for ${item.productId}: ${Math.round(item.adjustedRunwayDays)}d <= lead time ${item.leadTimeDays}d`,
                    };
                    break;
                }
                if (item.triggerReason === "build-driven" || (item.explanation && item.explanation.toLowerCase().includes("build"))) {
                    exceptionReason = {
                        reason: "build_critical",
                        detail: `Upcoming build demand requires ${item.productId}`,
                    };
                    break;
                }
            }
        }

        result[group.vendorPartyId] = evaluateVendorCycle(mappedPOs, {
            vendorPartyId: group.vendorPartyId,
            vendorName: group.vendorName,
            exceptionReason,
        });
    }
    return result;
}

