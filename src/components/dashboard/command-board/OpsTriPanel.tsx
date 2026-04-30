/**
 * @file    OpsTriPanel.tsx
 * @purpose Single-screen operational view: Ordering → Purchases → Receivings.
 *          Three rows, each loading + scrolling independently. Collapsing a
 *          row gives the others more vertical real estate.
 *
 *          The panels each own their own data-fetch + cache, so a slow
 *          Ordering load NEVER blocks Purchases or Receivings from rendering.
 */
"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import PurchasingPanel from "@/components/dashboard/PurchasingPanel";
import ActivePurchasesPanel from "@/components/dashboard/ActivePurchasesPanel";
import ReceivedItemsPanel from "@/components/dashboard/ReceivedItemsPanel";

type RowId = "ordering" | "purchases" | "receivings";

const STORAGE_KEY = "aria-dash-ops-tri-collapsed";

type RowDef = {
    id: RowId;
    label: string;
    sub: string;
    render: () => React.ReactNode;
};

const ROWS: RowDef[] = [
    {
        id: "ordering",
        label: "Ordering",
        sub: "what to buy next — purchasing intelligence by vendor",
        render: () => <PurchasingPanel />,
    },
    {
        id: "purchases",
        label: "Active Purchases",
        sub: "POs in flight — placed but not yet received",
        render: () => <ActivePurchasesPanel />,
    },
    {
        id: "receivings",
        label: "Receivings",
        sub: "what arrived this week",
        render: () => <ReceivedItemsPanel />,
    },
];

function loadCollapsed(): Set<RowId> {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const ids = JSON.parse(raw) as RowId[];
        return new Set(ids);
    } catch {
        return new Set();
    }
}

function saveCollapsed(set: Set<RowId>) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch { /* ignore */ }
}

export default function OpsTriPanel() {
    const [collapsed, setCollapsed] = useState<Set<RowId>>(new Set());
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        setCollapsed(loadCollapsed());
        setHydrated(true);
    }, []);

    const toggle = (id: RowId) => {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            saveCollapsed(next);
            return next;
        });
    };

    const expandedCount = ROWS.length - collapsed.size;

    return (
        <div
            className="flex flex-col gap-3 px-4 py-3 max-w-[1600px] mx-auto w-full"
            data-testid="ops-tri-panel"
        >
            {ROWS.map(row => {
                const isCollapsed = hydrated && collapsed.has(row.id);
                // When N rows are expanded, each gets ~ (100/N)% of available height,
                // with a 280px floor so a single panel never crushes its content.
                const flexBasis = isCollapsed
                    ? "auto"
                    : `${Math.max(280, Math.floor(800 / Math.max(1, expandedCount)))}px`;

                return (
                    <section
                        key={row.id}
                        data-testid={`ops-row-${row.id}`}
                        className="flex flex-col rounded-md border border-zinc-800 bg-zinc-950/40 overflow-hidden"
                        style={{
                            flex: isCollapsed ? "0 0 auto" : `1 1 ${flexBasis}`,
                            minHeight: isCollapsed ? undefined : 280,
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => toggle(row.id)}
                            aria-expanded={!isCollapsed}
                            aria-controls={`ops-row-body-${row.id}`}
                            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/70 hover:bg-zinc-900 border-b border-zinc-800/80 text-left"
                        >
                            {isCollapsed
                                ? <ChevronRight className="w-3.5 h-3.5 text-zinc-500" />
                                : <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />}
                            <span className="text-xs font-mono font-semibold uppercase tracking-widest text-zinc-200">
                                {row.label}
                            </span>
                            <span className="text-[10px] font-mono text-zinc-500 truncate">
                                {row.sub}
                            </span>
                        </button>
                        {!isCollapsed && (
                            <div
                                id={`ops-row-body-${row.id}`}
                                className="flex-1 overflow-auto"
                            >
                                {row.render()}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
