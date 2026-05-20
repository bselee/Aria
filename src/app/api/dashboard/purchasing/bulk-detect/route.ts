/**
 * @file    route.ts
 * @purpose On-demand bulk vendor detection endpoint.
 *          GET  — dry-run analysis (read-only, returns signal report)
 *          POST — same analysis + commits is_bulk_vendor flags to vendor_reorder_policies
 *
 *          Uses Finale completed PO history (last 12 months) to auto-classify
 *          vendors that ship in bulk multi-leg deliveries.
 *
 * @author  Aria
 * @created 2026-05-21
 * @updated 2026-05-21
 * @deps    bulk-detector, finale/client (for auth credentials)
 */

import { NextRequest, NextResponse } from "next/server";
import { detectBulkVendors } from "@/lib/purchasing/bulk-detector";

function getFinaleCredentials(): { authHeader: string; apiBase: string; accountPath: string } | null {
    const user        = process.env.FINALE_USERNAME;
    const pass        = process.env.FINALE_PASSWORD;
    const accountPath = process.env.FINALE_ACCOUNT_PATH;
    const apiBase     = process.env.FINALE_API_BASE ?? "https://app.finaleinventory.com";

    if (!user || !pass || !accountPath) return null;
    const authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    return { authHeader, apiBase, accountPath };
}

/** GET /api/dashboard/purchasing/bulk-detect — dry-run report */
export async function GET(_req: NextRequest) {
    const creds = getFinaleCredentials();
    if (!creds) {
        return NextResponse.json({ error: "Finale credentials not configured" }, { status: 503 });
    }
    try {
        const result = await detectBulkVendors(
            creds.authHeader,
            creds.apiBase,
            creds.accountPath,
            undefined, // velocity map not available here — gap + dollar signals only
            false,     // dry-run
        );
        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message ?? "Detection failed" }, { status: 500 });
    }
}

/** POST /api/dashboard/purchasing/bulk-detect — detect + commit flags */
export async function POST(_req: NextRequest) {
    const creds = getFinaleCredentials();
    if (!creds) {
        return NextResponse.json({ error: "Finale credentials not configured" }, { status: 503 });
    }
    try {
        const result = await detectBulkVendors(
            creds.authHeader,
            creds.apiBase,
            creds.accountPath,
            undefined,
            true, // commit to vendor_reorder_policies
        );
        return NextResponse.json(result);
    } catch (err: any) {
        return NextResponse.json({ error: err.message ?? "Detection + commit failed" }, { status: 500 });
    }
}
