/**
 * @file    aria-purchase-history.ts
 * @purpose Query our own Supabase purchase_orders table to compute velocity
 *          for products that Finale's demand engine has dropped.
 * @author  Hermia
 * @created 2026-06-11
 * @deps    @/lib/db
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@/lib/db";
import type { AriaPurchaseHistory } from "./purchasing-candidate";

const supabase = createClient();

/**
 * Batch-query our Supabase purchase_orders table for the specified product IDs.
 * Returns a map of product_id → AriaPurchaseHistory.
 *
 * Calculation logic:
 *   - Look back 365 days for recent activity
 *   - Look back 912 days (2.5 years) for older products
 *   - Only count POs with status = 'Completed' or 'Committed'
 *   - Parse line_items JSONB to extract product-specific quantities
 *   - Compute: total_qty, order_count, avg_daily_rate (over entire lookback window)
 *   - If no orders in last 365 days but has older history, still report with lower rate
 */
export async function batchLoadAriaPurchaseHistory(
    productIds: string[],
    lookbackDays: number = 365
): Promise<Map<string, AriaPurchaseHistory>> {
    const result = new Map<string, AriaPurchaseHistory>();

    if (productIds.length === 0) return result;

    const db = createClient();
    if (!db) {
        console.warn("[aria-purchase-history] Supabase client not available");
        // Return empty history for all products
        for (const id of productIds) {
            result.set(id, {
                hasHistory: false,
                totalQty: 0,
                orderCount: 0,
                firstOrderDate: null,
                lastOrderDate: null,
                avgDailyRate: null,
            });
        }
        return result;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - lookbackDays);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    // Batch query all purchase orders that might contain these products
    // We query by status and date, then filter by product_id in the client
    const { data: pos, error } = await supabase
        .from("purchase_orders")
        .select("*, vendor:vendors(name)")
        .gte("order_date", cutoffStr)
        .in("status", ["Completed", "Committed", "Received"]);

    if (error) {
        console.error("[aria-purchase-history] Supabase query failed:", error);
        for (const id of productIds) {
            result.set(id, {
                hasHistory: false,
                totalQty: 0,
                orderCount: 0,
                firstOrderDate: null,
                lastOrderDate: null,
                avgDailyRate: null,
            });
        }
        return result;
    }

    // Initialize all products with empty history
    for (const id of productIds) {
        result.set(id, {
            hasHistory: false,
            totalQty: 0,
            orderCount: 0,
            firstOrderDate: null,
            lastOrderDate: null,
            avgDailyRate: null,
        });
    }

    if (!pos || pos.length === 0) return result;

    // Parse each PO's line_items to find our target products
    const targetSet = new Set(productIds);

    for (const po of pos) {
        // DEFENSIVE(2026-07-27): line_items is jsonb but some historical rows hold a
        // double-encoded JSON *string* (written via JSON.stringify before the
        // po-cache fix). A bare Array.isArray() guard silently skipped those POs,
        // under-reporting purchase history. Coerce the string form before use.
        const lineItems = coerceLineItems(po.line_items);
        if (lineItems.length === 0) continue;

        for (const line of lineItems) {
            const lineProductId = line.product_id || line.sku;
            if (!lineProductId || !targetSet.has(lineProductId)) continue;

            const qty = parseLineQty(line);
            if (qty <= 0) continue;

            const history = result.get(lineProductId)!;
            history.hasHistory = true;
            history.totalQty += qty;
            history.orderCount += 1;

            const orderDate = po.order_date || po.issue_date || po.created_at;
            if (orderDate) {
                if (!history.firstOrderDate || orderDate < history.firstOrderDate) {
                    history.firstOrderDate = orderDate;
                }
                if (!history.lastOrderDate || orderDate > history.lastOrderDate) {
                    history.lastOrderDate = orderDate;
                }
            }
        }
    }

    // Compute avg daily rate for products with history
    result.forEach((history, _id) => {
        if (history.hasHistory && history.firstOrderDate && history.lastOrderDate) {
            const first = new Date(history.firstOrderDate).getTime();
            const last = new Date(history.lastOrderDate).getTime();
            const days = Math.max(1, (last - first) / (1000 * 60 * 60 * 24));

            if (days > 1) {
                // Rate over the actual span of orders
                history.avgDailyRate = Math.round((history.totalQty / days) * 100) / 100;
            } else {
                // Single order or same-day orders — treat as rate over full lookback
                history.avgDailyRate = Math.round((history.totalQty / lookbackDays) * 100) / 100;
            }
        }
    });

    return result;
}

/**
 * Normalize a `purchase_orders.line_items` jsonb value into a real array.
 *
 * The column is `jsonb`, but rows written before the 2026-07-27 po-cache fix
 * used `JSON.stringify(items)`, which stores a JSON *string* (`"[{...}]"`)
 * rather than a JSON array. Callers that guarded with a bare `Array.isArray()`
 * silently dropped those POs from purchase-history aggregation.
 *
 * @param raw - Value as returned by PostgREST: an array, a JSON string, or null.
 * @returns A line-item array; empty when the value is absent or unparseable.
 */
function coerceLineItems(raw: unknown): any[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function parseLineQty(line: any): number {
    if (!line) return 0;
    const qty = line.quantity ?? line.qty ?? line.units ?? line.amount ?? 0;
    const parsed = typeof qty === "string" ? parseFloat(qty) : qty;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
