// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IssuesPanel from "./IssuesPanel";

afterEach(cleanup);

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

function mockIssuesResponse(issues: any[]) {
    fetchMock.mockImplementation((url: string) => {
        if (url.startsWith("/api/command-board/issues") && !url.includes("/actions")) {
            return Promise.resolve({
                ok: true,
                json: async () => ({ issues, total: issues.length }),
            });
        }
        // Action POSTs
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
}

const baseIssue = {
    id: "iss-1",
    title: "Reconcile invoice 124302",
    lifecycle_state: "working",
    autonomy_state: "working",
    current_handler: "ap-reconciler",
    blocker_reason: null,
    next_action: "matching PO",
    priority: 2,
    owner: "aria",
    age_seconds: 120,
};

describe("IssuesPanel — control profile rendering", () => {
    it("renders lifecycle, handler, control mode, and next action", async () => {
        mockIssuesResponse([
            { ...baseIssue, inputs: { control: { mode: "act_with_approval", paused: false } } },
        ]);
        render(<IssuesPanel />);
        await waitFor(() => {
            expect(screen.getByText("Reconcile invoice 124302")).toBeTruthy();
        });
        expect(screen.getByText("working")).toBeTruthy();
        expect(screen.getByText("· ap-reconciler")).toBeTruthy();
        expect(screen.getByTestId("issue-control-mode-iss-1").textContent).toBe("act_with_approval");
        expect(screen.getByText("→ matching PO")).toBeTruthy();
    });

    it("shows ⏸ paused badge when control.paused=true", async () => {
        mockIssuesResponse([
            { ...baseIssue, inputs: { control: { mode: "autonomous", paused: true } } },
        ]);
        render(<IssuesPanel />);
        await waitFor(() => screen.getByTestId("issue-paused-iss-1"));
        expect(screen.getByTestId("issue-paused-iss-1").textContent).toContain("paused");
    });
});

describe("IssuesPanel — control buttons", () => {
    it("clicking Pause posts { action: 'pause' }", async () => {
        mockIssuesResponse([
            { ...baseIssue, inputs: { control: { mode: "act_with_approval", paused: false } } },
        ]);
        render(<IssuesPanel />);
        const pauseButton = await waitFor(() =>
            screen.getByRole("button", { name: /pause issue iss-1/i }),
        );
        fireEvent.click(pauseButton);
        await waitFor(() => {
            const actionPosts = fetchMock.mock.calls.filter(c => String(c[0]).includes("/actions"));
            expect(actionPosts.length).toBeGreaterThan(0);
        });
        const post = fetchMock.mock.calls.find(c => String(c[0]).includes("/actions"));
        const body = JSON.parse(post![1].body);
        expect(body.action).toBe("pause");
    });

    it("clicking Resume posts { action: 'resume' } when paused", async () => {
        mockIssuesResponse([
            { ...baseIssue, inputs: { control: { mode: "autonomous", paused: true } } },
        ]);
        render(<IssuesPanel />);
        const resumeButton = await waitFor(() =>
            screen.getByRole("button", { name: /resume issue iss-1/i }),
        );
        fireEvent.click(resumeButton);
        await waitFor(() => {
            const post = fetchMock.mock.calls.find(c => String(c[0]).includes("/actions"));
            expect(post).toBeTruthy();
            const body = JSON.parse(post![1].body);
            expect(body.action).toBe("resume");
        });
    });

    it("clicking Run next posts { action: 'run_next_step' }", async () => {
        mockIssuesResponse([
            { ...baseIssue, inputs: { control: { mode: "autonomous", paused: false } } },
        ]);
        render(<IssuesPanel />);
        const runButton = await waitFor(() =>
            screen.getByRole("button", { name: /run next step for issue iss-1/i }),
        );
        fireEvent.click(runButton);
        await waitFor(() => {
            const post = fetchMock.mock.calls.find(c => String(c[0]).includes("/actions"));
            expect(post).toBeTruthy();
            const body = JSON.parse(post![1].body);
            expect(body.action).toBe("run_next_step");
        });
    });

    it("human-approval rows still post { action: 'approve' } for the Approve button", async () => {
        mockIssuesResponse([
            {
                ...baseIssue,
                lifecycle_state: "blocked",
                blocker_reason: "human_approval_required",
                inputs: { control: { mode: "act_with_approval", paused: false } },
            },
        ]);
        render(<IssuesPanel />);
        const approveBtn = await waitFor(() => screen.getByText("Approve"));
        fireEvent.click(approveBtn);
        await waitFor(() => {
            const post = fetchMock.mock.calls.find(c => String(c[0]).includes("/actions"));
            expect(post).toBeTruthy();
            const body = JSON.parse(post![1].body);
            expect(body.action).toBe("approve");
        });
    });
});

describe("IssuesPanel — list-row data discipline", () => {
    it("does not fetch /api/command-board/tools or other catalog data per row", async () => {
        mockIssuesResponse([
            { ...baseIssue, id: "iss-A", title: "Issue A", inputs: { control: { mode: "autonomous", paused: false } } },
            { ...baseIssue, id: "iss-B", title: "Issue B" },
        ]);
        render(<IssuesPanel />);
        await waitFor(() => screen.getByTestId("issue-row-iss-A"));
        await waitFor(() => screen.getByTestId("issue-row-iss-B"));
        const urls = fetchMock.mock.calls.map(c => String(c[0]));
        const allowed = ["/api/command-board/issues", "/api/command-board/issues/"];
        for (const url of urls) {
            expect(allowed.some(prefix => url.startsWith(prefix))).toBe(true);
        }
    });
});
