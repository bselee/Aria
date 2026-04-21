import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    createClientMock,
    createOpsControlRequestMock,
} = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    createOpsControlRequestMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
    createClient: createClientMock,
}));

vi.mock("@/lib/ops/control-plane-db", () => ({
    createOpsControlRequest: createOpsControlRequestMock,
}));

import { OversightAgent } from "./oversight-agent";

function makeSupabase(overrides: {
    upsert?: ReturnType<typeof vi.fn>;
    selectData?: any[];
} = {}) {
    const upsertMock = overrides.upsert ?? vi.fn().mockResolvedValue({ error: null });
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null });
    const selectStarMock = vi.fn().mockResolvedValue({ data: overrides.selectData ?? [], error: null });

    return {
        upsertMock,
        maybeSingleMock,
        selectStarMock,
        client: {
            from: vi.fn(() => ({
                select: vi.fn((columns: string) => {
                    if (columns === "id") {
                        return {
                            eq: vi.fn(() => ({
                                maybeSingle: maybeSingleMock,
                            })),
                        };
                    }

                    return selectStarMock();
                }),
                upsert: upsertMock,
                update: vi.fn(() => ({
                    eq: vi.fn().mockResolvedValue({ error: null }),
                })),
            })),
        },
    };
}

describe("OversightAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("writes heartbeats using the unified ops-control-plane schema", async () => {
        const { client, upsertMock } = makeSupabase();
        createClientMock.mockReturnValue(client);

        const agent = new OversightAgent();
        await agent.registerHeartbeat("ap-pipeline", "queue scan", { queueDepth: 4 });

        expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({
            agent_name: "ap-pipeline",
            heartbeat_at: expect.any(String),
            status: "healthy",
            metadata: expect.objectContaining({
                currentTask: "queue scan",
                metrics: { queueDepth: 4 },
            }),
        }), expect.objectContaining({
            onConflict: "agent_name",
        }));
    });

    it("checks staleness from heartbeat_at and marks stale agents stopped", async () => {
        const { client } = makeSupabase({
            selectData: [{
                agent_name: "ap-pipeline",
                heartbeat_at: new Date(Date.now() - (20 * 60 * 1000)).toISOString(),
                status: "healthy",
                metadata: {},
            }],
        });
        createClientMock.mockReturnValue(client);

        const agent = new OversightAgent();
        const updateStatusMock = vi.spyOn(agent as any, "updateStatus").mockResolvedValue(undefined);
        const handleDownAgentMock = vi.spyOn(agent, "handleDownAgent").mockResolvedValue([]);

        await agent.checkAllHeartbeats();

        expect(updateStatusMock).toHaveBeenCalledWith("ap-pipeline", "stopped");
        expect(handleDownAgentMock).toHaveBeenCalledWith("ap-pipeline");
    });

    it("runs a registered retry hook before fallback recovery", async () => {
        createClientMock.mockReturnValue({ from: vi.fn() });
        const retryMock = vi.fn().mockResolvedValue(true);

        const agent = new OversightAgent();
        (agent as any).registerRecovery("ap-pipeline", {
            retry: retryMock,
            controlCommand: "run_ap_poll_now",
        });

        const actions = await agent.handleDownAgent("ap-pipeline");

        expect(retryMock).toHaveBeenCalledTimes(1);
        expect(createOpsControlRequestMock).not.toHaveBeenCalled();
        expect(actions[0]).toEqual(expect.objectContaining({
            action: "retry",
            success: true,
        }));
    });

    it("falls back to a control-plane recovery request when retry fails", async () => {
        createClientMock.mockReturnValue({ from: vi.fn() });
        createOpsControlRequestMock.mockResolvedValue({ id: "request-1" });

        const agent = new OversightAgent();
        (agent as any).registerRecovery("ap-pipeline", {
            retry: vi.fn().mockResolvedValue(false),
            resetState: vi.fn().mockResolvedValue(false),
            controlCommand: "run_ap_poll_now",
        });

        const actions = await agent.handleDownAgent("ap-pipeline");

        expect(createOpsControlRequestMock).toHaveBeenCalledTimes(1);
        expect(actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                action: "restart_process",
                success: true,
            }),
        ]));
    });
});
