import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
import { loadActivePurchases } from "@/lib/purchasing/active-purchases";
import { loadDraftedPORecSummaries } from "@/lib/purchasing/calibration";
import { createClient } from "@/lib/supabase";

export async function GET(req: Request) {
    try {
        const finale = new FinaleClient();
        const activePos = await loadActivePurchases(finale, 60);

        // Phase C — attach rec backreferences (recommended vs drafted qty per SKU).
        // Best-effort: a Supabase miss returns the active POs without rec links.
        const recsByPO = await loadDraftedPORecSummaries(activePos.map(p => p.orderId));
        const enriched = activePos.map(po => ({
            ...po,
            recLinks: recsByPO.get(po.orderId) ?? [],
        }));

        return NextResponse.json({
            purchases: enriched,
            cachedAt: new Date().toISOString(),
        });

    } catch (err: any) {
        console.error("Active purchases API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        if (body.action !== "mark_sent_verified") {
            return NextResponse.json({ error: "action must be mark_sent_verified" }, { status: 400 });
        }

        const orderId = String(body.orderId || "").trim();
        if (!orderId) {
            return NextResponse.json({ error: "orderId required" }, { status: 400 });
        }

        const db = createClient();
        if (!db) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        const now = new Date().toISOString();
        const evidence = {
            type: "manual",
            at: now,
            detail: "Marked sent verified from Active Purchases",
            by: "dashboard",
        };

        const { error } = await db.from("purchase_orders").upsert({
            po_number: orderId,
            po_sent_verified_at: now,
            po_sent_verified_source: "manual",
            po_sent_verified_evidence: [evidence],
            lifecycle_stage: "sent",
            updated_at: now,
        }, { onConflict: "po_number" });

        if (error) throw error;

        return NextResponse.json({
            ok: true,
            orderId,
            sentVerification: {
                verified: true,
                sentAt: now,
                source: "manual",
                evidence: [evidence],
            },
        });
    } catch (err: any) {
        console.error("Active purchases verify API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
