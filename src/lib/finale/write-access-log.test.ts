import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, insertMock, consoleInfoMock, consoleWarnMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    insertMock: vi.fn(),
    consoleInfoMock: vi.fn(),
    consoleWarnMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
    createClient: createClientMock,
}));

import { recordFinaleWriteAttempt } from "./write-access-log";

describe("finale write access log", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertMock.mockResolvedValue({ error: null });
        createClientMock.mockReturnValue({
            from: vi.fn(() => ({
                insert: insertMock,
            })),
        });
        consoleInfoMock.mockReset();
        consoleWarnMock.mockReset();
        vi.spyOn(console, "info").mockImplementation(consoleInfoMock);
        vi.spyOn(console, "warn").mockImplementation(consoleWarnMock);
    });

    it("records allowed attempts with allowed true", async () => {
        await recordFinaleWriteAttempt({
            source: "dashboard",
            action: "create_draft_po",
            allowed: true,
            target: { vendorPartyId: "vendor-1" },
        });

        expect(insertMock).toHaveBeenCalledWith(
            expect.objectContaining({
                intent: "FINALE_WRITE_ATTEMPT",
                action_taken: expect.stringContaining('allowed'),
                metadata: expect.objectContaining({
                    source: "dashboard",
                    action: "create_draft_po",
                    allowed: true,
                    target: { vendorPartyId: "vendor-1" },
                }),
            }),
        );
    });

    it("records denied attempts with a denial reason", async () => {
        await recordFinaleWriteAttempt({
            source: "slack_watchdog",
            action: "create_draft_po",
            allowed: false,
            denialReason: 'Finale write denied: source "slack_watchdog" cannot create_draft_po',
            target: { vendorPartyId: "vendor-2" },
        });

        expect(insertMock).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    source: "slack_watchdog",
                    action: "create_draft_po",
                    allowed: false,
                    denialReason: expect.stringContaining('slack_watchdog'),
                }),
            }),
        );
    });

    it("falls back to a warning without throwing when logging fails", async () => {
        insertMock.mockResolvedValueOnce({ error: { message: "db offline" } });

        await expect(recordFinaleWriteAttempt({
            source: "dashboard",
            action: "commit_draft_po",
            allowed: true,
            target: { orderId: "PO-1001" },
        })).resolves.toBeUndefined();

        expect(consoleWarnMock).toHaveBeenCalledWith(
            "[finale] Failed to record write attempt audit log:",
            "db offline",
        );
    });
});
