import { describe, expect, it, vi } from "vitest";

import { runEmailPollingCycle } from "./email-polling-cycle";

describe("runEmailPollingCycle", () => {
    it("runs default ingestion, acknowledgement, and AP ingestion in order", async () => {
        const calls: string[] = [];

        await runEmailPollingCycle({
            emailIngestionDefault: {
                run: vi.fn(async () => {
                    calls.push("default-ingest");
                }),
            },
            acknowledgementAgent: {
                processUnreadEmails: vi.fn(async () => {
                    calls.push("default-ack");
                }),
            },
            emailIngestionAP: {
                run: vi.fn(async () => {
                    calls.push("ap-ingest");
                }),
            },
        });

        expect(calls).toEqual(["default-ingest", "default-ack", "ap-ingest"]);
    });

    it("continues into AP ingestion when the default inbox path throws", async () => {
        const calls: string[] = [];
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        await runEmailPollingCycle({
            emailIngestionDefault: {
                run: vi.fn(async () => {
                    calls.push("default-ingest");
                }),
            },
            acknowledgementAgent: {
                processUnreadEmails: vi.fn(async () => {
                    calls.push("default-ack");
                    throw new Error("ack failed");
                }),
            },
            emailIngestionAP: {
                run: vi.fn(async () => {
                    calls.push("ap-ingest");
                }),
            },
        });

        expect(calls).toEqual(["default-ingest", "default-ack", "ap-ingest"]);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it("reports successful stage completions for logical pipeline heartbeats", async () => {
        const stages: string[] = [];

        await runEmailPollingCycle({
            emailIngestionDefault: {
                run: vi.fn(async () => undefined),
            },
            acknowledgementAgent: {
                processUnreadEmails: vi.fn(async () => undefined),
            },
            emailIngestionAP: {
                run: vi.fn(async () => undefined),
            },
            onStageSuccess: vi.fn((stage: string) => {
                stages.push(stage);
            }),
        } as any);

        expect(stages).toEqual([
            "default-email-pipeline",
            "default-acknowledgement",
            "ap-email-pipeline",
        ]);
    });
});
