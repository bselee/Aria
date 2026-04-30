import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock supabase before importing the module under test.
const supabaseMock: any = {
    from: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    select: vi.fn(),
    single: vi.fn(),
};

function resetChain() {
    supabaseMock.from.mockReturnValue(supabaseMock);
    supabaseMock.update.mockReturnValue(supabaseMock);
    supabaseMock.eq.mockReturnValue(supabaseMock);
    supabaseMock.select.mockReturnValue(supabaseMock);
}

vi.mock("@/lib/supabase", () => ({ createClient: () => supabaseMock }));

import {
    getIssueControlProfile,
    patchIssueControlProfile,
    defaultIssueControlMode,
} from "./issue-control";

beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
});

describe("defaultIssueControlMode", () => {
    it("defaults human-approval-required blocked issues to act_with_approval", () => {
        expect(defaultIssueControlMode({
            lifecycle_state: "blocked",
            blocker_reason: "human_approval_required",
            owner: "will",
            source_table: "ap_pending_approvals",
        } as any)).toBe("act_with_approval");
    });

    it("defaults policy_required blockers to act_with_approval too", () => {
        expect(defaultIssueControlMode({
            lifecycle_state: "blocked",
            blocker_reason: "policy_required",
            owner: "aria",
            source_table: null,
        } as any)).toBe("act_with_approval");
    });

    it("defaults will-owned issues (not blocked) to suggest", () => {
        expect(defaultIssueControlMode({
            lifecycle_state: "working",
            blocker_reason: null,
            owner: "will",
            source_table: null,
        } as any)).toBe("suggest");
    });

    it("defaults AP-source issues to act_with_approval (write-path safety)", () => {
        expect(defaultIssueControlMode({
            lifecycle_state: "working",
            blocker_reason: null,
            owner: "aria",
            source_table: "ap_pending_approvals",
        } as any)).toBe("act_with_approval");
    });

    it("blocked issues without an approval reason fall back to suggest", () => {
        expect(defaultIssueControlMode({
            lifecycle_state: "blocked",
            blocker_reason: "po_not_found",
            owner: "aria",
            source_table: "gmail_messages",
        } as any)).toBe("suggest");
    });

    it("unknown sources default to observe_only (safest)", () => {
        expect(defaultIssueControlMode({
            lifecycle_state: "working",
            blocker_reason: null,
            owner: "aria",
            source_table: null,
        } as any)).toBe("observe_only");
    });
});

describe("getIssueControlProfile", () => {
    it("reads existing inputs.control without losing unrelated inputs", () => {
        const issue = {
            inputs: {
                vendor_name: "Axiom",
                control: { mode: "suggest", updatedAt: "2026-04-30T00:00:00.000Z" },
            },
            owner: "aria",
            updated_at: "2026-04-30T00:00:00.000Z",
        } as any;
        const profile = getIssueControlProfile(issue);
        expect(profile.mode).toBe("suggest");
        expect(profile.updatedAt).toBe("2026-04-30T00:00:00.000Z");
    });

    it("falls back to defaultIssueControlMode when no control object exists", () => {
        const issue = {
            inputs: {},
            lifecycle_state: "blocked",
            blocker_reason: "human_approval_required",
            owner: "will",
            source_table: "ap_pending_approvals",
            updated_at: "2026-04-30T00:00:00.000Z",
        } as any;
        expect(getIssueControlProfile(issue).mode).toBe("act_with_approval");
    });

    it("rejects invalid mode strings and falls back to default", () => {
        const issue = {
            inputs: { control: { mode: "garbage", updatedAt: "now" } },
            lifecycle_state: "working",
            owner: "will",
            source_table: null,
            updated_at: "2026-04-30T00:00:00.000Z",
        } as any;
        expect(getIssueControlProfile(issue).mode).toBe("suggest"); // owner=will default
    });

    it("preserves paused / assignedBy / reason when present", () => {
        const issue = {
            inputs: {
                control: {
                    mode: "autonomous",
                    paused: true,
                    assignedBy: "will-telegram",
                    reason: "investigating spike",
                    updatedAt: "2026-04-30T01:23:45.000Z",
                },
            },
            owner: "aria",
            updated_at: "2026-04-30T00:00:00.000Z",
        } as any;
        const p = getIssueControlProfile(issue);
        expect(p.mode).toBe("autonomous");
        expect(p.paused).toBe(true);
        expect(p.assignedBy).toBe("will-telegram");
        expect(p.reason).toBe("investigating spike");
    });
});

describe("patchIssueControlProfile", () => {
    it("patches control while preserving unrelated inputs (vendor_name etc)", async () => {
        const issue = {
            id: "iss-1",
            inputs: {
                vendor_name: "Axiom",
                invoice_number: "INV-1",
                control: { mode: "suggest", updatedAt: "2026-04-30T00:00:00.000Z" },
            },
            owner: "will",
            updated_at: "2026-04-30T00:00:00.000Z",
        } as any;
        supabaseMock.single.mockResolvedValueOnce({ data: { ...issue, inputs: { ...issue.inputs, control: { mode: "act_with_approval", updatedAt: "stub" } } }, error: null });

        await patchIssueControlProfile(issue, { mode: "act_with_approval", reason: "Will requested manual gate" });

        expect(supabaseMock.update).toHaveBeenCalledTimes(1);
        const updateArg = supabaseMock.update.mock.calls[0][0];
        // Critical: inputs preserved, control patched, updated_at refreshed.
        expect(updateArg.inputs.vendor_name).toBe("Axiom");
        expect(updateArg.inputs.invoice_number).toBe("INV-1");
        expect(updateArg.inputs.control.mode).toBe("act_with_approval");
        expect(updateArg.inputs.control.reason).toBe("Will requested manual gate");
        expect(updateArg.inputs.control.updatedAt).toBeTruthy();
        expect(updateArg.updated_at).toBeTruthy();
    });

    it("returns null when supabase is unavailable (best-effort contract)", async () => {
        const issue = { id: "iss-1", inputs: {}, owner: "aria", updated_at: "now" } as any;
        // Force createClient to return null for this call.
        const orig = (supabaseMock as any).from;
        (supabaseMock as any).from = vi.fn().mockReturnValue(supabaseMock);
        // Pretend update returns an error
        supabaseMock.single.mockResolvedValueOnce({ data: null, error: { message: "DB down" } });
        const result = await patchIssueControlProfile(issue, { mode: "observe_only" });
        expect(result).toBeNull();
        (supabaseMock as any).from = orig;
    });
});
