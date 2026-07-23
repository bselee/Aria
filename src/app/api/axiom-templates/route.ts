/**
 * @file    route.ts
 * @purpose API endpoints to manage per-SKU approved Axiom order templates.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    @/lib/db, @/lib/axiom/lifecycle, next/server
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/db";
import { reassessActiveLifecyclesForSKU } from "@/lib/axiom/lifecycle";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Fetches approved Axiom templates.
 * Supports filtering by `sku` query parameter.
 */
export async function GET(req: NextRequest) {
    const db = createClient();
    if (!db) {
        return NextResponse.json(
            { error: "database unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }

    try {
        const { searchParams } = new URL(req.url);
        const sku = searchParams.get("sku");

        let query = db.from("axiom_order_templates").select("*");
        if (sku) {
            query = query.eq("finale_sku", sku);
        } else {
            query = query.order("finale_sku", { ascending: true });
        }

        const { data, error } = await query;

        if (error) {
            throw error;
        }

        return NextResponse.json({ templates: data }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[axiom-templates] GET error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to fetch templates" },
            { status: 500, headers: NO_STORE },
        );
    }
}

/**
 * Upserts (creates or updates) an Axiom order template.
 * Triggering a PO re-assessment for active POs using this SKU.
 */
export async function POST(req: NextRequest) {
    const db = createClient();
    if (!db) {
        return NextResponse.json(
            { error: "database unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }

    try {
        const body = await req.json();
        const { finale_sku, axiom_job_name, spec, auto_order_allowed, approved, approved_by } = body;

        // Validation checks
        if (!finale_sku || typeof finale_sku !== "string" || !finale_sku.trim()) {
            return NextResponse.json(
                { error: "Finale SKU is required and must be a non-empty string" },
                { status: 400, headers: NO_STORE },
            );
        }

        if (spec && typeof spec !== "object") {
            return NextResponse.json(
                { error: "Spec must be a valid JSON object" },
                { status: 400, headers: NO_STORE },
            );
        }

        const cleanSku = finale_sku.trim();
        const now = new Date().toISOString();

        const { data, error } = await db
            .from("axiom_order_templates")
            .upsert({
                finale_sku: cleanSku,
                axiom_job_name: axiom_job_name ? axiom_job_name.trim() : null,
                spec: spec ?? {},
                auto_order_allowed: !!auto_order_allowed,
                approved: !!approved,
                approved_by: approved_by ? approved_by.trim() : null,
                approved_at: approved ? now : null,
                updated_at: now,
            })
            .select();

        if (error) {
            throw error;
        }

        // Trigger active draft PO re-assessments
        if (approved) {
            console.log(`[axiom-templates] Triggering re-assessment of active lifecycles for SKU ${cleanSku}`);
            await reassessActiveLifecyclesForSKU(cleanSku);
        }

        return NextResponse.json({ template: data?.[0] }, { status: 200, headers: NO_STORE });
    } catch (err: any) {
        console.error("[axiom-templates] POST error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to save template" },
            { status: 500, headers: NO_STORE },
        );
    }
}

/**
 * Deletes an Axiom order template.
 */
export async function DELETE(req: NextRequest) {
    const db = createClient();
    if (!db) {
        return NextResponse.json(
            { error: "database unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }

    try {
        const { searchParams } = new URL(req.url);
        const sku = searchParams.get("sku");

        if (!sku) {
            return NextResponse.json(
                { error: "sku query parameter is required" },
                { status: 400, headers: NO_STORE },
            );
        }

        const { error } = await db
            .from("axiom_order_templates")
            .delete()
            .eq("finale_sku", sku);

        if (error) {
            throw error;
        }

        return NextResponse.json({ success: true }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[axiom-templates] DELETE error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to delete template" },
            { status: 500, headers: NO_STORE },
        );
    }
}
