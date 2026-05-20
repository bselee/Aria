/**
 * @file    route.ts
 * @purpose REST API for creating and querying PO shipment legs.
 *          POST: upsert one or more legs for a PO (from Telegram /legs command or dashboard)
 *          GET:  fetch all legs for all active POs (lightweight — returns full leg map)
 * @author  Aria
 * @created 2026-05-21
 * @updated 2026-05-21
 * @deps    calibration (upsertShipmentLegs, loadShipmentLegs)
 *          shipment-leg-parser (parseLegsCommand)
 */

import { NextRequest, NextResponse } from "next/server";
import { upsertShipmentLegs, loadShipmentLegs } from "@/lib/purchasing/calibration";
import { parseLegsCommand, isLegsParseError } from "@/lib/purchasing/shipment-leg-parser";

// ── POST /api/dashboard/po-shipment-legs ─────────────────────────────────────
// Accept two call patterns:
//   1. Parsed legs:  { poNumber, vendorPartyId?, vendorName?, legs: [{legNumber, expectedQty, expectedDate}] }
//   2. Raw command:  { raw: "/legs PO-1234 1:30000@2026-06-10 ..." }

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // Pattern 2: raw Telegram command
        if (typeof body.raw === "string") {
            const parsed = parseLegsCommand(body.raw);
            if (isLegsParseError(parsed)) {
                return NextResponse.json({ error: parsed.error }, { status: 400 });
            }
            const count = await upsertShipmentLegs(
                parsed.poNumber,
                body.vendorPartyId ?? null,
                body.vendorName ?? null,
                parsed.legs,
            );
            return NextResponse.json({
                ok: true,
                poNumber: parsed.poNumber,
                legsUpserted: count,
                warnings: parsed.warnings,
            });
        }

        // Pattern 1: structured legs
        const { poNumber, vendorPartyId, vendorName, legs } = body;
        if (!poNumber || !Array.isArray(legs) || legs.length === 0) {
            return NextResponse.json({ error: "poNumber and legs[] are required" }, { status: 400 });
        }

        const count = await upsertShipmentLegs(
            poNumber,
            vendorPartyId ?? null,
            vendorName ?? null,
            legs,
        );
        return NextResponse.json({ ok: true, poNumber, legsUpserted: count });
    } catch (err: any) {
        return NextResponse.json({ error: err.message ?? "Internal server error" }, { status: 500 });
    }
}

// ── GET /api/dashboard/po-shipment-legs?po=PO-1234,PO-5678 ───────────────────
// Returns leg data for the given comma-separated PO numbers.

export async function GET(req: NextRequest) {
    try {
        const poParam = req.nextUrl.searchParams.get("po") ?? "";
        const poNumbers = poParam
            .split(",")
            .map(p => p.trim())
            .filter(Boolean);

        if (poNumbers.length === 0) {
            return NextResponse.json({ error: "Provide ?po=PO-1234,PO-5678" }, { status: 400 });
        }

        const legsMap = await loadShipmentLegs(poNumbers);
        const result: Record<string, any[]> = {};
        for (const [po, legs] of legsMap) {
            result[po] = legs;
        }
        return NextResponse.json({ legs: result, poCount: poNumbers.length, legCount: [...legsMap.values()].flat().length });
    } catch (err: any) {
        return NextResponse.json({ error: err.message ?? "Internal server error" }, { status: 500 });
    }
}
