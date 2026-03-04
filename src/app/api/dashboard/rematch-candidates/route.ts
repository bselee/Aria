/**
 * @file    rematch-candidates/route.ts
 * @purpose Fetches candidate POs for the re-match flow on the dashboard.
 *          Searches Supabase purchase_orders by vendor name similarity.
 *          Falls back to Finale PO query if Supabase has no data.
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    supabase, finale/client
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const vendor = searchParams.get("vendor");

        if (!vendor) {
            return NextResponse.json({ error: "vendor parameter required" }, { status: 400 });
        }

        const supabase = createClient();
        if (!supabase) {
            return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
        }

        // Search purchase_orders by vendor name (case-insensitive partial match)
        const { data: pos, error } = await supabase
            .from("purchase_orders")
            .select("po_number, vendor_name, issue_date, total_amount, status")
            .ilike("vendor_name", `%${vendor}%`)
            .order("issue_date", { ascending: false })
            .limit(10);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Build Finale URLs for each PO
        const accountPath = process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics";

        const candidates = (pos || []).map((po: any) => {
            const orderApiPath = `/${accountPath}/api/order/${po.po_number}`;
            const encoded = Buffer.from(orderApiPath).toString("base64");
            return {
                orderId: po.po_number,
                vendor: po.vendor_name,
                orderDate: po.issue_date,
                total: po.total_amount,
                status: po.status,
                finaleUrl: `https://app.finaleinventory.com/${accountPath}/sc2/?order/purchase/order/${encoded}`,
            };
        });

        return NextResponse.json({ candidates });
    } catch (err: any) {
        console.error("Rematch candidates error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
