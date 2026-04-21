import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    createClientMock,
    runEmailPollingCycleMock,
    archiveSessionMock,
    oversightAgentInstance,
} = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    runEmailPollingCycleMock: vi.fn(),
    archiveSessionMock: vi.fn().mockResolvedValue(undefined),
    oversightAgentInstance: {
        registerHeartbeat: vi.fn().mockResolvedValue(undefined),
        registerRecovery: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock("../supabase", () => ({
    createClient: createClientMock,
}));

vi.mock("./email-polling-cycle", () => ({
    runEmailPollingCycle: runEmailPollingCycleMock,
}));

vi.mock("./memory-layer-manager", () => ({
    memoryLayerManager: {
        archiveSession: archiveSessionMock,
    },
}));

vi.mock("./oversight-agent", () => ({
    OversightAgent: class {
        constructor() {
            return oversightAgentInstance as any;
        }
    },
}));

vi.mock("./workers/ap-identifier", () => ({
    APIdentifierAgent: class {
        identifyAndQueue = vi.fn().mockResolvedValue(undefined);
    },
}));

vi.mock("./workers/email-ingestion", () => ({
    EmailIngestionWorker: class {
        run = vi.fn().mockResolvedValue(undefined);
        constructor(_inbox: string) {}
    },
}));

vi.mock("./workers/ap-forwarder", () => ({
    APForwarderAgent: class {
        processPendingForwards = vi.fn().mockResolvedValue(undefined);
        constructor(_bot: unknown) {}
    },
}));

vi.mock("./tracking-agent", () => ({
    TrackingAgent: class {},
}));

vi.mock("./acknowledgement-agent", () => ({
    AcknowledgementAgent: class {
        processUnreadEmails = vi.fn().mockResolvedValue(undefined);
        constructor(_scope: string) {}
    },
}));

vi.mock("./supervisor-agent", () => ({
    SupervisorAgent: class {
        reportAgentException = vi.fn();
        constructor(_bot: unknown) {}
    },
}));

import { OpsManager } from "./ops-manager";

function makeSupabase() {
    return {
        from: vi.fn((table: string) => {
            if (table === "build_completions") {
                return {
                    select: vi.fn().mockReturnThis(),
                    gte: vi.fn().mockResolvedValue({ data: [] }),
                };
            }

            if (table === "cron_runs") {
                return {
                    insert: vi.fn(() => ({
                        select: vi.fn(() => ({
                            single: vi.fn().mockResolvedValue({ data: { id: 1 } }),
                        })),
                    })),
                    update: vi.fn(() => ({
                        eq: vi.fn().mockResolvedValue({}),
                    })),
                };
            }

            return {
                select: vi.fn().mockResolvedValue({ data: [] }),
                insert: vi.fn().mockResolvedValue({}),
                update: vi.fn(() => ({
                    eq: vi.fn().mockResolvedValue({}),
                })),
            };
        }),
    };
}

describe("OpsManager oversight wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createClientMock.mockReturnValue(makeSupabase());
    });

    it("passes logical stage heartbeats into the email polling cycle", async () => {
        const manager = new OpsManager({} as any);

        await manager.pollAPInbox();

        expect(runEmailPollingCycleMock).toHaveBeenCalledTimes(1);
        const deps = runEmailPollingCycleMock.mock.calls[0][0] as any;
        expect(typeof deps.onStageSuccess).toBe("function");

        await deps.onStageSuccess("ap-identifier");
        expect(oversightAgentInstance.registerHeartbeat).toHaveBeenCalledWith(
            "ap-identifier",
            "ap-identifier",
            { source: "email-polling-cycle" },
        );
    });

    it("archives scheduled task outcomes through the memory layer", async () => {
        const manager = new OpsManager({} as any);

        await (manager as any).safeRun("APPolling", async () => undefined);

        expect(archiveSessionMock).toHaveBeenCalledWith(
            expect.stringContaining("cron:APPolling:"),
            expect.objectContaining({
                agentName: "ops-manager",
                taskType: "APPolling",
                status: "success",
            }),
        );
    });
});
