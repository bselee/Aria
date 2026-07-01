/**
 * @file    shipment-store.ts
 * @purpose Local SQLite-based shipment evidence store.
 *          Replaces Supabase-backed shipment storage.
 * @author  Hermia
 * @created 2026-06-24 (refactored from direct require)
 * @updated 2026-07-01 — migrated from Supabase to local SQLite
 * @deps    src/lib/storage/local-db.ts
 */

import { getLocalDb } from "./local-db";

function ensureTable(): void {
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS shipments (
            tracking_number TEXT PRIMARY KEY,
            carrier TEXT,
            status_category TEXT,
            status_display TEXT,
            confidence REAL DEFAULT 0,
            source_ref TEXT,
            active INTEGER DEFAULT 1,
            payload_json TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `);
}

export async function upsertShipment(evidence: {
    trackingNumber: string;
    carrier: string;
    statusCategory: string;
    statusDisplay: string;
    confidence: number;
    sourceRef: string;
    active: boolean;
    id?: string;
    createdAt?: Date;
}) {
    try {
        ensureTable();
        const db = getLocalDb();

        const payload = {
            tracking_number: evidence.trackingNumber,
            carrier: evidence.carrier,
            status_category: evidence.statusCategory,
            status_display: evidence.statusDisplay,
            confidence: evidence.confidence,
            source_ref: evidence.sourceRef,
            active: evidence.active ? 1 : 0,
            payload_json: JSON.stringify({
                id: evidence.id,
                createdAt: evidence.createdAt?.toISOString(),
            }),
        };

        db.prepare(`
            INSERT OR REPLACE INTO shipments (tracking_number, carrier, status_category, status_display, confidence, source_ref, active, payload_json, updated_at)
            VALUES (@tracking_number, @carrier, @status_category, @status_display, @confidence, @source_ref, @active, @payload_json, datetime('now'))
        `).run(payload);

        return payload;
    } catch (err: any) {
        console.error("[shipment-store] Upsert error:", err.message);
        throw err;
    }
}

export type ShipmentEvidence = {
    id?: string;
    trackingNumber: string;
    carrier: string;
    statusCategory: string;
    statusDisplay: string;
    confidence: number;
    sourceRef: string;
    active: boolean;
    createdAt?: Date;
};
