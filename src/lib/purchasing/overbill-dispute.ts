/**
 * @file    src/lib/purchasing/overbill-dispute.ts
 * @purpose The disposition flow for a bill that exceeds the delivered value.
 *
 *          Bill's process (2026-10-28): he does NOT enter the overbill in
 *          Bill.com. He emails the vendor to give them a chance to correct
 *          it, and enters payment only for what was delivered. This module
 *          holds the dispute state (one open row per PO), builds the vendor
 *          email in his voice (draft-only, never sent), and resolves the
 *          record when the credit or revised invoice lands.
 *
 * @author  Hermia
 * @created 2026-10-28
 * @deps    @/lib/db
 */

import { createClient } from "@/lib/db";

export interface OverbillDisputeInput {
    poNumber: string;
    vendorName: string | null | undefined;
    invoiceNumber: string | null | undefined;
    invoicedTotal: number;
    receivedValue: number;
    delta: number;
    /** Sum of delivered quantities at hold time — the per-line auto-resolve
     *  compares a later bill's quantity sum against this (2026-10-28). */
    receivedQtySum?: number | null;
}

/**
 * The vendor email body in Bill's voice — verbatim (2026-10-28):
 * "Hey- Noticed the delivery did not match up with the invoice. What would
 * you like to do?" The numbers live in the dispute record, not the email;
 * the vendor gets a chance in grace before any figures are quoted.
 */
export function overbillDraftBody(): string {
    return "Hey- Noticed the delivery did not match up with the invoice. What would you like to do?";
}

type DbClient = ReturnType<typeof createClient>;

/**
 * Record the dispute: one open row per PO. Calling again updates the open
 * row rather than stacking duplicates.
 */
export async function recordOverbillDispute(
    db: DbClient,
    input: OverbillDisputeInput & { vendorNotified?: boolean },
): Promise<{ id: string } | { error: string }> {
    if (!db) return { error: "DB unavailable" };
    const payload = {
        po_number: input.poNumber,
        vendor_name: input.vendorName ?? null,
        invoice_number: input.invoiceNumber ?? null,
        invoiced_total: input.invoicedTotal,
        received_value: input.receivedValue,
        delta: input.delta,
        received_qty_sum: input.receivedQtySum ?? null,
        disposition: "held" as const,
        status: "open" as const,
        vendor_notified_at: input.vendorNotified ? new Date().toISOString() : null,
    };
    const { data: existing, error: lookErr } = await db
        .from("overbill_disputes")
        .select("id")
        .eq("po_number", input.poNumber)
        .eq("status", "open")
        .limit(1);
    if (lookErr) return { error: lookErr.message };
    if (existing && existing.length > 0) {
        const { error: upErr } = await db
            .from("overbill_disputes")
            .update({
                invoiced_total: input.invoicedTotal,
                received_value: input.receivedValue,
                delta: input.delta,
                vendor_notified_at: input.vendorNotified ? new Date().toISOString() : undefined,
                updated_at: new Date().toISOString(),
            })
            .eq("id", existing[0].id);
        if (upErr) return { error: upErr.message };
        return { id: String(existing[0].id) };
    }
    const { data: inserted, error: insErr } = await db.from("overbill_disputes").insert(payload).select("id").single();
    if (insErr || !inserted) return { error: insErr?.message || "insert failed" };
    return { id: String(inserted.id) };
}

/** Close the dispute: a credit or revised invoice has landed. */
export async function resolveOverbillDispute(
    db: DbClient,
    poNumber: string,
    resolution: string,
): Promise<{ resolved: boolean; error?: string }> {
    if (!db) return { resolved: false, error: "DB unavailable" };
    const { error } = await db
        .from("overbill_disputes")
        .update({
            status: "resolved",
            resolution: resolution || "resolved manually",
            updated_at: new Date().toISOString(),
        })
        .eq("po_number", poNumber)
        .eq("status", "open");
    if (error) return { resolved: false, error: error.message };
    return { resolved: true };
}

export interface DisputeForAutoResolve {
    poNumber: string;
    receivedValue: number;
    createdAt: string;
    /** Delivered quantity sum captured when the hold was recorded. */
    receivedQtySum?: number | null;
}

export interface NewBillForDispute {
    total: number;
    createdAt: string;
    /** Sum of the bill's line quantities (null when line items unknown). */
    quantitySum?: number | null;
}

/**
 * Pure decision: has a bill landed AFTER the hold that is at or below the
 * delivered value? That is the vendor's revision or credit — the hold closes
 * itself. Never resolves on a bill that still exceeds the delivery.
 *
 * Per-line guard (2026-10-28): when both sides carry quantities, the bill's
 * quantity sum must equal what was delivered. A later bill for a DIFFERENT
 * delivery with a coincidentally lower total must not clear the hold.
 */
export function shouldAutoResolve(
    dispute: DisputeForAutoResolve,
    newBills: NewBillForDispute[],
): { resolve: boolean; reason?: string } {
    const heldAt = Date.parse(dispute.createdAt);
    const later = newBills.filter((b) => {
        const t = Number(b.total);
        const at = Date.parse(b.createdAt);
        return t > 0 && !Number.isNaN(at) && at > heldAt;
    });
    if (later.length === 0) return { resolve: false };
    const settled = later.find((b) => {
        if (Number(b.total) > Number(dispute.receivedValue)) return false;
        const bQty = b.quantitySum;
        const dQty = dispute.receivedQtySum;
        if (bQty != null && bQty > 0 && dQty != null && dQty > 0) {
            return Math.abs(bQty - dQty) <= 0.5;
        }
        return true; // quantities unknown on one side — fall back to total only
    });
    if (!settled) return { resolve: false };
    return {
        resolve: true,
        reason: `auto — revised bill $${Number(settled.total).toLocaleString(undefined, {
            maximumFractionDigits: 0,
        })} at or below delivered $${Number(dispute.receivedValue).toLocaleString(undefined, {
            maximumFractionDigits: 0,
        })}`,
    };
}

/**
 * Sweep open holds and close the ones a later revised bill satisfies. Runs
 * from the overbill-auto-resolve cron; returns what it did for the log.
 */
export async function autoResolveBalancedDisputes(): Promise<{ resolved: number; skipped: number; error?: string }> {
    const db = createClient();
    if (!db) return { resolved: 0, skipped: 0, error: "DB unavailable" };
    const { data: open, error: openErr } = await db
        .from("overbill_disputes")
        .select("po_number, received_value, received_qty_sum, created_at")
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .limit(50);
    if (openErr) return { resolved: 0, skipped: 0, error: openErr.message };
    let resolved = 0;
    for (const d of (open || []) as Array<{
        po_number: string;
        received_value: unknown;
        received_qty_sum?: unknown;
        created_at: string;
    }>) {
        const { data: bills } = await db
            .from("vendor_invoices")
            .select("total, created_at, line_items")
            .eq("po_number", d.po_number)
            .order("created_at", { ascending: false })
            .limit(10);
        const decision = shouldAutoResolve(
            {
                poNumber: d.po_number,
                receivedValue: Number(d.received_value || 0),
                receivedQtySum: d.received_qty_sum == null ? null : Number(d.received_qty_sum),
                createdAt: d.created_at,
            },
            ((bills || []) as Array<{ total?: unknown; created_at?: unknown; line_items?: unknown }>).map((b) => {
                const lines = Array.isArray(b?.line_items) ? (b.line_items as Array<Record<string, unknown>>) : [];
                const quantitySum = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
                return {
                    total: Number(b?.total || 0),
                    createdAt: String(b?.created_at || ""),
                    quantitySum: lines.length > 0 ? quantitySum : null,
                };
            }),
        );
        if (!decision.resolve) continue;
        const res = await resolveOverbillDispute(db, d.po_number, decision.reason || "auto-resolved");
        if (res.resolved) {
            resolved++;
            await db.from("ap_activity_log").insert({
                intent: "OVERBILL_AUTO_RESOLVED",
                created_at: new Date().toISOString(),
                metadata: { poNumber: d.po_number, resolution: decision.reason },
            });
            console.log(`[overbill-auto-resolve] ${d.po_number}: ${decision.reason}`);
        }
    }
    return { resolved, skipped: (open || []).length - resolved };
}
