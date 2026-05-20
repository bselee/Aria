/**
 * @file    route.ts
 * @purpose API endpoints to manage dynamic Axiom-to-Finale SKU mappings.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    @/lib/supabase, next/server
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function unauthorized() {
    return NextResponse.json(
        { error: "dashboard authentication required" },
        {
            status: 401,
            headers: {
                ...NO_STORE,
                "WWW-Authenticate": 'Basic realm="ARIA Dashboard"',
            },
        },
    );
}

function isDashboardAuthorized(req: NextRequest): boolean {
    const expectedUser = process.env.DASHBOARD_BASIC_AUTH_USER;
    const expectedPassword = process.env.DASHBOARD_BASIC_AUTH_PASSWORD;

    if (!expectedUser || !expectedPassword) {
        return false;
    }

    const auth = req.headers.get("authorization") ?? "";
    if (!auth.toLowerCase().startsWith("basic ")) {
        return false;
    }

    const decoded = Buffer.from(auth.slice("basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) {
        return false;
    }

    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return user === expectedUser && password === expectedPassword;
}

/**
 * Fetches all Axiom-to-Finale SKU mappings ordered by Axiom Job Name.
 */
export async function GET(req: NextRequest) {
    if (!isDashboardAuthorized(req)) {
        return unauthorized();
    }

    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }

    try {
        const { data, error } = await supabase
            .from("axiom_sku_mappings")
            .select("*")
            .order("axiom_job_name", { ascending: true });

        if (error) {
            throw error;
        }

        return NextResponse.json({ mappings: data }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[axiom-sku-mappings] GET error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to fetch mappings" },
            { status: 500, headers: NO_STORE },
        );
    }
}

/**
 * Upserts (creates or updates) an Axiom-to-Finale SKU mapping.
 */
export async function POST(req: NextRequest) {
    if (!isDashboardAuthorized(req)) {
        return unauthorized();
    }

    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }

    try {
        const body = await req.json();
        const { axiom_job_name, finale_skus, qty_fraction, description } = body;

        // Validation checks
        if (!axiom_job_name || typeof axiom_job_name !== "string" || !axiom_job_name.trim()) {
            return NextResponse.json(
                { error: "Axiom Job Name is required and must be a valid non-empty string" },
                { status: 400, headers: NO_STORE },
            );
        }

        if (!Array.isArray(finale_skus) || finale_skus.length === 0 || !finale_skus.every(sku => typeof sku === "string" && sku.trim())) {
            return NextResponse.json(
                { error: "Finale SKUs must be a non-empty array of non-empty strings" },
                { status: 400, headers: NO_STORE },
            );
        }

        const parsedFraction = parseFloat(qty_fraction);
        if (isNaN(parsedFraction) || parsedFraction <= 0) {
            return NextResponse.json(
                { error: "Quantity Fraction / Multiplier must be a positive number" },
                { status: 400, headers: NO_STORE },
            );
        }

        const { data, error } = await supabase
            .from("axiom_sku_mappings")
            .upsert({
                axiom_job_name: axiom_job_name.trim(),
                finale_skus: finale_skus.map(s => s.trim()),
                qty_fraction: parsedFraction,
                description: description ? description.trim() : null,
                updated_at: new Date().toISOString(),
            })
            .select();

        if (error) {
            throw error;
        }

        return NextResponse.json({ mapping: data?.[0] }, { status: 200, headers: NO_STORE });
    } catch (err: any) {
        console.error("[axiom-sku-mappings] POST error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to save mapping" },
            { status: 500, headers: NO_STORE },
        );
    }
}

/**
 * Deletes an Axiom SKU mapping.
 */
export async function DELETE(req: NextRequest) {
    if (!isDashboardAuthorized(req)) {
        return unauthorized();
    }

    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json(
            { error: "supabase unavailable" },
            { status: 503, headers: NO_STORE },
        );
    }

    try {
        const { searchParams } = new URL(req.url);
        const axiom_job_name = searchParams.get("axiom_job_name");

        if (!axiom_job_name) {
            return NextResponse.json(
                { error: "axiom_job_name query parameter is required" },
                { status: 400, headers: NO_STORE },
            );
        }

        const { error } = await supabase
            .from("axiom_sku_mappings")
            .delete()
            .eq("axiom_job_name", axiom_job_name);

        if (error) {
            throw error;
        }

        return NextResponse.json({ success: true }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[axiom-sku-mappings] DELETE error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to delete mapping" },
            { status: 500, headers: NO_STORE },
        );
    }
}
