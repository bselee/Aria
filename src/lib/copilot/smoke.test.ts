import { describe, expect, it, vi } from "vitest";
import { getStartupHealth } from "./smoke";

describe("getStartupHealth", () => {
    it("reports Slack as disabled when no token is configured", async () => {
        const result = await getStartupHealth({
            hasSlackToken: false,
        });

        expect(result.slack).toBe("disabled");
    });

    it("reports Slack as running when startup succeeds", async () => {
        const result = await getStartupHealth({
            hasSlackToken: true,
            startSlackWatchdog: vi.fn().mockResolvedValue(undefined),
        });

        expect(result.slack).toBe("running");
    });

    it("reports Slack startup failure explicitly without going silent", async () => {
        const result = await getStartupHealth({
            hasSlackToken: true,
            startSlackWatchdog: vi.fn().mockRejectedValue(new Error("boom")),
        });

        expect(result.slack).toBe("disabled");
        expect(result.notes[0]).toMatch(/slack watchdog failed to start/i);
    });
});
