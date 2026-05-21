/**
 * @file    route.ts
 * @purpose API endpoint to resolve matched DASH artwork assets for a given SKU.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    @/lib/dash/resolver, next/server
 * @env     DASHBOARD_BASIC_AUTH_USER, DASHBOARD_BASIC_AUTH_PASSWORD
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveDashAssets } from "@/lib/dash/resolver";

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
 * Resolves matched DASH artwork assets for a given SKU query parameter.
 */
export async function GET(req: NextRequest) {
    if (!isDashboardAuthorized(req)) {
        return unauthorized();
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

        const assets = resolveDashAssets(sku);

        return NextResponse.json({ assets }, { headers: NO_STORE });
    } catch (err: any) {
        console.error("[dash-assets] GET error:", err);
        return NextResponse.json(
            { error: err?.message ?? "Failed to fetch DASH assets" },
            { status: 500, headers: NO_STORE },
        );
    }
}
