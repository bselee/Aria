import { NextResponse } from "next/server";
import { FinaleClient } from "@/lib/finale/client";
import { leadTimeService } from "@/lib/builds/lead-time-service";

// Helps compute expected date same way as ops-manager
function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split("T")[0];
}

export async function GET(req: Request) {
    try {
        const finale = new FinaleClient();

        // Fetch last 60 days of POs to ensure we get active ones
        const pos = await finale.getRecentPurchaseOrders(60);
        await leadTimeService.warmCache();

        const now = new Date();
        now.setHours(0, 0, 0, 0);

        // Fetch tracking from Supabase
        const { createClient } = await import("@/lib/supabase");
        const supabase = createClient();
        const poNumbers = pos.map(p => p.orderId).filter(Boolean);
        const trackingMap = new Map<string, string[]>();

        if (supabase && poNumbers.length > 0) {
            try {
                for (let i = 0; i < poNumbers.length; i += 100) {
                    const chunk = poNumbers.slice(i, i + 100);
                    const { data: dbPOs } = await supabase
                        .from("purchase_orders")
                        .select("po_number, tracking_numbers")
                        .in("po_number", chunk);

                    for (const dp of dbPOs || []) {
                        trackingMap.set(dp.po_number, dp.tracking_numbers || []);
                    }
                }
            } catch (e: any) {
                console.warn("[api] tracking fetch failed:", e.message);
            }
        }

        const activePos = [];

        for (const po of pos) {
            if (!po.orderId) continue;
            // Skip dropship POs
            if (po.orderId.toLowerCase().includes("dropship")) continue;

            const status = (po.status || "").toLowerCase();
            // Only show committed or completed — skip drafts and cancelled
            if (!["committed", "completed"].includes(status)) continue;

            const isReceived = status === "completed";

            // If received, auto-remove after 5 days
            if (isReceived && po.receiveDate) {
                const recDate = new Date(po.receiveDate);
                recDate.setHours(0, 0, 0, 0);
                const diffTime = Math.abs(now.getTime() - recDate.getTime());
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays > 5) {
                    continue; // skip received > 5 days ago
                }
            }

            // Calculate expected date like the calendar
            let expectedDate: string;
            let leadProvenance: string;

            if (po.orderDate) {
                const lt = await leadTimeService.getForVendor(po.vendorName);
                expectedDate = addDays(po.orderDate, lt.days);
                leadProvenance = lt.label;
            } else {
                expectedDate = new Date().toISOString().split("T")[0];
                leadProvenance = "14d default";
            }

            activePos.push({
                ...po,
                expectedDate,
                leadProvenance,
                isReceived,
                trackingNumbers: trackingMap.get(po.orderId) || []
            });
        }

        // Sort by order date descending
        activePos.sort((a, b) => {
            const da = new Date(a.orderDate || 0).getTime();
            const db = new Date(b.orderDate || 0).getTime();
            return db - da; // newest first
        });

        return NextResponse.json({
            purchases: activePos,
            cachedAt: new Date().toISOString(),
        });

    } catch (err: any) {
        console.error("Active purchases API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
