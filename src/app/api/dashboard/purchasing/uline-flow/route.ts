import { NextRequest, NextResponse } from "next/server";

import { FinaleClient } from "@/lib/finale/client";
import { scrapeBasautoPurchasingData } from "@/lib/purchasing/basauto-purchases";
import {
    aggregateUlineDemand,
    buildDraftVerification,
    resolveUlineDraftResolution,
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

        if (!vendorPartyId || !Array.isArray(items) || items.length === 0) {
            return NextResponse.json(
                { success: false, message: "vendorPartyId and non-empty items are required" },
                { status: 400 },
            );
        }

        const finaleDemand = items.map(item => ({
            sku: item.productId,
            description: item.productId,
            requiredQty: item.quantity,
        }));

        const [basautoData, requestDemand] = await Promise.all([
            scrapeBasautoPurchasingData({ includeRequests: false }),
            loadPendingUlineRequestDemand(),
        ]);

        const basautoDemand = Object.entries(basautoData.purchases || {})
            .filter(([vendor]) => normalizeVendorLabel(vendor).includes(normalizeVendorLabel(vendorName || "ULINE")))
            .flatMap(([, vendorItems]) => vendorItems.map(item => ({
                sku: item.sku,
                description: item.description || item.sku,
                requiredQty: item.recommendedReorderQty || item.remaining || 0,
            })));

        const aggregatedDemand = aggregateUlineDemand([
            { source: "finale", items: finaleDemand },
            { source: "request", items: requestDemand },
            { source: "basauto", items: basautoDemand },
        ]);

        const finale = new FinaleClient();
        const [activeDrafts, recentOrders] = await Promise.all([
            finale.findActiveDraftPOsForVendor(vendorPartyId),
            finale.findRecentPurchaseOrdersForVendor(vendorPartyId, 14),
        ]);

        const draftResolution = resolveUlineDraftResolution({
            activeDrafts,
            recentOrders,
        });

        if (draftResolution.action === "review_required") {
            return NextResponse.json(
                {
                    success: false,
                    message: draftResolution.reason,
                    draftResolution,
                    aggregatedDemand,
                },
                { status: 409 },
            );
        }

        const unitPriceBySku = new Map(items.map(item => [item.productId.trim().toUpperCase(), item.unitPrice ?? 0]));
        let beforeOrderDetails: any | null = null;
        if (draftResolution.action === "reuse_existing_draft") {
            beforeOrderDetails = await finale.getOrderDetails(draftResolution.draftPO.orderId);
            for (const line of beforeOrderDetails.orderItemList || []) {
                const sku = getLineProductId(line).toUpperCase();
                if (!unitPriceBySku.has(sku) && Number(line.unitPrice || 0) > 0) {
                    unitPriceBySku.set(sku, Number(line.unitPrice));
                }
            }
        }

        const draftResult = await finale.createDraftPurchaseOrder(
            vendorPartyId,
            aggregatedDemand.map(item => ({
                productId: item.sku,
                quantity: item.requiredQty,
                unitPrice: unitPriceBySku.get(item.sku) ?? 0,
            })),
            "ULINE Friday dashboard flow — verify and order",
        );

        const draftDetails = await finale.getOrderDetails(draftResult.orderId);
        const preOrderVerification = buildDraftVerification(aggregatedDemand, draftDetails.orderItemList || []);
        const beforeVerification = beforeOrderDetails
            ? buildDraftVerification(aggregatedDemand, beforeOrderDetails.orderItemList || [])
            : null;

        const poRepairsApplied = {
            addedSkus: beforeVerification?.missingItems.length ?? (draftResolution.action === "create_new_draft" ? aggregatedDemand.length : 0),
            raisedQuantities: beforeVerification?.quantityRaises.length ?? 0,
            extraDraftLines: preOrderVerification.extraDraftLines.length,
        };

        if (!preOrderVerification.verified) {
            return NextResponse.json(
                {
                    success: false,
                    message: "Draft PO failed ULINE verification after repair.",
                    draftResolution,
                    draftPO: { orderId: draftResult.orderId, finaleUrl: draftResult.finaleUrl },
                    aggregatedDemand,
                    poRepairsApplied,
                    preOrderVerification,
                },
                { status: 409 },
            );
        }

        const orderItems = aggregatedDemand.map(item => {
            const line = (draftDetails.orderItemList || []).find((candidate: any) => getLineProductId(candidate).toUpperCase() === item.sku);
            return {
                productId: item.sku,
                quantity: parseQty(line?.quantity),
                unitPrice: Number(line?.unitPrice ?? unitPriceBySku.get(item.sku) ?? 0),
            };
        });

        const cartVerification = await runUlineOrder({
            items: orderItems,
            draftPO: draftResult.orderId,
        });

        return NextResponse.json({
            success: cartVerification.success,
            message: cartVerification.message,
            draftResolution,
            draftPO: { orderId: draftResult.orderId, finaleUrl: draftResult.finaleUrl },
            aggregatedDemand,
            poRepairsApplied,
            preOrderVerification,
            cartVerification,
            priceSyncSummary: {
                priceUpdatesApplied: cartVerification.priceUpdatesApplied ?? 0,
            },
        });
    } catch (err: any) {
        return NextResponse.json(
            { success: false, message: err.message || "ULINE flow failed" },
            { status: 500 },
        );
    }
}
