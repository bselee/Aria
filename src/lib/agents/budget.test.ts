import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Supabase mock ───────────────────────────────────────────────────────────
const supabaseMock: any = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    maybeSingle: vi.fn(),
};

function resetChain() {
    supabaseMock.from.mockReturnValue(supabaseMock);
    supabaseMock.select.mockReturnValue(supabaseMock);
    supabaseMock.eq.mockReturnValue(supabaseMock);
    supabaseMock.insert.mockReturnValue(supabaseMock);
    supabaseMock.update.mockReturnValue(supabaseMock);
}

vi.mock("@/lib/supabase", () => ({ createClient: () => supabaseMock }));

import { checkBudget, chargeBudget, assertBudget, BudgetExceededError, estimateCostUsd } from "./budget";

beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
});

describe("estimateCostUsd", () => {
    it("uses the static rate table for known models", () => {
        expect(estimateCostUsd("gpt-4o", 1000, 500)).toBeCloseTo(0.009, 4);
        expect(estimateCostUsd("claude-3-5-sonnet-20241022", 1000, 1000)).toBeCloseTo(0.016, 4);
    });

    it("returns 0 for unknown models (graceful degradation)", () => {
        expect(estimateCostUsd("unknown-model-xyz", 9999, 9999)).toBe(0);
    });

});

describe("checkBudget", () => {
    it("returns allowed when agent is well under cap", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { monthly_usd_cap: "50.00", current_period_start: new Date().toISOString(), current_period_usd_spent: "12.34", paused_until: null },
            error: null,
        });
        const r = await checkBudget("ap-agent");
        expect(r.allowed).toBe(true);
        expect(r.capUsd).toBe(50);
        expect(r.spentUsd).toBe(12.34);
    });

    it("returns refused when over cap", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { monthly_usd_cap: "50.00", current_period_start: new Date().toISOString(), current_period_usd_spent: "55.00", paused_until: null },
            error: null,
        });
        const r = await checkBudget("ap-agent");
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("exceeded");
    });

    it("returns paused when paused_until is in the future", async () => {
        const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { monthly_usd_cap: "50.00", current_period_start: new Date().toISOString(), current_period_usd_spent: "0", paused_until: future },
            error: null,
        });
        const r = await checkBudget("ap-agent");
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe("paused");
    });

    it("treats period start in a previous month as effectively-zero spent", async () => {
        const lastYear = new Date();
        lastYear.setUTCMonth(lastYear.getUTCMonth() - 2);
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { monthly_usd_cap: "50.00", current_period_start: lastYear.toISOString(), current_period_usd_spent: "999.00", paused_until: null },
            error: null,
        });
        const r = await checkBudget("ap-agent");
        expect(r.allowed).toBe(true); // month rolled over — old spent ignored
        expect(r.spentUsd).toBe(0);
    });

    it("returns allowed='unknown' for an unknown agent (best-effort)", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
        const r = await checkBudget("unknown-agent");
        expect(r.allowed).toBe(true);
        expect(r.reason).toBe("unknown");
    });

    it("returns allowed='unknown' on DB error (never blocks calls)", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "DB down" } });
        const r = await checkBudget("ap-agent");
        expect(r.allowed).toBe(true);
        expect(r.reason).toBe("unknown");
    });
});

describe("assertBudget", () => {
    it("throws BudgetExceededError when refused", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { monthly_usd_cap: "50.00", current_period_start: new Date().toISOString(), current_period_usd_spent: "60.00", paused_until: null },
            error: null,
        });
        await expect(assertBudget("ap-agent")).rejects.toBeInstanceOf(BudgetExceededError);
    });

    it("returns silently when allowed", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { monthly_usd_cap: "50.00", current_period_start: new Date().toISOString(), current_period_usd_spent: "10.00", paused_until: null },
            error: null,
        });
        await expect(assertBudget("ap-agent")).resolves.toBeUndefined();
    });
});

describe("chargeBudget", () => {
    it("inserts a new row for an unknown agent", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
        await chargeBudget("brand-new-agent", "gpt-4o", 100, 200);
        expect(supabaseMock.insert).toHaveBeenCalledTimes(1);
        const insertArgs = supabaseMock.insert.mock.calls[0][0];
        expect(insertArgs.agent_id).toBe("brand-new-agent");
        expect(insertArgs.current_period_tokens_spent).toBe(300);
    });

    it("rolls over the period when the stored start is from a previous month", async () => {
        const lastMonth = new Date();
        lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { current_period_start: lastMonth.toISOString(), current_period_usd_spent: "999.99", current_period_tokens_spent: 9999999 },
            error: null,
        });
        await chargeBudget("ap-agent", "gpt-4o", 100, 200);
        const updateArgs = supabaseMock.update.mock.calls[0][0];
        // After rollover, spent should equal JUST this call's cost (not accumulated).
        expect(updateArgs.current_period_usd_spent).toBeGreaterThan(0);
        expect(updateArgs.current_period_usd_spent).toBeLessThan(1);
        expect(updateArgs.current_period_tokens_spent).toBe(300);
        expect(updateArgs.paused_until).toBeNull();
    });

    it("increments same-period spent + tokens", async () => {
        supabaseMock.maybeSingle.mockResolvedValueOnce({
            data: { current_period_start: new Date().toISOString(), current_period_usd_spent: "5.00", current_period_tokens_spent: 1000 },
            error: null,
        });
        await chargeBudget("ap-agent", "gpt-4o-mini", 1000, 500);
        const updateArgs = supabaseMock.update.mock.calls[0][0];
        // gpt-4o-mini @ 0.0008 / 1k tokens × 1500 tokens = $0.0012 added
        expect(updateArgs.current_period_usd_spent).toBeCloseTo(5.0012, 4);
        expect(updateArgs.current_period_tokens_spent).toBe(2500);
    });
});
