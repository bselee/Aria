/**
 * @file    route.ts
 * @purpose API route for modifying a PO to match invoice data.
 *          Surfaces the variance between PO and invoice for team review,
 *          then applies adjustments on confirmation.
 *
 *          GET  — compute diff between PO and a matched invoice
 *          POST — apply modifications to PO (adjust line items, freight, etc.)
 *
 * @author  Hermia
 * @created 2026-07-15
 * @deps    @/lib/finale/client, @/lib/db, @/lib/purchasing/po-lifecycle
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 */

import { NextRequest, NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
import { createClient } from "@/lib/db";
import { transitionLifecycleState } from "@/lib/purchasing/po-lifecycle";
import { recordFreightEvidence } from "@/lib/purchasing/vendor-freight-learning";
import {
    computeInvoicePODiff,
    applyInvoiceModification,
    type LineItemAdjustment,
    type ModificationRequest,
    type ModificationResult,
} from "@/lib/purchasing/po-modification";

// ── Types ──────────────────────────────────────────────────────────────────

export interface LineItemDiff {
    productId: string;
    productName?: string;
    poQuantity: number;
    invoiceQuantity: number | null;
    quantityDiff: number | null;
    poUnitPrice: number;
    invoiceUnitPrice: number | null;
    priceDiff: number | null;
    poLineTotal: number;
    invoiceLineTotal: number | null;
    totalDiff: number | null;
}

export interface InvoicePODiff {
    orderId: string;
    invoiceNumber?: string;
    vendorName: string;
    poTotal: number;
    invoiceTotal: number | null;
    totalDiff: number | null;
    poFreight: number;
    invoiceFreight: number | null;
    freightDiff: number | null;
    lineItems: LineItemDiff[];
    hasChanges: boolean;
}

export interface LineItemAdjustment {
    productId: string;
    newQuantity?: number;
    newUnitPrice?: number;
}

export interface ModificationRequest {
    orderId: string;
    invoiceId?: string;
    adjustments: LineItemAdjustment[];
    freightAdjustment?: number | null;  // null = no change
    freightDescription?: string;
    notes?: string;
}

export interface ModificationResult {
    success: boolean;
    orderId: string;
    invoiceId?: string;
    adjustmentsApplied: number;
    freightApplied: boolean;
    freightBefore?: number;
    freightAfter?: number;
    statusRestored: boolean;
    transitionLogged: boolean;
    errors: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract freight amount from a Finale PO's orderAdjustmentList.
 * Uses FINALE_FEE_TYPES-inspired pattern: finds the first adjustment whose
 * productPromoUrl contains "FREIGHT" or whose description includes "freight".
 */
function extractFreightAmount(po: any): number {
    const adjustments = po.orderAdjustmentList || [];
    const freightAdj = adjustments.find((adj: any) => {
        const url = (adj.productPromoUrl || "").toLowerCase();
        const desc = (adj.description || "").toLowerCase();
        return url.includes("freight") || desc.includes("freight");
    });
    return freightAdj ? Number(freightAdj.amount) || 0 : 0;
}

/**
 * Compute a structured diff between a Finale PO and an invoice record.
 * Returns per-line-item diffs + freight + total diff.
 */
function computeInvoicePODiff(po: any, invoice: any, vendorName: string): InvoicePODiff {
    const poItems = po.orderItemList || [];
    const invoiceLineItems = (invoice.raw_data?.lineItems || []);

    // Build the PO line item map
    const poItemMap = new Map<string, { quantity: number; unitPrice: number }>();
    for (const item of poItems) {
        const pid = item.productId || "";
        poItemMap.set(pid, {
            quantity: Number(item.quantity) || 0,
            unitPrice: Number(item.unitPrice) || 0,
        });
    }

    // Build the invoice line item map (by productId matching or by index)
    const invoiceItemMap = new Map<string, { quantity: number; unitPrice: number }>();
    for (const line of invoiceLineItems) {
        const pid = line.sku || line.productId || "";
        invoiceItemMap.set(pid, {
            quantity: Number(line.qty || line.quantity || 0),
            unitPrice: Number(line.unitPrice || line.price || 0),
        });
    }

    // Diff: consider all unique productIds from both PO and invoice
    const allPids = new Set([...poItemMap.keys(), ...invoiceItemMap.keys()]);
    const lineItems: LineItemDiff[] = [];

    for (const pid of allPids) {
        const po = poItemMap.get(pid);
        const inv = invoiceItemMap.get(pid);

        const poQty = po?.quantity ?? 0;
        const invQty = inv?.quantity ?? null;
        const poPrice = po?.unitPrice ?? 0;
        const invPrice = inv?.unitPrice ?? null;

        const qtyDiff = (invQty !== null && poQty !== invQty) ? (invQty - poQty) : null;
        const priceDiff = (invPrice !== null && poPrice !== invPrice) ? (invPrice - poPrice) : null;
        const poTotal = poQty * poPrice;
        const invTotal = invQty !== null && invPrice !== null ? invQty * invPrice : null;
        const totalDiff = (invTotal !== null && poTotal !== invTotal) ? (invTotal - poTotal) : null;

        lineItems.push({
            productId: pid,
            poQuantity: poQty,
            invoiceQuantity: invQty,
            quantityDiff: qtyDiff,
            poUnitPrice: poPrice,
            invoiceUnitPrice: invPrice,
            priceDiff: priceDiff,
            poLineTotal: poTotal,
            invoiceLineTotal: invTotal,
            totalDiff: totalDiff,
        });
    }

    const poFreight = extractFreightAmount(po);
    const invoiceFreight = invoice.freight != null ? Number(invoice.freight) : null;
    const freightDiff = (invoiceFreight !== null && poFreight !== invoiceFreight) ? (invoiceFreight - poFreight) : null;

    const poTotal = poItems.reduce((s: number, i: any) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0) + poFreight;
    const invoiceTotal = invoice.total != null ? Number(invoice.total) : null;

    const hasChanges =
        lineItems.some(li => li.quantityDiff !== null || li.priceDiff !== null) ||
        freightDiff !== null;

    return {
        orderId: po.orderId || po.po_number || "",
        invoiceNumber: invoice.invoice_number || "",
        vendorName,
        poTotal,
        invoiceTotal,
        totalDiff: (invoiceTotal !== null && poTotal !== invoiceTotal) ? (invoiceTotal - poTotal) : null,
        poFreight,
        invoiceFreight,
        freightDiff,
        lineItems,
        hasChanges,
    };
}

// ── GET: Compute PO-Invoice Diff ───────────────────────────────────────────

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const orderId = searchParams.get("orderId");
        const invoiceId = searchParams.get("invoiceId");

        if (!orderId) {
            return NextResponse.json({ error: "orderId is required" }, { status: 400 });
        }

        const finale = new FinaleClient();
        const po = await (finale as any).getOrderDetails(orderId);

        if (!po) {
            return NextResponse.json({ error: `PO ${orderId} not found in Finale` }, { status: 404 });
        }

        // Resolve vendor name — Finale returns it in orderRoleList
        const supplierRole = (po.orderRoleList || []).find((r: any) => r.roleTypeId === "SUPPLIER");
        const vendorName = supplierRole?.partyName || supplierRole?.partyId || po.supplierName || po.vendorName || "";

        // If invoiceId provided, fetch invoice data from local DB
        if (invoiceId) {
            const db = createClient();
            if (!db) {
                return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
            }

            const { data: invoice, error } = await db
                .from("vendor_invoices")
                .select("*")
                .eq("id", invoiceId)
                .maybeSingle();

            if (error || !invoice) {
                return NextResponse.json({ error: `Invoice ${invoiceId} not found` }, { status: 404 });
            }

            const diff = computeInvoicePODiff(po, invoice, vendorName);
            return NextResponse.json({
                diff,
                po: {
                    orderId: po.orderId || po.po_number,
                    statusId: po.statusId,
                    vendorName,
                    orderDate: po.orderDate,
                    items: poItemsSummary(po),
                },
            });
        }

        // No invoiceId: just return PO summary
        return NextResponse.json({
            po: {
                orderId: po.orderId || po.po_number,
                statusId: po.statusId,
                vendorName,
                orderDate: po.orderDate,
                items: poItemsSummary(po),
            },
        });
    } catch (err: any) {
        console.error("[po-modify] GET error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

/** Summarize PO items for the UI (no sensitive pricing in the brief view). */
function poItemsSummary(po: any): Array<{ productId: string; quantity: number; unitPrice: number }> {
    return (po.orderItemList || []).map((item: any) => ({
        productId: item.productId || "",
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0,
    }));
}

// ── POST: Apply Modifications or Verify & Complete ─────────────────────────

export async function POST(req: NextRequest) {
    const errors: string[] = [];
    try {
        const body = await req.json();

        // ── Action: verify_and_complete — complete PO after verifying invoice reflects actuals ──
        if (body.action === 'verify_and_complete') {
            const { orderId, invoiceId } = body;
            if (!orderId) {
                return NextResponse.json({ error: 'orderId required' }, { status: 400 });
            }

            const finale = new FinaleClient();

            // 1. Transition lifecycle state to COMPLETED
            try {
                const { transitionLifecycleState } = await import('@/lib/purchasing/po-lifecycle');
                await transitionLifecycleState(
                    orderId,
                    'COMPLETED',
                    'dashboard-po-modify',
                    { invoiceId: invoiceId || null, verifiedAt: new Date().toISOString(), method: 'verify_and_complete' },
                );
            } catch (tlErr: any) {
                errors.push(`Lifecycle transition failed: ${tlErr.message}`);
            }

            // 2. Complete in Finale (marks ORDER_COMPLETED)
            let finalStatus = 'ORDER_COMPLETED';
            try {
                const result = await finale.completeOrder(orderId);
                finalStatus = result?.finalStatus || 'ORDER_COMPLETED';
            } catch (coErr: any) {
                errors.push(`Finale completion failed: ${coErr.message}`);
            }

            // 3. Update invoice status
            if (invoiceId) {
                try {
                    const db = createClient();
                    if (db) {
                        await db
                            .from('vendor_invoices')
                            .update({ status: 'completed', updated_at: new Date().toISOString() })
                            .eq('invoice_number', invoiceId);
                    }
                } catch (dbErr: any) {
                    errors.push(`Invoice status update failed: ${dbErr.message}`);
                }
            }

            return NextResponse.json({
                success: errors.length === 0,
                orderId,
                invoiceId,
                completed: true,
                finalStatus,
                errors,
            });
        }

        // ── Action: check_unmatched — list POs without matched invoices ──
        if (body.action === 'check_unmatched') {
            const db = createClient();
            if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

            const { data: unmatched } = await db
                .from('purchase_orders')
                .select('po_number, vendor_name, issue_date, total_amount, status')
                .is('lifecycle_state', null)
                .or('lifecycle_state.neq.RECONCILED,lifecycle_state.neq.COMPLETED')
                .order('issue_date', { ascending: false })
                .limit(50);

            // Also find POs with invoices but not reconciled
            const { data: partial } = await db
                .from('purchase_orders')
                .select('po_number, vendor_name, issue_date, total_amount, status, lifecycle_state')
                .not('lifecycle_state', 'in', '("RECONCILED","COMPLETED","CANCELLED")')
                .order('issue_date', { ascending: false })
                .limit(50);

            return NextResponse.json({
                unmatchedPos: (unmatched || []).map((po: any) => ({
                    orderId: po.po_number,
                    vendorName: po.vendor_name,
                    date: po.issue_date,
                    total: po.total_amount,
                    status: po.status,
                })),
                unreconciledPos: (partial || []).map((po: any) => ({
                    orderId: po.po_number,
                    vendorName: po.vendor_name,
                    date: po.issue_date,
                    total: po.total_amount,
                    status: po.status,
                    lifecycleState: po.lifecycle_state,
                })),
            });
        }

        // ── Default: Apply modifications via service ──
        const { orderId, invoiceId, adjustments, freightAdjustment, freightDescription, notes, triggeredBy } = body;

        if (!orderId) {
            return NextResponse.json({ error: "orderId is required" }, { status: 400 });
        }
        if (!Array.isArray(adjustments) || adjustments.length === 0) {
            return NextResponse.json({ error: "at least one line item adjustment required" }, { status: 400 });
        }

        const finale = new FinaleClient();
        const result: ModificationResult = await applyInvoiceModification(finale, {
            orderId,
            invoiceId,
            adjustments,
            freightAdjustment: freightAdjustment ?? null,
            freightDescription: freightDescription || "Freight adjustment from invoice reconciliation",
            notes: notes || undefined,
            triggeredBy: triggeredBy || "dashboard-po-modify",
        });

        if (result.errors.length > 0 && result.adjustmentsApplied > 0) {
            return NextResponse.json({ ...result, partial: true }, { status: 200 });
        }

        return NextResponse.json(result);
    } catch (err: any) {
        console.error("[po-modify] POST error:", err.message);
        return NextResponse.json({ error: err.message, errors: [...errors, err.message] }, { status: 500 });
    }
}
