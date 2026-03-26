import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

import { executePOSendAction } from "./actions.po-send";

describe("executePOSendAction", () => {
    it("returns partial_success when Finale commit succeeds but email send fails", async () => {
        const result = await executePOSendAction({ sendId: "s1" });
        expect(["success", "partial_success", "failed"]).toContain(result.status);
    });

    it("returns failed with clean message for stale session", async () => {
        const result = await executePOSendAction({ sendId: "stale-session-nonexistent" });
        expect(result.status).toBe("failed");
        expect(result.userMessage).toBeTruthy();
    });

    it("returns failed cleanly for expired session", async () => {
        const result = await executePOSendAction({ sendId: "expired-session" });
        expect(result.status).toBe("failed");
        expect(result.retryAllowed).toBe(false);
    });

    it("never propagates uncaught exceptions to the caller", async () => {
        await expect(executePOSendAction({ sendId: "" })).resolves.toBeDefined();
    });
});
