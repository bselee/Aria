/**
 * @file    route.ts
 * @purpose API route for PO lifecycle panel — returns counts per lifecycle state.
 * @author  Hermia
 * @created 2026-06-01
 * @route   GET /api/dashboard/po-lifecycle
 */

import { createClient } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
    try {
        const db = createClient();
        if (!db) {
            return NextResponse.json({ counts: {} });
        }

        const { data, error } = await supabase
            .from("purchase_orders")
            .select("lifecycle_state");

        if (error || !data) {
            return NextResponse.json({ counts: {} });
        }

        const counts: Record<string, number> = {
            REVIEW: 0,
            SENT: 0,
            ACKNOWLEDGED: 0,
            INVOICED: 0,
            RECONCILED: 0,
            RECEIVED: 0,
            COMPLETED: 0,
            CANCELLED: 0,
        };

        for (const row of data) {
            const state = (row.lifecycle_state as string) || "REVIEW";
            counts[state] = (counts[state] || 0) + 1;
        }

        return NextResponse.json({ counts });
    } catch (err) {
        console.error("[po-lifecycle-api] Error:", (err as Error).message);
        return NextResponse.json({ counts: {} });
    }
}