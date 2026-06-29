/**
 * @file    shipment-store.ts
 * @purpose Supabase-backed shipment evidence store. Uses the shared
 *          Supabase singleton from @/lib/supabase instead of creating
 *          a separate client (was duplicating TCP connections).
 * @author  Hermia
 * @created 2026-06-24 (refactored from direct require)
 * @deps    @/lib/supabase
 * @env     SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@/lib/supabase";

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
    const client = createClient();
    if (!client) throw new Error("Supabase not configured");

    const { data, error } = await client.from("shipments").upsert([evidence], {
        onConflict: "trackingNumber",
    });

    if (error) {
        console.error("Supabase upsert error:", error.message);
        throw error;
    }
    return data;
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
