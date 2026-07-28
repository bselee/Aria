// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import OversightPanel from "./OversightPanel";

const browserClientMock = {
    from: vi.fn((table: string) => {
        if (table === "agent_heartbeats") {
            return {
                select: vi.fn().mockReturnThis(),
                order: vi.fn().mockResolvedValue({
                    data: [{
                        id: "hb-1",
                        agent_name: "ap-pipeline",
                        heartbeat_at: "2026-04-21T12:00:00.000Z",
                        status: "healthy",
                        metadata: {
                            currentTask: "queue scan",
                            metrics: { queueDepth: 2 },
                        },
                    }],
                }),
            };
        }

        if (table === "skills") {
            return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                order: vi.fn().mockResolvedValue({ data: [] }),
            };
        }

        throw new Error(`unexpected table ${table}`);
    }),
};

// OversightPanel.tsx does: import { createClient as createBrowserClient } from "@/lib/db"
// Same two defects as ActivityTerminal.ui.test.tsx: this mocked "@/lib/supabase" (a mere
// re-export shim of "@/lib/db", so nothing on this path imports it) AND exported
// `createBrowserClient` when the alias is applied at the import site, so the real module
// must export `createClient`. The mock never engaged.
vi.mock("@/lib/db", () => ({
    createClient: () => browserClientMock,
}));

describe("OversightPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders heartbeat rows from the unified schema", async () => {
        render(<OversightPanel />);

        await waitFor(() => expect(browserClientMock.from).toHaveBeenCalled());
        expect(screen.getByText("ap-pipeline")).toBeTruthy();
        expect(screen.getByText("queue scan")).toBeTruthy();
        expect(screen.getByText(/Healthy/i)).toBeTruthy();
    });
});
