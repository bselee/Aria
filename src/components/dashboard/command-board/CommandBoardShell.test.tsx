// @vitest-environment jsdom

import React from "react";
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CommandBoardShell from "./CommandBoardShell";
import OpsModuleDock from "./OpsModuleDock";

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseAgents = [
    {
        id: "will",
        label: "Will",
        reportsTo: null,
        process: ["Owns the system"],
        skills: [],
        workflows: [],
    },
    {
        id: "ops-manager",
        label: "Ops Manager",
        reportsTo: "will",
        process: [],
        skills: [],
        workflows: [],
    },
    {
        id: "ap-agent",
        label: "AP Agent",
        reportsTo: "ops-manager",
        process: [],
        skills: [],
        workflows: [],
    },
    {
        id: "watchdog",
        label: "Slack Watchdog",
        reportsTo: "ops-manager",
        process: [],
        skills: [],
        workflows: [],
    },
];

const baseCatalog = {
    generatedAt: new Date().toISOString(),
    agents: baseAgents,
    agentFiles: [],
    skills: [],
    workflows: [],
    references: [],
};

const baseTasks = [
    {
        id: "task-1",
        title: "Approve invoice for ULINE PO 12345",
        lane: "needs-will",
        status: "NEEDS_APPROVAL",
        owner: "Will",
        priority: "P1",
        source_table: "ap_pending_approvals",
        source_id: "abc",
        dedup_count: 1,
        age_seconds: 600,
        parent_task_id: null,
        has_children: false,
    },
    {
        id: "task-2",
        title: "Reconcile FedEx CSV",
        lane: "running",
        status: "RUNNING",
        owner: "AP Agent",
        priority: "P2",
        source_table: "agent_task",
        source_id: "def",
        dedup_count: 1,
        age_seconds: 30,
        parent_task_id: null,
        has_children: false,
    },
    {
        id: "task-3",
        title: "Cron failure: build-risk",
        lane: "blocked-failed",
        status: "FAILED",
        owner: "Ops Manager",
        priority: "P0",
        source_table: "cron_runs",
        source_id: "xyz",
        dedup_count: 4,
        age_seconds: 3600,
        parent_task_id: null,
        has_children: false,
    },
];

const baseSummary = {
    lanes: {
        "needs-will": 1,
        running: 1,
        "blocked-failed": 1,
        autonomous: 0,
        "recently-closed": 0,
    },
    agents: { total: 4, healthy: 3, stale: 1 },
    crons: { total: 2, recentSuccess: 2, recentError: 0 },
};

const baseCrons = [
    {
        name: "build-risk",
        description: "morning build risk",
        schedule: "30 7 * * 1-5",
        scheduleHuman: "Mon-Fri 7:30 AM",
        category: "summary",
        weekdaysOnly: true,
        lastRunAt: new Date().toISOString(),
        lastDurationMs: 1234,
        lastStatus: "success" as const,
    },
];

const baseHeartbeats = [
    {
        agent_name: "AP Agent",
        status: "healthy",
        heartbeat_at: new Date().toISOString(),
        payload: {},
        staleness: "fresh" as const,
    },
];

const baseTaskDetail = {
    ...baseTasks[0],
    body: { line: "PO 12345" },
    events: [
        {
            event_type: "needs_approval",
            created_at: new Date().toISOString(),
            payload: {},
        },
    ],
    closes_when: null,
    input_hash: "deadbeefcafebabe",
    completed_at: null,
};

// ── Fetch mock ──────────────────────────────────────────────────────────────

function makeFetch(overrides: Record<string, unknown> = {}) {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const stripped = url.split("?")[0];
        const map: Record<string, unknown> = {
            "/api/command-board": baseSummary,
            "/api/command-board/agents": baseCatalog,
            "/api/command-board/tasks": { tasks: baseTasks, total: baseTasks.length },
            "/api/command-board/heartbeats": { heartbeats: baseHeartbeats },
            "/api/command-board/crons": { crons: baseCrons },
            ...overrides,
        };
        if (stripped.startsWith("/api/command-board/tasks/")) {
            const id = stripped.split("/").pop();
            if (id && id !== "tasks") {
                return new Response(
                    JSON.stringify({ ...baseTaskDetail, id }),
                    { status: 200, headers: { "Content-Type": "application/json" } },
                );
            }
        }
        const payload = map[stripped];
        if (payload === undefined) {
            return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as unknown as typeof fetch;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

beforeEach(() => {
    // Each test gets a fresh localStorage. jsdom provides one per env.
    try {
        window.localStorage.clear();
    } catch {
        /* ignore */
    }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CommandBoardShell", () => {
    it("renders agent hierarchy from /api/command-board/agents", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        await waitFor(() => {
            expect(fetchImpl).toHaveBeenCalled();
        });

        // Agent labels can appear in both AgentHierarchyPanel and
        // AgentCatalogPanel — use findAllByText and assert ≥1.
        expect((await screen.findAllByText("Will")).length).toBeGreaterThan(0);
        expect((await screen.findAllByText("Ops Manager")).length).toBeGreaterThan(0);
        expect((await screen.findAllByText("AP Agent")).length).toBeGreaterThan(0);
        expect((await screen.findAllByText("Slack Watchdog")).length).toBeGreaterThan(0);
    });

    it("renders tasks into their lanes from /api/command-board/tasks", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        const needsLane = await screen.findByTestId("lane-needs-will");
        const runningLane = await screen.findByTestId("lane-running");
        const blockedLane = await screen.findByTestId("lane-blocked-failed");

        expect(needsLane.textContent).toMatch(/Approve invoice/);
        expect(runningLane.textContent).toMatch(/Reconcile FedEx/);
        expect(blockedLane.textContent).toMatch(/Cron failure: build-risk/);
        // Dedup badge for task-3
        expect(blockedLane.textContent).toMatch(/×4/);
    });

    it("fetches detail when a task card is clicked", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        const card = await screen.findByTestId("task-card-task-1");
        fireEvent.click(card);

        await waitFor(() => {
            const calls = (fetchImpl as unknown as { mock: { calls: any[][] } })
                .mock.calls;
            const urls = calls.map(c => String(c[0]));
            expect(
                urls.some(u => u.startsWith("/api/command-board/tasks/task-1")),
            ).toBe(true);
        });
    });
});

describe("OpsModuleDock", () => {
    it("renders tab buttons for the existing ops modules", () => {
        render(<OpsModuleDock />);

        // Tab labels we contracted to surface.
        const expected = [
            "Receivings",
            "AP / Invoices",
            "Ordering / Purchasing",
            "Active Purchases",
            "Build Risk",
            "Build Schedule",
            "Tracking",
            "Statement Recon",
        ];
        for (const label of expected) {
            expect(
                screen.getAllByRole("tab", { name: new RegExp(label, "i") }).length,
            ).toBeGreaterThan(0);
        }
    });
});
