import { describe, expect, it, vi } from "vitest";

import { executeBotControlCommand } from "./control-plane-runtime";

describe("executeBotControlCommand", () => {
    it("runs the AP poll for run_ap_poll_now", async () => {
        const pollAPInbox = vi.fn(async () => undefined);

        const result = await executeBotControlCommand("run_ap_poll_now", {
            pollAPInbox,
            runNightshiftLoop: vi.fn(async () => undefined),
            clearStuckProcessing: vi.fn(async () => ({ emailQueue: 0, apQueue: 0, nightshiftQueue: 0 })),
        });

        expect(pollAPInbox).toHaveBeenCalledTimes(1);
        expect(result).toBe("ap_poll_completed");
    });

    it("runs a single nightshift loop for run_nightshift_now", async () => {
        const runNightshiftLoop = vi.fn(async () => undefined);

        const result = await executeBotControlCommand("run_nightshift_now", {
            pollAPInbox: vi.fn(async () => undefined),
            runNightshiftLoop,
            clearStuckProcessing: vi.fn(async () => ({ emailQueue: 0, apQueue: 0, nightshiftQueue: 0 })),
        });

        expect(runNightshiftLoop).toHaveBeenCalledTimes(1);
        expect(result).toBe("nightshift_run_completed");
    });

    it("clears stale processing rows and reports counts", async () => {
        const clearStuckProcessing = vi.fn(async () => ({
            emailQueue: 2,
            apQueue: 1,
            nightshiftQueue: 3,
        }));

        const result = await executeBotControlCommand("clear_stuck_processing", {
            pollAPInbox: vi.fn(async () => undefined),
            runNightshiftLoop: vi.fn(async () => undefined),
            clearStuckProcessing,
        });

        expect(clearStuckProcessing).toHaveBeenCalledTimes(1);
        expect(result).toBe("stuck_processing_cleared:6");
    });
});
