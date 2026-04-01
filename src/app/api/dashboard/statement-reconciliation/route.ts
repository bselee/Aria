import { NextResponse } from "next/server";

import {
    launchFedexDownloadRun,
    launchStatementRun,
    listStatementDashboardData,
} from "@/lib/statements/service";

type LaunchRequest =
    | { action: "run_existing_intake"; intakeId: string }
    | { action: "run_fedex_download" };

export async function GET() {
    try {
        const data = await listStatementDashboardData();
        return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json() as LaunchRequest;

        if (body.action === "run_existing_intake") {
            const result = await launchStatementRun(body.intakeId, "dashboard");
            return NextResponse.json(result);
        }

        if (body.action === "run_fedex_download") {
            const result = await launchFedexDownloadRun("dashboard");
            return NextResponse.json(result);
        }

        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
