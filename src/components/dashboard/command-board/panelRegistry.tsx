/**
 * @file    panelRegistry.tsx
 * @purpose Single source of truth for command-board panel ids → React nodes.
 *          The Ops module dock renders panels by composing these — it never
 *          edits panel internals.
 *
 *          Panel ids must remain stable; see `useDashboardLayout.ts` for the
 *          canonical list.
 */
"use client";

import React from "react";

import ActivityFeed from "@/components/dashboard/ActivityFeed";
import RecentRunsPanel from "./RecentRunsPanel";
import ActivePurchasesPanel from "@/components/dashboard/ActivePurchasesPanel";
import BuildRiskPanel from "@/components/dashboard/BuildRiskPanel";
import BuildSchedulePanel from "@/components/dashboard/BuildSchedulePanel";
import InvoiceQueuePanel from "@/components/dashboard/InvoiceQueuePanel";
import OversightPanel from "@/components/dashboard/OversightPanel";
import PurchasingCalendarPanel from "@/components/dashboard/PurchasingCalendarPanel";
import PurchasingPanel from "@/components/dashboard/PurchasingPanel";
import ReceivedItemsPanel from "@/components/dashboard/ReceivedItemsPanel";
import StatementReconciliationPanel from "@/components/dashboard/StatementReconciliationPanel";
import TrackingBoardPanel from "@/components/dashboard/TrackingBoardPanel";

import type { PanelId } from "./useDashboardLayout";

export type PanelDefinition = {
    id: PanelId;
    label: string;
    short: string;
    render: () => React.ReactNode;
};

export const PANEL_DEFINITIONS: PanelDefinition[] = [
    {
        id: "build-risk",
        label: "Build Risk",
        short: "Build Risk",
        render: () => <BuildRiskPanel />,
    },
    {
        id: "receivings",
        label: "Receivings",
        short: "Receivings",
        render: () => <ReceivedItemsPanel />,
    },
    {
        id: "activity",
        label: "Activity Feed",
        short: "Activity",
        render: () => (
            <div className="flex flex-col flex-1 overflow-hidden min-h-[300px]">
                <ActivityFeed />
            </div>
        ),
    },
    {
        id: "invoice-queue",
        label: "AP / Invoices",
        short: "AP/Invoices",
        render: () => <InvoiceQueuePanel />,
    },
    {
        id: "statement-reconciliation",
        label: "Statement Recon",
        short: "Statement Recon",
        render: () => <StatementReconciliationPanel />,
    },
    {
        id: "purchasing",
        label: "Ordering / Purchasing",
        short: "Purchasing",
        render: () => <PurchasingPanel />,
    },
    {
        id: "build-schedule",
        label: "Build Schedule",
        short: "Build Schedule",
        render: () => <BuildSchedulePanel />,
    },
    {
        id: "active-purchases",
        label: "Active Purchases",
        short: "Active Purchases",
        render: () => <ActivePurchasesPanel />,
    },
    {
        id: "tracking-board",
        label: "Tracking",
        short: "Tracking",
        render: () => <TrackingBoardPanel />,
    },
    {
        id: "purchasing-calendar",
        label: "Purchasing Calendar",
        short: "Purch. Calendar",
        render: () => <PurchasingCalendarPanel />,
    },
    {
        id: "oversight",
        label: "Oversight",
        short: "Oversight",
        render: () => <OversightPanel />,
    },
    {
        id: "recent-runs",
        label: "Recent Runs",
        short: "Recent Runs",
        render: () => <RecentRunsPanel />,
    },
];

export const PANEL_BY_ID: Record<PanelId, PanelDefinition> =
    PANEL_DEFINITIONS.reduce<Record<string, PanelDefinition>>((acc, def) => {
        acc[def.id] = def;
        return acc;
    }, {}) as Record<PanelId, PanelDefinition>;

/** Panels that should fill remaining vertical space in their column. */
export const FLEX_PANEL_IDS: ReadonlySet<string> = new Set(["activity"]);

/** JSX-rendered map for legacy fallback consumers. */
export const PANEL_NODE_MAP: Record<string, React.ReactNode> =
    PANEL_DEFINITIONS.reduce<Record<string, React.ReactNode>>((acc, def) => {
        acc[def.id] = def.render();
        return acc;
    }, {});
