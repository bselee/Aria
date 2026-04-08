import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
import { OpsManager } from "@/lib/intelligence/ops-manager";
import { loadActivePurchases } from "@/lib/purchasing/active-purchases";

export async function GET(req: Request) {
    try {
        const finale = new FinaleClient();
        const activePos = await loadActivePurchases(finale, 60);

        return NextResponse.json({
            purchases: activePos,
            cachedAt: new Date().toISOString(),
        });

    } catch (err: any) {
        console.error("Active purchases API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json().catch(() => ({}));
        if (body?.action !== "resync_calendar") {
            return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
        }

        const daysBack = Math.max(1, Math.min(180, Number(body?.daysBack) || 60));
        const ops = new OpsManager(null as any);
        const result = await ops.syncPurchasingCalendar(daysBack);

        return NextResponse.json({
            ok: true,
            daysBack,
            result,
        });
    } catch (err: any) {
        console.error("Active purchases POST error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
