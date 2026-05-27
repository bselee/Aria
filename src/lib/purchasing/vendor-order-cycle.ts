import type { PurchasingGroup } from "../finale/client";
import {
    assessPurchasingGroups,
    type AssessedPurchasingLine,
    type AssessPurchasingGroupsOptions,
} from "./assessment-service";

export type VendorOrderCycleDecision =
    | "clear"
    | "reuse_draft"
    | "routine_locked"
    | "exception_allowed";

export type VendorCycleExceptionReason =
    | "build_critical"
    | "stockout_before_cycle_end"
    | "sales_or_demand_surge"
    | "manual_override";

export interface VendorCyclePO {
    orderId: string;
    vendorName: string;
    vendorPartyId?: string | null;
    status: string;
    orderDate: string;
    receiveDate?: string | null;
    skus: string[];
}

export interface VendorCycleExceptionEvidence {
    productId: string;
    reason: VendorCycleExceptionReason;
    detail: string;
}

export interface VendorOrderCycleInput {
    vendorPartyId: string;
    vendorName?: string;
    asOfDate?: string;
    cycleDays?: number;
    recentPOs: VendorCyclePO[];
    requestedLines: AssessedPurchasingLine[];
    manualOverride?: boolean;
}

export interface VendorOrderCycleResult {
    decision: VendorOrderCycleDecision;
    cycleDays: number;
    lockedUntil: string | null;
    blockingPO: VendorCyclePO | null;
    ignoredPOs: VendorCyclePO[];
    exceptionEvidence: VendorCycleExceptionEvidence[];
    summary: string;
}

export function mapRecentPOsToVendorCyclePOs(recentPOs: any[]): VendorCyclePO[] {
    return recentPOs.map(po => ({
        orderId: String(po.orderId ?? ""),
        vendorName: String(po.vendorName ?? po.supplierName ?? ""),
        vendorPartyId: po.vendorPartyId ?? null,
        status: String(po.status ?? po.statusId ?? ""),
        orderDate: String(po.orderDate ?? "").slice(0, 10),
        receiveDate: po.receiveDate ? String(po.receiveDate).slice(0, 10) : null,
        skus: (po.items ?? [])
            .map((item: any) => String(item.productId ?? item.sku ?? ""))
            .filter(Boolean),
    })).filter(po => po.orderId && po.orderDate);
}

const ROUTINE_LOCK_STATUSES = new Set([
    "committed",
    "completed",
    "order_committed",
    "order_locked",
    "order_completed",
    "locked",
]);

const DRAFT_STATUSES = new Set([
    "draft",
    "created",
    "order_created",
]);

function dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function parseDateOnly(value: string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(`${value.slice(0, 10)}T12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

function daysBetween(left: Date, right: Date): number {
    return Math.round((right.getTime() - left.getTime()) / 86_400_000);
}

function normalizedStatus(po: VendorCyclePO): string {
    return (po.status || "").trim().toLowerCase();
}

function isCanceled(po: VendorCyclePO): boolean {
    const status = normalizedStatus(po);
    return status.includes("cancel");
}

function isDropship(po: VendorCyclePO): boolean {
    return /dropship/i.test(po.orderId) || po.skus.some(sku => /dropship/i.test(sku));
}

function isDraft(po: VendorCyclePO): boolean {
    const status = normalizedStatus(po);
    return DRAFT_STATUSES.has(status) || status.includes("draft") || status.includes("created");
}

function isRoutineLockingPO(po: VendorCyclePO): boolean {
    if (isCanceled(po) || isDropship(po)) return false;
    const status = normalizedStatus(po);
    return ROUTINE_LOCK_STATUSES.has(status)
        || status.includes("committed")
        || status.includes("completed")
        || status.includes("locked");
}

function normalizeVendorName(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function matchesVendor(po: VendorCyclePO, vendorPartyId: string, vendorName?: string): boolean {
    if (po.vendorPartyId && (po.vendorPartyId === vendorPartyId || po.vendorPartyId.endsWith(`/${vendorPartyId}`))) return true;
    const left = normalizeVendorName(po.vendorName);
    const right = normalizeVendorName(vendorName);
    if (!po.vendorPartyId && !right) return true;
    return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function sortedRecent(pos: VendorCyclePO[]): VendorCyclePO[] {
    return [...pos].sort((left, right) =>
        (right.orderDate || "").localeCompare(left.orderDate || ""),
    );
}

export function deriveVendorCycleExceptionEvidence(
    line: AssessedPurchasingLine,
): VendorCycleExceptionEvidence[] {
    const evidence: VendorCycleExceptionEvidence[] = [];
    const productId = line.item.productId;

    if (line.item.triggerReason === "build-driven") {
        evidence.push({
            productId,
            reason: "build_critical",
            detail: line.item.triggerDetail ?? "Upcoming build demand requires this SKU.",
        });
    }

    if (
        line.item.triggerReason === "stockout-padded"
        || (
            line.item.urgency === "critical"
            && Number.isFinite(line.item.adjustedRunwayDays)
            && line.item.adjustedRunwayDays < line.item.leadTimeDays
        )
    ) {
        evidence.push({
            productId,
            reason: "stockout_before_cycle_end",
            detail: line.item.triggerDetail ?? `Runway ${Math.round(line.item.adjustedRunwayDays)}d is below lead time ${line.item.leadTimeDays}d.`,
        });
    }

    const directDemand = line.candidate.directDemand ?? line.item.demandVelocity ?? 0;
    const purchaseVelocity = line.item.purchaseVelocity ?? 0;
    if (directDemand > 0 && purchaseVelocity > 0 && directDemand >= purchaseVelocity * 2) {
        evidence.push({
            productId,
            reason: "sales_or_demand_surge",
            detail: `Direct demand ${directDemand.toFixed(2)}/day is at least 2x historical purchase velocity ${purchaseVelocity.toFixed(2)}/day.`,
        });
    }

    return evidence;
}

export function classifyVendorOrderCycle(input: VendorOrderCycleInput): VendorOrderCycleResult {
    const cycleDays = input.cycleDays ?? 30;
    const asOf = parseDateOnly(input.asOfDate) ?? new Date();
    const vendorPOs = sortedRecent(input.recentPOs.filter(po => matchesVendor(po, input.vendorPartyId, input.vendorName)));
    const ignoredPOs = vendorPOs.filter(po => isCanceled(po) || isDropship(po));
    const activeDraft = vendorPOs.find(po => !isCanceled(po) && !isDropship(po) && isDraft(po));
    const exceptionEvidence = [
        ...input.requestedLines.flatMap(deriveVendorCycleExceptionEvidence),
        ...(input.manualOverride ? [{
            productId: "*",
            reason: "manual_override" as const,
            detail: "Human override approved this vendor-cycle exception.",
        }] : []),
    ];

    if (activeDraft) {
        return {
            decision: "reuse_draft",
            cycleDays,
            lockedUntil: null,
            blockingPO: activeDraft,
            ignoredPOs,
            exceptionEvidence,
            summary: `Reuse active draft PO ${activeDraft.orderId}.`,
        };
    }

    const lockingPO = vendorPOs.find(po => {
        if (!isRoutineLockingPO(po)) return false;
        const orderDate = parseDateOnly(po.orderDate);
        if (!orderDate) return false;
        return daysBetween(orderDate, asOf) < cycleDays;
    }) ?? null;

    if (!lockingPO) {
        return {
            decision: "clear",
            cycleDays,
            lockedUntil: null,
            blockingPO: null,
            ignoredPOs,
            exceptionEvidence,
            summary: "Vendor cycle is clear.",
        };
    }

    const orderDate = parseDateOnly(lockingPO.orderDate)!;
    const lockedUntil = dateOnly(addDays(orderDate, cycleDays));
    if (exceptionEvidence.length > 0) {
        return {
            decision: "exception_allowed",
            cycleDays,
            lockedUntil,
            blockingPO: lockingPO,
            ignoredPOs,
            exceptionEvidence,
            summary: `Exception allowed despite vendor cycle lock from PO ${lockingPO.orderId}.`,
        };
    }

    return {
        decision: "routine_locked",
        cycleDays,
        lockedUntil,
        blockingPO: lockingPO,
        ignoredPOs,
        exceptionEvidence,
        summary: `Routine cycle locked by PO ${lockingPO.orderId} until ${lockedUntil}.`,
    };
}

export function buildVendorCycleMapForGroups(
    groups: PurchasingGroup[],
    recentPOs: any[],
    options: AssessPurchasingGroupsOptions = {},
): Record<string, VendorOrderCycleResult> {
    const assessment = assessPurchasingGroups(groups, options);
    const vendorCyclePOs = mapRecentPOsToVendorCyclePOs(recentPOs);
    return Object.fromEntries(assessment.groups.map(group => [
        group.vendorPartyId,
        classifyVendorOrderCycle({
            vendorPartyId: group.vendorPartyId,
            vendorName: group.vendorName,
            recentPOs: vendorCyclePOs,
            requestedLines: group.items,
        }),
    ]));
}
