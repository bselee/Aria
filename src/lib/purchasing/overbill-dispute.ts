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

import type { createClient } from "@/lib/db";

export interface OverbillDisputeInput {
    poNumber: string;
    vendorName: string | null | undefined;
    invoiceNumber: string | null | undefined;
    invoicedTotal: number;
    receivedValue: number;
    delta: number;
}

/**
 * The vendor email body in Bill's voice — verbatim (2026-10-28):
 * "Hey- Noticed the delivery did not match up with the invoice. What would
 * you like to do?" The numbers live in the dispute record, not the email;
 * the vendor gets a chance in grace before any figures are quoted.
 */
export function overbillDraftBody(_input: OverbillDisputeInput): string {
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
