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
    // Vitest's harness sometimes mounts an incomplete localStorage stub
    // (--localstorage-file warning), causing bare `localStorage.getItem`
    // calls inside legacy ops panels to throw "is not a function". Force a
    // working in-memory shim on both `window` and the global so panels that
    // read either reference work.
    const store = new Map<string, string>();
    const shim: Storage = {
        get length() { return store.size; },
        clear: () => store.clear(),
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        removeItem: (k: string) => { store.delete(k); },
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
    };
    Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CommandBoardShell", () => {
    it("surfaces the purchasing lifecycle as a split workflow", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        const lifecycleTab = await screen.findByTestId("shell-tab-lifecycle");
        const orderingPane = screen.getByTestId("lifecycle-pane-ordering");
        const purchasesPane = screen.getByTestId("lifecycle-pane-purchases");
        const rcvPane = screen.getByTestId("lifecycle-pane-rcv");

        expect(lifecycleTab.textContent).toBe("Lifecycle");
        expect(lifecycleTab.getAttribute("aria-selected")).toBe("true");
        expect(orderingPane.textContent).toContain("Ordering");
        expect(purchasesPane.textContent).toContain("Purchases");
        expect(rcvPane.textContent).toContain("RCV");
    });

    it("labels the shell Ops Board and removes redundant lifecycle drill-in tabs", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        expect(await screen.findByText("Ops Board")).toBeTruthy();
        expect(screen.queryByTestId("shell-tab-ordering")).toBeNull();
        expect(screen.queryByTestId("shell-tab-purchases")).toBeNull();
        expect(screen.queryByTestId("shell-tab-rcv")).toBeNull();
    });

    it("fetches agents endpoint at boot (data is hydrated even though right rail is gone)", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        // Right rail (agent tree + cron) was removed in 31de1c5 — agents
        // labels no longer render by default. But the shell STILL fetches
        // /api/command-board/agents on boot because the response carries
        // health-chip counts (X/Y healthy) shown in the header.
        await waitFor(() => {
            const calls = (fetchImpl as unknown as { mock: { calls: any[][] } }).mock.calls;
            const urls = calls.map(c => String(c[0]));
            expect(urls.some(u => u.startsWith("/api/command-board/agents"))).toBe(true);
        });
    });

    it("default tab is Lifecycle because purchasing needs ordering, active purchases, and RCV together", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        const lifecycleTab = await screen.findByTestId("shell-tab-lifecycle");
        expect(lifecycleTab.getAttribute("aria-selected")).toBe("true");
    });

    it("clicking the Tasks tab swaps in the task lanes", async () => {
        const fetchImpl = makeFetch();
        render(<CommandBoardShell fetchImpl={fetchImpl} />);

        const tasksTab = await screen.findByTestId("shell-tab-tasks");
        fireEvent.click(tasksTab);
        expect(tasksTab.getAttribute("aria-selected")).toBe("true");
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
