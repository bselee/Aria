import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createClient: createClientMock }));

import {
    deriveLane,
    getCommandBoardCrons,
    getCommandBoardSummary,
    getCommandBoardTaskList,
    getCommandBoardTaskDetail,
    getCommandBoardHeartbeats,
    getCommandBoardRuns,
    getCommandBoardControlRequests,
} from "./service";
import { CRON_JOBS } from "@/lib/scheduler/cron-registry";
import type { AgentTask } from "@/lib/intelligence/agent-task";

// ── Lane derivation ─────────────────────────────────────────────────────────

function task(overrides: Partial<AgentTask> = {}): AgentTask {
    return {
        id: "t1",
        type: "manual",
        source_table: null,
        source_id: null,
        goal: "g",
        status: "PENDING",
        owner: "aria",
        priority: 2,
        parent_task_id: null,
        requires_approval: false,
        approval_decision: null,
        approval_decided_by: null,
        approval_decided_at: null,
        inputs: {},
        outputs: {},
        cost_cents: 0,
        retry_count: 0,
        max_retries: 0,
        deadline_at: null,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: new Date().toISOString(),
        claimed_at: null,
        claimed_by: null,
        completed_at: null,
        ...overrides,
    } as AgentTask;
}

describe("deriveLane", () => {
    it("NEEDS_APPROVAL -> needs-will", () => {
        expect(deriveLane(task({ status: "NEEDS_APPROVAL" }))).toBe("needs-will");
    });
    it("FAILED owned by will -> needs-will", () => {
        expect(deriveLane(task({ status: "FAILED", owner: "will" }))).toBe("needs-will");
    });
    it("FAILED with non-will owner -> blocked-failed", () => {
        expect(deriveLane(task({ status: "FAILED", owner: "aria" }))).toBe("blocked-failed");
    });
    it("RUNNING -> running", () => {
        expect(deriveLane(task({ status: "RUNNING" }))).toBe("running");
    });
    it("CLAIMED -> running", () => {
        expect(deriveLane(task({ status: "CLAIMED" }))).toBe("running");
    });
    it("PENDING -> autonomous", () => {
        expect(deriveLane(task({ status: "PENDING" }))).toBe("autonomous");
    });
    it("SUCCEEDED recently completed -> recently-closed", () => {
        const t = task({ status: "SUCCEEDED", completed_at: new Date().toISOString() });
        expect(deriveLane(t)).toBe("recently-closed");
    });
    it("CANCELLED recently completed -> recently-closed", () => {
        const t = task({ status: "CANCELLED", completed_at: new Date().toISOString() });
        expect(deriveLane(t)).toBe("recently-closed");
    });
    it("SUCCEEDED but not completed -> autonomous (legacy)", () => {
        const t = task({ status: "SUCCEEDED", completed_at: null });
        expect(deriveLane(t)).toBe("autonomous");
    });
});

// ── Cron sync test (catches drift between OpsManager and CRON_JOBS) ─────────

describe("CRON_JOBS sync with OpsManager.registerJobs()", () => {
    it("every cron.schedule name in OpsManager is in CRON_JOBS", async () => {
        const opsManagerPath = path.join(
            process.cwd(),
            "src",
            "lib",
            "intelligence",
            "ops-manager.ts",
        );
        const src = await fs.readFile(opsManagerPath, "utf8");

        // Match `this.safeRun("Name", ...)` lines inside registerJobs(). The
        // schedule() helper there immediately calls safeRun("Name") inside the
        // tick handler, so this is the simplest stable signal.
        const re = /this\.safeRun\(\s*["']([A-Za-z0-9_]+)["']/g;
        const found = new Set<string>();
        for (const m of src.matchAll(re)) {
            found.add(m[1]);
        }

        const registered = new Set(CRON_JOBS.map((j) => j.name));
        const missing: string[] = [];
        for (const name of found) {
            if (!registered.has(name)) missing.push(name);
        }
        expect(missing).toEqual([]);
    });
});

// ── getCommandBoardCrons ────────────────────────────────────────────────────

describe("getCommandBoardCrons", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns one entry per CRON_JOB even when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardCrons();
        expect(out.length).toBe(CRON_JOBS.length);
        expect(out.every((r) => r.lastRunAt === null)).toBe(true);
    });

    it("joins latest cron_runs row by name", async () => {
        const sample = [
            {
                task_name: "APPolling",
                started_at: "2026-04-28T00:00:00.000Z",
                duration_ms: 1234,
                status: "success",
            },
        ];
        const orderMock = vi.fn().mockResolvedValue({ data: sample, error: null });
        const selectMock = vi.fn(() => ({ order: () => ({ limit: () => orderMock() }) }));
        createClientMock.mockReturnValue({
            from: vi.fn(() => ({ select: selectMock })),
        });

        const out = await getCommandBoardCrons();
        const ap = out.find((r) => r.name === "APPolling");
        expect(ap).toBeDefined();
        expect(ap?.lastStatus).toBe("success");
        expect(ap?.lastDurationMs).toBe(1234);
        expect(ap?.lastRunAt).toBe("2026-04-28T00:00:00.000Z");
    });
});

// ── getCommandBoardSummary ──────────────────────────────────────────────────

describe("getCommandBoardSummary", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns zeroed counts when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardSummary();
        expect(out.lanes["needs-will"]).toBe(0);
        expect(out.agents.total).toBeGreaterThan(0); // hierarchy has 12 agents
    });
});

// ── getCommandBoardTaskList ─────────────────────────────────────────────────

describe("getCommandBoardTaskList", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns empty when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardTaskList({});
        expect(out.tasks).toEqual([]);
        expect(out.total).toBe(0);
    });
});

// ── getCommandBoardTaskDetail ───────────────────────────────────────────────

describe("getCommandBoardTaskDetail", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns null when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardTaskDetail("missing-id");
        expect(out).toBeNull();
    });
});

// ── getCommandBoardHeartbeats ───────────────────────────────────────────────

describe("getCommandBoardHeartbeats", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns empty when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardHeartbeats();
        expect(out).toEqual([]);
    });

    it("annotates staleness based on heartbeat_at age", async () => {
        const fresh = new Date().toISOString();
        const stale = new Date(Date.now() - 12 * 60 * 1000).toISOString();
        const orderMock = vi.fn().mockResolvedValue({
            data: [
                { agent_name: "a", status: "healthy", heartbeat_at: fresh, metadata: {} },
                { agent_name: "b", status: "healthy", heartbeat_at: stale, metadata: {} },
            ],
            error: null,
        });
        createClientMock.mockReturnValue({
            from: vi.fn(() => ({
                select: vi.fn(() => ({
                    order: () => orderMock(),
                })),
            })),
        });
        const out = await getCommandBoardHeartbeats();
        expect(out).toHaveLength(2);
        const a = out.find((r) => r.agent_name === "a");
        const b = out.find((r) => r.agent_name === "b");
        expect(a?.staleness).toBe("fresh");
        expect(b?.staleness).toBe("stale");
    });
});

// ── getCommandBoardRuns ─────────────────────────────────────────────────────

describe("getCommandBoardRuns", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns empty when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardRuns({});
        expect(out).toEqual([]);
    });
});

// ── getCommandBoardControlRequests ──────────────────────────────────────────

describe("getCommandBoardControlRequests", () => {
    beforeEach(() => createClientMock.mockReset());

    it("returns empty when supabase is missing", async () => {
        createClientMock.mockReturnValue(null);
        const out = await getCommandBoardControlRequests();
        expect(out).toEqual([]);
    });
});
