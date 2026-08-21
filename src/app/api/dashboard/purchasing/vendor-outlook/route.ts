/**
 * @file    route.ts
 * @purpose Save vendor Hold / Lead / Truck from Ordering.
 * @author  Hermia
 * @created 2026-08-14
 */
import { NextRequest, NextResponse } from "next/server";
import { upsertVendorReorderPolicy } from "../../../../../lib/purchasing/calibration";
import { decodeOutlookNotes, encodeOutlookNotes } from "../../../../../lib/purchasing/vendor-outlook";

function numOrNull(v: unknown): number | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const vendorPartyId = String(body.vendorPartyId || "").trim();
        if (!vendorPartyId) {
            return NextResponse.json({ error: "vendorPartyId required" }, { status: 400 });
        }

        const decoded = decodeOutlookNotes(typeof body.notes === "string" ? body.notes : "");
        const holdUntilDate = body.holdUntilDate !== undefined
            ? (body.holdUntilDate ? String(body.holdUntilDate).slice(0, 10) : null)
            : decoded.holdUntilDate;
        const notes = encodeOutlookNotes(holdUntilDate, decoded.notes);

        const policy = await upsertVendorReorderPolicy({
            vendorPartyId,
            vendorName: body.vendorName ?? null,
            notes,
            leadTimeOverrideDays: numOrNull(body.leadTimeOverrideDays) ?? null,
            standardOrderQty: numOrNull(body.truckQty) ?? null,
        });
        if (!policy) {
            return NextResponse.json({ error: "Could not save vendor outlook" }, { status: 502 });
        }
        const hold = decodeOutlookNotes(policy.notes);
        return NextResponse.json({
            ok: true,
            holdUntilDate: hold.holdUntilDate,
            policy,
        });
    } catch (err: any) {
        return NextResponse.json({ error: err?.message || "outlook save failed" }, { status: 500 });
    }
}
