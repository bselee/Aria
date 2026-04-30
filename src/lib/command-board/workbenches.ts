import type { WorkbenchId } from "./types";

export type WorkbenchDefinition = {
    id: WorkbenchId;
    label: string;
    shortLabel: string;
    description: string;
};

export type IssueSourceLike = {
    source_table: string | null;
    source_id: string | null;
};

export const WORKBENCHES: WorkbenchDefinition[] = [
    {
        id: "issues",
        label: "Issues",
        shortLabel: "Issues",
        description: "Agentic issue command center",
    },
    {
        id: "ordering",
        label: "Ordering / Purchasing",
        shortLabel: "Ordering",
        description: "Draft POs, suggested orders, vendor send queue, and purchasing follow-up",
    },
    {
        id: "receivings",
        label: "Receivings",
        shortLabel: "Receivings",
        description: "Expected receipts, received items, and receiving variances",
    },
    {
        id: "ap",
        label: "AP / Invoices",
        shortLabel: "AP",
        description: "Invoice inbox, matches, approvals, and AP exceptions",
    },
    {
        id: "tracking",
        label: "Tracking",
        shortLabel: "Tracking",
        description: "Shipments, carrier events, and delivery follow-up",
    },
    {
        id: "active-pos",
        label: "Active POs",
        shortLabel: "Active POs",
        description: "Open purchase orders and lifecycle status",
    },
    {
        id: "builds",
        label: "Builds",
        shortLabel: "Builds",
        description: "Build risk and build schedule operations",
    },
    {
        id: "statement-recon",
        label: "Statement Recon",
        shortLabel: "Statements",
        description: "Vendor statement reconciliation",
    },
    {
        id: "agents",
        label: "Agents",
        shortLabel: "Agents",
        description: "Agent health, skills, tools, workflows, and capabilities",
    },
    {
        id: "runs",
        label: "Runs",
        shortLabel: "Runs",
        description: "Task history, cron runs, and automation audit trail",
    },
];

const WORKBENCH_BY_ID = new Map<WorkbenchId, WorkbenchDefinition>(
    WORKBENCHES.map(workbench => [workbench.id, workbench]),
);

const SOURCE_PATTERNS: Array<{ id: WorkbenchId; patterns: RegExp[] }> = [
    {
        id: "ap",
        patterns: [
            /^ap_/i,
            /invoice/i,
            /bill/i,
            /statement_reconciliation/i,
        ],
    },
    {
        id: "ordering",
        patterns: [
            /purchase_order/i,
            /purchase_orders/i,
            /purchase_request/i,
            /purchase_requests/i,
            /purchasing/i,
            /draft_po/i,
            /\bpo\b/i,
            /orders?/i,
        ],
    },
    {
        id: "receivings",
        patterns: [
            /receiv/i,
            /received_items/i,
            /receiving_variance/i,
        ],
    },
    {
        id: "tracking",
        patterns: [
            /tracking/i,
            /shipment/i,
            /carrier/i,
        ],
    },
    {
        id: "builds",
        patterns: [
            /build_risk/i,
            /build_schedule/i,
            /^build/i,
        ],
    },
    {
        id: "active-pos",
        patterns: [
            /active_purchase/i,
            /active_po/i,
        ],
    },
    {
        id: "statement-recon",
        patterns: [
            /statement_recon/i,
            /vendor_statement/i,
        ],
    },
];

export function listWorkbenches(): WorkbenchDefinition[] {
    return [...WORKBENCHES];
}

export function getWorkbenchById(id: WorkbenchId): WorkbenchDefinition {
    return WORKBENCH_BY_ID.get(id) ?? WORKBENCH_BY_ID.get("issues")!;
}

export function getWorkbenchForSource(
    sourceTable: string | null | undefined,
    _sourceId?: string | null,
): WorkbenchDefinition {
    if (!sourceTable) return getWorkbenchById("issues");
    for (const entry of SOURCE_PATTERNS) {
        if (entry.patterns.some(pattern => pattern.test(sourceTable))) {
            return getWorkbenchById(entry.id);
        }
    }
    return getWorkbenchById("issues");
}

export function getWorkbenchForIssue(issue: IssueSourceLike): WorkbenchDefinition {
    return getWorkbenchForSource(issue.source_table, issue.source_id);
}

export function getWorkbenchHref(
    workbenchId: WorkbenchId,
    source?: { sourceTable?: string | null; sourceId?: string | null },
): string {
    const params = new URLSearchParams({ workbench: workbenchId });
    if (source?.sourceTable) params.set("sourceTable", source.sourceTable);
    if (source?.sourceId) params.set("sourceId", source.sourceId);
    return `/dashboard?${params.toString()}`;
}
