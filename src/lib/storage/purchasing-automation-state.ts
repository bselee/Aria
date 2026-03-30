import { createClient } from "../supabase";
import type { VendorFeedbackMemory } from "../purchasing/recommendation-feedback";

export interface PurchasingAutomationStateInput {
    vendorName: string;
    lastProcessedOrderRef?: string | null;
    lastProcessedAt?: string | null;
    lastMappingSyncAt?: string | null;
    cooldownUntil?: string | null;
    constraints?: Record<string, unknown> | null;
    overrideMemory?: Record<string, unknown> | null;
    feedbackMemory?: VendorFeedbackMemory | null;
}

export interface PurchasingAutomationStateRecord extends PurchasingAutomationStateInput {
    vendorKey: string;
}

export function normalizeVendorAutomationKey(vendorName: string): string {
    return vendorName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function buildPurchasingAutomationStatePayload(input: PurchasingAutomationStateInput) {
    const now = new Date().toISOString();

    return {
        vendor_key: normalizeVendorAutomationKey(input.vendorName),
        vendor_name: input.vendorName,
        last_processed_order_ref: input.lastProcessedOrderRef ?? null,
        last_processed_at: input.lastProcessedAt ?? null,
        last_mapping_sync_at: input.lastMappingSyncAt ?? null,
        cooldown_until: input.cooldownUntil ?? null,
        constraints: input.constraints ?? {},
        override_memory: input.overrideMemory ?? {},
        feedback_memory: input.feedbackMemory ?? {},
        updated_at: now,
    };
}

function mapPurchasingAutomationState(row: any): PurchasingAutomationStateRecord | null {
    if (!row?.vendor_name) return null;
    const feedbackMemory = row.feedback_memory ?? {};

    return {
        vendorKey: row.vendor_key,
        vendorName: row.vendor_name,
        lastProcessedOrderRef: row.last_processed_order_ref ?? null,
        lastProcessedAt: row.last_processed_at ?? null,
        lastMappingSyncAt: row.last_mapping_sync_at ?? null,
        cooldownUntil: row.cooldown_until ?? null,
        constraints: row.constraints ?? {},
        overrideMemory: row.override_memory ?? {},
        feedbackMemory: {
            poHistory: feedbackMemory.poHistory ?? {},
            skuFeedback: feedbackMemory.skuFeedback ?? {},
        },
    };
}

export async function getPurchasingAutomationState(vendorName: string): Promise<PurchasingAutomationStateRecord | null> {
    const supabase = createClient();
    if (!supabase) {
        console.warn("[purchasing-automation-state] Supabase unavailable");
        return null;
    }

    const vendorKey = normalizeVendorAutomationKey(vendorName);
    const { data, error } = await supabase
        .from("purchasing_automation_state")
        .select("*")
        .eq("vendor_key", vendorKey)
        .maybeSingle();

    if (error) {
        console.error("[purchasing-automation-state] Fetch failed:", error.message);
        return null;
    }

    return mapPurchasingAutomationState(data);
}

export async function upsertPurchasingAutomationState(input: PurchasingAutomationStateInput): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) {
        console.warn("[purchasing-automation-state] Supabase unavailable");
        return null;
    }

    const payload = buildPurchasingAutomationStatePayload(input);
    const { data, error } = await supabase
        .from("purchasing_automation_state")
        .upsert(payload, { onConflict: "vendor_key" })
        .select("vendor_key")
        .single();

    if (error) {
        console.error("[purchasing-automation-state] Upsert failed:", error.message);
        return null;
    }

    return data?.vendor_key ?? null;
}
