export type UlineDemandSource = "finale" | "request" | "basauto";

export interface UlineDemandItem {
    sku: string;
    description: string;
    requiredQty: number;
    sources: UlineDemandSource[];
}

export interface UlineDemandSourceGroup {
    source: UlineDemandSource;
    items: Array<{
        sku: string;
        description?: string | null;
        requiredQty: number | string | null | undefined;
    }>;
}

export interface UlineDraftSummary {
    orderId: string;
    orderDate: string;
    finaleUrl: string;
}

export interface UlineRecentOrderSummary extends UlineDraftSummary {
    status: string;
}

export type UlineDraftResolution =
    | { action: "create_new_draft" }
    | { action: "reuse_existing_draft"; draftPO: UlineDraftSummary }
    | { action: "review_required"; reason: string; conflictingPOs?: UlineRecentOrderSummary[] };

export interface DraftLineVerification {
    sku: string;
    description: string;
    requiredQty: number;
    currentQty: number;
    sources: UlineDemandSource[];
}

export interface ExtraDraftLine {
    sku: string;
    quantity: number;
    description: string;
}

export interface DraftVerificationResult {
    verified: boolean;
    missingItems: UlineDemandItem[];
    quantityRaises: DraftLineVerification[];
    extraDraftLines: ExtraDraftLine[];
}

function normalizeSku(value: string | null | undefined): string {
    return (value || "").trim().toUpperCase();
}

function parsePositiveQty(value: number | string | null | undefined): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, Math.round(value));
    }
    const numeric = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.round(numeric));
}

function lineProductId(line: any): string {
    const productId = line?.productId;
    if (typeof productId === "string" && productId.trim()) return productId.trim();
    const productUrl = typeof line?.productUrl === "string" ? line.productUrl : "";
    const tail = productUrl.split("/").pop() || "";
    return decodeURIComponent(tail).trim();
}

export function aggregateUlineDemand(groups: UlineDemandSourceGroup[]): UlineDemandItem[] {
    const bySku = new Map<string, UlineDemandItem>();

    for (const group of groups) {
        for (const item of group.items) {
            const sku = normalizeSku(item.sku);
            const requiredQty = parsePositiveQty(item.requiredQty);
            if (!sku || requiredQty <= 0) continue;

            const existing = bySku.get(sku);
            if (!existing) {
                bySku.set(sku, {
                    sku,
                    description: item.description?.trim() || sku,
                    requiredQty,
                    sources: [group.source],
                });
                continue;
            }

            existing.requiredQty = Math.max(existing.requiredQty, requiredQty);
            if ((!existing.description || existing.description === existing.sku) && item.description?.trim()) {
                existing.description = item.description.trim();
            }
            if (!existing.sources.includes(group.source)) {
                existing.sources.push(group.source);
                existing.sources.sort();
            }
        }
    }

    return Array.from(bySku.values()).sort((a, b) => a.sku.localeCompare(b.sku));
}

export function resolveUlineDraftResolution(params: {
    activeDrafts: UlineDraftSummary[];
    recentOrders: UlineRecentOrderSummary[];
}): UlineDraftResolution {
    const { activeDrafts, recentOrders } = params;

    if (activeDrafts.length > 1) {
        return {
            action: "review_required",
            reason: `Multiple active ULINE drafts exist (${activeDrafts.map(po => `#${po.orderId}`).join(", ")}).`,
            conflictingPOs: activeDrafts.map(draft => ({ ...draft, status: "Draft" })),
        };
    }

    if (activeDrafts.length === 1) {
        return {
            action: "reuse_existing_draft",
            draftPO: activeDrafts[0],
        };
    }

    const newestBlocking = recentOrders.find(order => order.status !== "Draft");
    if (newestBlocking) {
        return {
            action: "review_required",
            reason: `Newest matching ULINE PO #${newestBlocking.orderId} is ${newestBlocking.status}. Review before creating a new draft.`,
            conflictingPOs: [newestBlocking],
        };
    }

    return { action: "create_new_draft" };
}

export function buildDraftVerification(
    demand: UlineDemandItem[],
    orderItemList: any[],
): DraftVerificationResult {
    const bySku = new Map<string, { quantity: number; description: string }>();

    for (const line of orderItemList || []) {
        const sku = normalizeSku(lineProductId(line));
        if (!sku) continue;
        bySku.set(sku, {
            quantity: parsePositiveQty(line?.quantity),
            description: line?.itemDescription || line?.description || sku,
        });
    }

    const missingItems: UlineDemandItem[] = [];
    const quantityRaises: DraftLineVerification[] = [];

    for (const item of demand) {
        const current = bySku.get(normalizeSku(item.sku));
        if (!current) {
            missingItems.push(item);
            continue;
        }
        if (current.quantity < item.requiredQty) {
            quantityRaises.push({
                sku: item.sku,
                description: item.description,
                requiredQty: item.requiredQty,
                currentQty: current.quantity,
                sources: item.sources,
            });
        }
    }

    const expectedSkus = new Set(demand.map(item => normalizeSku(item.sku)));
    const extraDraftLines = Array.from(bySku.entries())
        .filter(([sku]) => !expectedSkus.has(sku))
        .map(([sku, value]) => ({
            sku,
            quantity: value.quantity,
            description: value.description,
        }))
        .sort((a, b) => a.sku.localeCompare(b.sku));

    return {
        verified: missingItems.length === 0 && quantityRaises.length === 0 && extraDraftLines.length === 0,
        missingItems,
        quantityRaises,
        extraDraftLines,
    };
}
