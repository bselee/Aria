import { describe, expect, it, vi } from "vitest";

vi.mock("../../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));

import { handleTelegramCallback } from "./telegram-callbacks";

describe("handleTelegramCallback — PO send recovery", () => {
    it("returns a clean recovery message for stale callbacks after restart", async () => {
        const result = await handleTelegramCallback({ callbackData: "po_confirm_send_dead" });
        expect(result.userMessage).toMatch(/expired|re-initiate|review/i);
    });

    it("returns expired message for explicitly expired session", async () => {
        const result = await handleTelegramCallback({ callbackData: "po_confirm_send_expired-session-id" });
        expect(result.userMessage).toMatch(/expired|re-initiate|review/i);
        expect(result.recovered).toBe(false);
    });

    it("returns clean failure for unknown callback payloads", async () => {
        const result = await handleTelegramCallback({ callbackData: "unknown_callback_xyz" });
        expect(result.userMessage).toBeTruthy();
        expect(result.recovered).toBe(false);
    });

    it("never throws on any callback input", async () => {
        await expect(handleTelegramCallback({ callbackData: "" })).resolves.toBeDefined();
        await expect(handleTelegramCallback({ callbackData: "po_confirm_send_" })).resolves.toBeDefined();
    });
});
