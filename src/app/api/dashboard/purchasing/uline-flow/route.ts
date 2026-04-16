import { NextRequest, NextResponse } from "next/server";

import { FinaleClient } from "@/lib/finale/client";
import { scrapeBasautoPurchasingData } from "@/lib/purchasing/basauto-purchases";
import {
    aggregateUlineDemand,
    buildDraftVerification,
} from "@/lib/purchasing/uline-flow";
import { runUlineOrder } from "@/lib/purchasing/uline-order-service";
import { loadPendingUlineRequestDemand } from "@/lib/purchasing/uline-request-demand";

interface FlowItemInput {
    productId: string;
    quantity: number;
    unitPrice?: number;
}

interface FlowRequest {
    vendorName: string;
    vendorPartyId: string;
    items: FlowItemInput[];
}

function parseQty(value: unknown): number {
    const numeric = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return Math.round(numeric);
}

function normalizeVendorLabel(value: string): string {
    return value.replace(/\d+$/, "").trim().toLowerCase();
}

function getLineProductId(line: any): string {
    return (line?.productId || decodeURIComponent(String(line?.productUrl || "").split("/").pop() || "")).trim();
}

export async function POST(req: NextRequest) {
    try {
        const { vendorName, vendorPartyId, items } = await req.json() as FlowRequest;

        if (!vendorPartyId) {
            return NextResponse.json(
                { success: false, message: "vendorPartyId is required" },
                { status: 400 },
            );
        }

        const finaleDemand = (items || [])
            .filter(item => parseQty(item.quantity) > 0)
            .map(item => ({
                sku: item.productId,
                description: item.productId,
                requiredQty: parseQty(item.quantity),
            }));

        // ── Stage 1: Gather supplemental demand ──────────────────────────────
        let basautoDemand: typeof finaleDemand = [];
        try {
            const basautoData = await scrapeBasautoPurchasingData({ includeRequests: false });
            const vendorNorm = normalizeVendorLabel(vendorName || "ULINE");
            basautoDemand = Object.entries(basautoData.purchases || {})
                .filter(([vendor]) => normalizeVendorLabel(vendor) === vendorNorm)
                .flatMap(([, vendorItems]) => vendorItems
                    .filter(item => item.sku)
                    .map(item => ({
                        sku: item.sku,
                        description: item.description || item.sku,
                        // basauto may not have quantities — presence means needed, default to 1
                        requiredQty: parseQty(item.recommendedReorderQty || item.remaining) || 1,
                    })));
        } catch (err: any) {
            console.warn("[uline-flow] basauto scrape failed (continuing without):", err.message);
        }

        const requestDemand = await loadPendingUlineRequestDemand().catch(() => []);

        const aggregatedDemand = aggregateUlineDemand([
            { source: "finale", items: finaleDemand },
            { source: "request", items: requestDemand },
            { source: "basauto", items: basautoDemand },
        ]);

        if (aggregatedDemand.length === 0) {
            return NextResponse.json(
                { success: false, message: "No items with positive quantity after aggregation" },
                { status: 400 },
            );
        }

        // ── Stage 2: 7-day blocking check ────────────────────────────────────
        // ONE decision point: if a committed/completed ULINE PO exists in 7 days, halt.
        // Draft reuse is handled internally by createDraftPurchaseOrder.
        const finale = new FinaleClient();
        const recentOrders = await finale.findRecentPurchaseOrdersForVendor(vendorPartyId, 7);
        const blockingPO = recentOrders.find(po => po.status !== "Draft");
        if (blockingPO) {
            return NextResponse.json(
                {
                    success: false,
                    message: `ULINE PO #${blockingPO.orderId} (${blockingPO.status}) exists from ${blockingPO.orderDate}. Review before creating a new order.`,
                    blockingPO,
                    aggregatedDemand,
                },
                { status: 409 },
            );
        }

        // ── Stage 3: Create or reuse draft (Finale owns this decision) ───────
        const unitPriceBySku = new Map((items || []).map(item => [item.productId.trim().toUpperCase(), item.unitPrice ?? 0]));
        const draftResult = await finale.createDraftPurchaseOrder(
            vendorPartyId,
            aggregatedDemand.map(item => ({
                productId: item.sku,
                quantity: item.requiredQty,
                unitPrice: unitPriceBySku.get(item.sku) ?? 0,
            })),
            "ULINE Friday dashboard flow",
        );

        // ── Stage 4: Verify draft contents match demand ──────────────────────
        const draftDetails = await finale.getOrderDetails(draftResult.orderId);
        const verification = buildDraftVerification(aggregatedDemand, draftDetails.orderItemList || []);

        // ── Stage 5: Fill ULINE cart ─────────────────────────────────────────
        const orderItems = aggregatedDemand
            .map(item => {
                const line = (draftDetails.orderItemList || []).find(
                    (c: any) => getLineProductId(c).toUpperCase() === item.sku,
                );
                const qty = parseQty(line?.quantity);
                if (qty <= 0) return null;
                return {
                    productId: item.sku,
                    quantity: qty,
                    unitPrice: Number(line?.unitPrice ?? unitPriceBySku.get(item.sku) ?? 0),
                };
            })
            .filter(Boolean) as Array<{ productId: string; quantity: number; unitPrice: number }>;

        const cartResult = await runUlineOrder({
            items: orderItems,
            draftPO: draftResult.orderId,
        });

        return NextResponse.json({
            success: cartResult.success,
            message: cartResult.message,
            draftPO: { orderId: draftResult.orderId, finaleUrl: draftResult.finaleUrl },
            duplicateWarnings: draftResult.duplicateWarnings,
            aggregatedDemand,
            verification,
            cartVerification: cartResult,
            priceSyncSummary: {
                priceUpdatesApplied: cartResult.priceUpdatesApplied ?? 0,
            },
        });
    } catch (err: any) {
        return NextResponse.json(
            { success: false, message: err.message || "ULINE flow failed" },
            { status: 500 },
        );
    }
}
