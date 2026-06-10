/**
 * @file    src/app/api/dashboard/basauto-requests/route.ts
 * @purpose Serves BASAUTO purchase request data to the dashboard.
 *          Reads from the local cache written by scripts/basauto_poll.py.
 *          Lightweight endpoint — just reads JSON from disk.
 *
 * @author  Hermia
 * @created 2026-06-09
 * @deps    none (reads local cache file)
 * @env     none
 */

import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Cache file path (same as scripts/basauto_poll.py writes to). */
function getSnapshotPath(): string {
    return join(
        homedir(),
        "AppData",
        "Local",
        "hermes",
        "cache",
        "basauto",
        "latest-snapshot.json",
    );
}

export const dynamic = "force-dynamic";

export async function GET() {
    const snapPath = getSnapshotPath();

    if (!existsSync(snapPath)) {
        return NextResponse.json({
            requests: [],
            cachedAt: null,
            tokenExpiry: null,
            total: 0,
            pending: 0,
            ordered: 0,
        });
    }

    try {
        const raw = readFileSync(snapPath, "utf-8");
        const data = JSON.parse(raw);

        const requests = data.requests || [];
        const pending = requests.filter(
            (r: any) =>
                r.status === "Pending" ||
                r.status === "pending" ||
                r.status === "NEW",
        );
        const ordered = requests.filter(
            (r: any) =>
                r.status === "Ordered" ||
                r.status === "ordered" ||
                r.status === "APPROVED",
        );

        return NextResponse.json({
            requests,
            cachedAt: data.cachedAt || data.timestamp || null,
            tokenExpiry: data.tokenExpiry || null,
            total: requests.length,
            pending: pending.length,
            ordered: ordered.length,
        });
    } catch (err: any) {
        return NextResponse.json(
            { error: err.message },
            { status: 500 },
        );
    }
}
