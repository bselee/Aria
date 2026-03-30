import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
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
