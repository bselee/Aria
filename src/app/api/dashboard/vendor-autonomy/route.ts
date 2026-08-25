/**
 * @file    src/app/api/dashboard/vendor-autonomy/route.ts
 * @purpose Manual checkbox: set vendor_profiles.autonomy_level to 1 (auto-draft)
 *          or 0 (manual). Caps at 1. NEVER_AUTONOMOUS vendors cannot be enabled.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    db, ordering-row-copy
 * @env     PGRST_URL
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/db";
import { isNeverAutonomous } from "@/lib/purchasing/ordering-row-copy";

export async function POST(req: NextRequest) {
    const body = await req.json().catch(() => ({}));
    const vendorName = String(body.vendorName ?? "").trim();
    const enabled = Boolean(body.enabled);

    if (!vendorName) {
        return NextResponse.json({ error: "vendorName required" }, { status: 400 });
    }
    if (enabled && isNeverAutonomous(vendorName)) {
        return NextResponse.json(
            { error: "This vendor cannot be auto-drafted", autonomyLevel: 0 },
            { status: 403 },
        );
    }

    const db = createClient();
    if (!db) {
        return NextResponse.json({ error: "db unavailable" }, { status: 503 });
    }

    const autonomyLevel = enabled ? 1 : 0;
    const now = new Date().toISOString();

    const { data: existing } = await db
        .from("vendor_profiles")
        .select("id, vendor_name, autonomy_level")
        .eq("vendor_name", vendorName)
        .limit(1);

    const row = Array.isArray(existing) ? existing[0] : existing;
    if (row?.id) {
        const { error } = await db
            .from("vendor_profiles")
            .update({ autonomy_level: autonomyLevel, updated_at: now })
            .eq("id", row.id);
        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
    } else {
        const { error } = await db.from("vendor_profiles").insert({
            vendor_name: vendorName,
            autonomy_level: autonomyLevel,
            updated_at: now,
        });
        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
    }

    return NextResponse.json({ vendorName, autonomyLevel });
}
