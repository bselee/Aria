// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import AgentHierarchyPanel from "./AgentHierarchyPanel";

afterEach(cleanup);

const baseAgent = {
    id: "ap-agent",
    label: "AP Agent",
    reportsTo: null,
    process: ["aria-bot"],
    skills: [],
    workflows: [],
};

describe("AgentHierarchyPanel — currentlyHandling overlay", () => {
    it("renders an emerald in-flight badge when working+waiting > 0", () => {
        render(
            <AgentHierarchyPanel
                agents={[
                    {
                        ...baseAgent,
                        currentlyHandling: { working: 3, waitingExternal: 1, blocked: 0, total: 4 },
                    },
                ]}
                heartbeats={[]}
                tasks={[]}
                selectedAgentId={null}
                onSelectAgent={() => {}}
            />
        );
        const badge = screen.getByTestId("agent-handling-inflight-ap-agent");
        expect(badge.textContent).toContain("4");
    });

    it("renders an amber blocked badge when blocked > 0", () => {
        render(
            <AgentHierarchyPanel
                agents={[
                    {
                        ...baseAgent,
                        currentlyHandling: { working: 0, waitingExternal: 0, blocked: 2, total: 2 },
                    },
                ]}
                heartbeats={[]}
                tasks={[]}
                selectedAgentId={null}
                onSelectAgent={() => {}}
            />
        );
        const badge = screen.getByTestId("agent-handling-blocked-ap-agent");
        expect(badge.textContent).toContain("2");
    });

    it("hides both badges when counts are zero (avoid visual noise)", () => {
        render(
            <AgentHierarchyPanel
                agents={[
                    {
                        ...baseAgent,
                        currentlyHandling: { working: 0, waitingExternal: 0, blocked: 0, total: 0 },
                    },
                ]}
                heartbeats={[]}
                tasks={[]}
                selectedAgentId={null}
                onSelectAgent={() => {}}
            />
        );
        expect(screen.queryByTestId("agent-handling-inflight-ap-agent")).toBeNull();
        expect(screen.queryByTestId("agent-handling-blocked-ap-agent")).toBeNull();
    });

    it("treats missing currentlyHandling as zero (back-compat for older payloads)", () => {
        render(
            <AgentHierarchyPanel
                agents={[baseAgent]}
                heartbeats={[]}
                tasks={[]}
                selectedAgentId={null}
                onSelectAgent={() => {}}
            />
        );
        expect(screen.queryByTestId("agent-handling-inflight-ap-agent")).toBeNull();
        expect(screen.queryByTestId("agent-handling-blocked-ap-agent")).toBeNull();
    });

    it("renders both badges side-by-side when an agent has mixed states", () => {
        render(
            <AgentHierarchyPanel
                agents={[
                    {
                        ...baseAgent,
                        currentlyHandling: { working: 5, waitingExternal: 0, blocked: 1, total: 6 },
                    },
                ]}
                heartbeats={[]}
                tasks={[]}
                selectedAgentId={null}
                onSelectAgent={() => {}}
            />
        );
        expect(screen.getByTestId("agent-handling-inflight-ap-agent").textContent).toContain("5");
        expect(screen.getByTestId("agent-handling-blocked-ap-agent").textContent).toContain("1");
    });
});
