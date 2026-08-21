/**
 * @file    VendorOutlookBar.tsx
 * @purpose Lean Hold / Lead / Truck controls. No essay. No note box.
 * @author  Hermia
 * @created 2026-08-14
 */
"use client";

import React, { useEffect, useState } from "react";
import type { VendorOutlookFields } from "@/lib/purchasing/vendor-outlook";

export interface VendorOutlookBarProps {
    vendorPartyId: string;
    vendorName: string;
    initial: VendorOutlookFields;
    onSaved: (next: VendorOutlookFields) => void;
}

export function VendorOutlookBar({
    vendorPartyId,
    vendorName,
    initial,
    onSaved,
}: VendorOutlookBarProps) {
    const [hold, setHold] = useState(initial.holdUntilDate ?? "");
    const [lead, setLead] = useState(initial.leadTimeOverrideDays != null ? String(initial.leadTimeOverrideDays) : "");
    const [truck, setTruck] = useState(initial.truckQty != null ? String(initial.truckQty) : "");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setHold(initial.holdUntilDate ?? "");
        setLead(initial.leadTimeOverrideDays != null ? String(initial.leadTimeOverrideDays) : "");
        setTruck(initial.truckQty != null ? String(initial.truckQty) : "");
    }, [initial.holdUntilDate, initial.leadTimeOverrideDays, initial.truckQty]);

    async function save(nextHold: string, nextLead: string, nextTruck: string) {
        setSaving(true);
        const payload: VendorOutlookFields = {
            notes: initial.notes,
            holdUntilDate: nextHold || null,
            leadTimeOverrideDays: nextLead ? Number(nextLead) : null,
            targetCoverDays: initial.targetCoverDays,
            truckQty: nextTruck ? Number(nextTruck) : null,
        };
        try {
            const res = await fetch("/api/dashboard/purchasing/vendor-outlook", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    vendorPartyId,
                    vendorName,
                    notes: payload.notes,
                    holdUntilDate: payload.holdUntilDate,
                    leadTimeOverrideDays: payload.leadTimeOverrideDays,
                    truckQty: payload.truckQty,
                }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) return;
            onSaved({
                notes: json.policy?.notes ?? payload.notes,
                holdUntilDate: json.holdUntilDate ?? payload.holdUntilDate,
                leadTimeOverrideDays: json.policy?.leadTimeOverrideDays ?? payload.leadTimeOverrideDays,
                targetCoverDays: json.policy?.targetCoverDays ?? payload.targetCoverDays,
                truckQty: json.policy?.standardOrderQty ?? payload.truckQty,
            });
        } finally {
            setSaving(false);
        }
    }

    const field = "ml-1 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[10px] font-mono text-zinc-300 w-[6.5rem]";

    return (
        <div className="px-4 pb-1 flex items-center gap-3 text-[10px] font-mono text-zinc-500">
            <label>
                hold
                <input
                    type="date"
                    value={hold}
                    onChange={e => setHold(e.target.value)}
                    onBlur={() => save(hold, lead, truck)}
                    className={field}
                />
            </label>
            <label>
                lead
                <input
                    value={lead}
                    onChange={e => setLead(e.target.value.replace(/[^\d]/g, ""))}
                    onBlur={() => save(hold, lead, truck)}
                    placeholder="d"
                    className="ml-1 w-10 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[10px] font-mono text-zinc-300"
                />
            </label>
            <label>
                truck
                <input
                    value={truck}
                    onChange={e => setTruck(e.target.value.replace(/[^\d]/g, ""))}
                    onBlur={() => save(hold, lead, truck)}
                    placeholder="qty"
                    className="ml-1 w-14 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[10px] font-mono text-zinc-300"
                />
            </label>
            {saving && <span className="text-zinc-600">…</span>}
        </div>
    );
}
