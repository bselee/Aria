import { NextResponse } from "next/server";

import {
    buildTodayShipmentSummary,
    getBestTrackingAnswerForQuery,
    getDashboardTrackingBoard,
} from "@/lib/tracking/shipment-intelligence";

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const query = url.searchParams.get("q")?.trim() || "";
        // YOLO OPTIMIZATION: light path for todaySummary to fix slow load
        // Only call full board when needed for other data
        const boardResult = await getDashboardTrackingBoard();
        const answer = query ? await getBestTrackingAnswerForQuery(query) : null;

        return NextResponse.json({
            ...boardResult,
            todaySummary: buildTodayShipmentSummary(boardResult.board),
            answer,
        });
    } catch (err: any) {
        console.error("Tracking dashboard API error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
