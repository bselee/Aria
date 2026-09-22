/**
 * @file    CommandBoardShell.tsx
 * @purpose Dashboard home: Ordering → Active POs → Receivings. No header chrome.
 * @author  Hermia
 * @created 2026-02-20
 * @updated 2026-09-16
 * @deps    purchasing lifecycle panels
 * @env     none
 */
"use client";

import React from "react";

import ActivePurchasesPanel from "@/components/dashboard/ActivePurchasesPanel";
import PurchasingPanel from "@/components/dashboard/PurchasingPanel";
import ReceivedItemsPanel from "@/components/dashboard/ReceivedItemsPanel";
import { PurchasingLifecycleProvider } from "./PurchasingLifecycleContext";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

type CommandBoardShellProps = {
    pollIntervalMs?: number;
    fetchImpl?: typeof fetch;
};

function PurchasingLifecyclePanel() {
    // Flow left → right: Order → Active POs → Receivings.
    // Always three columns (horizontal scroll on narrow screens). Each pane
    // scrolls internally — never stack the whole workflow top-to-bottom.
    return (
        <PurchasingLifecycleProvider>
            <div className="flex flex-col h-full min-h-0 overflow-hidden">
                <div
                    className="flex-1 min-h-0 grid grid-cols-[minmax(480px,1.35fr)_minmax(420px,1fr)_minmax(380px,0.95fr)] gap-2 p-2 overflow-x-auto overflow-y-hidden"
                    data-testid="purchasing-lifecycle-panel"
                >
                    <section
                        className="min-w-0 min-h-0 h-full overflow-hidden border border-zinc-800/70 bg-zinc-950/50 flex flex-col"
                        data-testid="lifecycle-pane-ordering"
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                            <PanelErrorBoundary label="PurchasingPanel">
                                <PurchasingPanel embedded />
                            </PanelErrorBoundary>
                        </div>
                    </section>
                    <section
                        className="min-w-0 min-h-0 h-full overflow-hidden border border-zinc-800/70 bg-zinc-950/50 flex flex-col"
                        data-testid="lifecycle-pane-purchases"
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                            <PanelErrorBoundary label="ActivePurchasesPanel">
                                <ActivePurchasesPanel embedded />
                            </PanelErrorBoundary>
                        </div>
                    </section>
                    <section
                        className="min-w-0 min-h-0 h-full overflow-hidden border border-zinc-800/70 bg-zinc-950/50 flex flex-col"
                        data-testid="lifecycle-pane-rcv"
                    >
                        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                            <PanelErrorBoundary label="ReceivedItemsPanel">
                                <ReceivedItemsPanel embedded />
                            </PanelErrorBoundary>
                        </div>
                    </section>
                </div>
            </div>
        </PurchasingLifecycleProvider>
    );
}

export function CommandBoardShell(_props: CommandBoardShellProps = {}) {
    return (
        <div className="flex flex-col h-screen bg-[#09090b] text-zinc-100" data-testid="command-board-shell">
            <PurchasingLifecyclePanel />
        </div>
    );
}

export default CommandBoardShell;
