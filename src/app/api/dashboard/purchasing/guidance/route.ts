import { NextResponse } from "next/server";
import { getPurchasesGuidanceState } from "@/lib/storage/purchases-guidance-state";
import { refreshPurchasesGuidanceSnapshot } from "@/lib/purchasing/purchases-guidance-refresh";

export async function GET() {
  const state = await getPurchasesGuidanceState();
  return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const result = await refreshPurchasesGuidanceSnapshot();
  return NextResponse.json(result, {
    status: result.status === "success" ? 200 : 500,
    headers: { "Cache-Control": "no-store" },
  });
}
