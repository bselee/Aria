/**
 * @file    purchasing-automation-state.ts
 * @purpose Local SQLite-based purchasing automation state store.
 *          Replaces Supabase-based storage for vendor automation state.
 *          Each vendor's automation state is stored as a JSON blob in SQLite.
 * @created 2026-07-01 — migrated from Supabase to SQLite
 * @deps    src/lib/storage/local-db.ts
 */

import { getLocalDb } from "./local-db";
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

function ensureTable(): void {
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS purchasing_automation_state (
            vendor_key TEXT PRIMARY KEY,
            vendor_name TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

export async function getPurchasingAutomationState(vendorName: string): Promise<PurchasingAutomationStateRecord | null> {
    try {
        ensureTable();
        const db = getLocalDb();
        const vendorKey = normalizeVendorAutomationKey(vendorName);
        const row = db.prepare(
            `SELECT payload_json FROM purchasing_automation_state WHERE vendor_key = ?`
        ).get(vendorKey) as { payload_json: string } | undefined;

        if (!row) return null;
        return mapPurchasingAutomationState(JSON.parse(row.payload_json));
    } catch (err: any) {
        console.error("[purchasing-automation-state] Fetch failed:", err.message);
        return null;
    }
}

export async function upsertPurchasingAutomationState(input: PurchasingAutomationStateInput): Promise<string | null> {
    try {
        ensureTable();
        const db = getLocalDb();
        const payload = buildPurchasingAutomationStatePayload(input);
        const vendorKey = normalizeVendorAutomationKey(input.vendorName);

        db.prepare(`
            INSERT OR REPLACE INTO purchasing_automation_state (vendor_key, vendor_name, payload_json, updated_at)
            VALUES (?, ?, ?, datetime('now'))
        `).run(vendorKey, input.vendorName, JSON.stringify(payload));

        return vendorKey;
    } catch (err: any) {
        console.error("[purchasing-automation-state] Upsert failed:", err.message);
        return null;
    }
}
