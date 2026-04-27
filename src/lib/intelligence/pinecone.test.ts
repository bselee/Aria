import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createClient: createClientMock }));

import { indexOperationalContext } from "./pinecone";

function makeSb(opts: { upsertError?: any } = {}) {
    const upsert = vi.fn().mockResolvedValue({ error: opts.upsertError ?? null });
    const sb = {
        from: vi.fn(() => ({ upsert })),
    };
    return { sb, upsert };
}

describe("indexOperationalContext (email_context_log writer)", () => {
    beforeEach(() => createClientMock.mockReset());

    it("no-ops when called with no arguments (legacy ops-manager cron)", async () => {
        const { sb, upsert } = makeSb();
        createClientMock.mockReturnValue(sb);

        await indexOperationalContext();

        expect(upsert).not.toHaveBeenCalled();
    });

    it("upserts to email_context_log with id, text, metadata", async () => {
        const { sb, upsert } = makeSb();
        createClientMock.mockReturnValue(sb);

        await indexOperationalContext("gmail-msg-123", "PDF text body", {
            vendor: "ULINE",
            po: "5512",
            amount: 412.5,
        });

        expect(sb.from).toHaveBeenCalledWith("email_context_log");
        expect(upsert).toHaveBeenCalledOnce();
        const args = upsert.mock.calls[0][0];
        expect(args.id).toBe("gmail-msg-123");
        expect(args.text).toBe("PDF text body");
        expect(args.metadata).toEqual({ vendor: "ULINE", po: "5512", amount: 412.5 });
    });

    it("truncates text longer than 8000 chars", async () => {
        const { sb, upsert } = makeSb();
        createClientMock.mockReturnValue(sb);

        const longText = "x".repeat(10_000);
        await indexOperationalContext("id-1", longText, {});

        const args = upsert.mock.calls[0][0];
        expect(args.text).toHaveLength(8000);
    });

    it("does not throw when supabase client is unavailable", async () => {
        createClientMock.mockReturnValue(null);

        await expect(
            indexOperationalContext("id-2", "text", {}),
        ).resolves.toBeUndefined();
    });

    it("swallows upsert errors and logs them (does not throw)", async () => {
        const { sb } = makeSb({ upsertError: { message: "constraint violation" } });
        createClientMock.mockReturnValue(sb);

        await expect(
            indexOperationalContext("id-3", "text", {}),
        ).resolves.toBeUndefined();
    });
});
