/**
 * @file    src/app/api/dashboard/basauto-recon/route.ts
 * @purpose Serves the basauto ↔ Aria reconciliation report to the dashboard.
 *          Reads the JSON written by src/cli/basauto-recon.ts (Hermes cron,
 *          07:00 MT daily). Read-only — never triggers a crawl.
 *
 * @author  Hermia
 * @created 2026-08-21
 * @deps    none (reads data/basauto-recon.json)
 * @env     none
 */

import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/** A report older than this is flagged stale in the panel (cron runs daily at 07:00 MT). */
const STALE_AFTER_MS = 30 * 60 * 60 * 1000;

function getReportPath(): string {
    return join(process.cwd(), "data", "basauto-recon.json");
}

export const dynamic = "force-dynamic";

export async function GET() {
    const path = getReportPath();

    if (!existsSync(path)) {
        return NextResponse.json({
            report: null,
            stale: true,
            message: "No reconciliation report yet — the 07:00 cron writes the first one.",
        });
    }

    try {
        const report = JSON.parse(readFileSync(path, "utf-8"));
        const ageMs = Date.now() - new Date(report.crawledAt ?? 0).getTime();
        return NextResponse.json({
            report,
            stale: !Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS,
        });
    } catch (err: any) {
        return NextResponse.json({ error: err?.message ?? "unreadable report" }, { status: 500 });
    }
}
