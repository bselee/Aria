/**
 * @file    OpsModuleDock.tsx
 * @purpose Bottom dock of the command board. Tabs that compose the existing
 *          dashboard panels (Receivings, AP/Invoices, Purchasing, Active
 *          Purchases, Build Risk, Build Schedule, Tracking, Statement Recon).
 *
 *          NEVER edit panel internals — this file is composition only. The
 *          underlying panels each fetch from their own existing API routes.
 */
"use client";

import React, { useEffect, useState } from "react";

import { PANEL_BY_ID, PANEL_DEFINITIONS } from "./panelRegistry";
import type { PanelId } from "./useDashboardLayout";

const DOCK_STORAGE_KEY = "aria-dash-ops-dock-tab";

// Order chosen to match the spec's "Receivings, AP/Invoices, Ordering /
// Purchasing, Active Purchases, Build Risk, Build Schedule, Tracking,
// Statement Recon".
const DOCK_TAB_IDS: PanelId[] = [
    "receivings",
    "invoice-queue",
    "purchasing",
    "active-purchases",
    "build-risk",
    "build-schedule",
    "tracking-board",
    "statement-reconciliation",
    "purchasing-calendar",
    "oversight",
    "activity",
];

const DOCK_TABS = DOCK_TAB_IDS.map(id => PANEL_BY_ID[id]).filter(
    (def): def is (typeof PANEL_DEFINITIONS)[number] => Boolean(def),
);

export function OpsModuleDock() {
    const [activeTab, setActiveTab] = useState<PanelId>(DOCK_TABS[0].id);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const saved = window.localStorage.getItem(DOCK_STORAGE_KEY);
            if (saved && DOCK_TABS.some(t => t.id === saved)) {
                setActiveTab(saved as PanelId);
            }
        } catch {
            /* ignore */
        }
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            window.localStorage.setItem(DOCK_STORAGE_KEY, activeTab);
        } catch {
            /* ignore */
        }
    }, [activeTab]);

    const active = PANEL_BY_ID[activeTab] ?? DOCK_TABS[0];

    return (
        <div className="flex flex-col h-full bg-zinc-950/40 border border-zinc-800/60 rounded-md overflow-hidden">
            <div
                role="tablist"
                aria-label="Operations modules"
                className="flex flex-wrap gap-1 px-2 py-1.5 border-b border-zinc-800/60 bg-zinc-900/60"
            >
                {DOCK_TABS.map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        aria-label={`Open ${tab.label}`}
                        onClick={() => setActiveTab(tab.id)}
                        data-testid={`ops-dock-tab-${tab.id}`}
                        className={`px-2 py-1 rounded text-[11px] font-mono uppercase tracking-wider border transition-colors ${
                            activeTab === tab.id
                                ? "bg-zinc-800 text-zinc-100 border-zinc-700"
                                : "bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300 hover:border-zinc-700"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="flex-1 overflow-auto">
                <div className="h-full flex flex-col">{active.render()}</div>
            </div>
        </div>
    );
}

export default OpsModuleDock;
