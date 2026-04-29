import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the underlying agent-issue module so these tests stay focused on
// ap-issue's responsibilities (key derivation, defaulting, best-effort wrap).
// vi.hoisted runs BEFORE vi.mock's hoisted call so the factory can close
// over the spies safely.
const mocks = vi.hoisted(() => ({
    createOrAdvance: vi.fn(),
    recordHandoff: vi.fn(),
    setBlocker: vi.fn(),
    clearBlocker: vi.fn(),
    complete: vi.fn(),
    linkTask: vi.fn(),
    listIssues: vi.fn(),
    getByBusinessFlowKey: vi.fn(),
}));

vi.mock("./agent-issue", () => mocks);

import {
    apIssueKey,
    apFlowInputs,
    ensureApIssue,
    findApIssue,
    recordApHandoff,
    blockApIssue,
    unblockApIssue,
    completeApIssue,
    linkApTask,
    HANDLER,
    HANDOFF_REASON,
} from "./ap-issue";

describe("apIssueKey", () => {
    it("prefers vendor|inv:<n> when both vendor and invoice are present", () => {
        expect(apIssueKey({ vendorName: "Colorado Worm Co.", invoiceNumber: "124618", poNumber: "PO123" }))
            .toBe("colorado-worm-co.|inv:124618");
    });

    it("falls back to vendor|po:<n> when invoice is missing", () => {
        expect(apIssueKey({ vendorName: "ULINE", poNumber: "U-9012" }))
            .toBe("uline|po:U-9012");
    });

    it("falls back to vendor|ord:<n> when only orderId is known", () => {
        expect(apIssueKey({ vendorName: "Riceland Foods", orderId: "ORD-7" }))
            .toBe("riceland-foods|ord:ORD-7");
    });

    it("falls back to gmail_messages:<id> when vendor is unknown", () => {
        expect(apIssueKey({ gmailMessageId: "abc123" })).toBe("gmail_messages:abc123");
    });

    it("returns null when nothing identifies the flow", () => {
        expect(apIssueKey({})).toBeNull();
    });

    it("uses the same key shape projection's businessFlowKey() produces", async () => {
        // Both call sites must collide on the same key for the same logical flow.
        const { keyFromFields } = await import("./issue-projection");
        const args = { vendorName: "TeraGanix", invoiceNumber: "INV-44" };
        expect(apIssueKey(args)).toBe(keyFromFields(args));
    });
});

describe("ensureApIssue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("calls createOrAdvance with derived key + AP defaults and returns the issue id", async () => {
        mocks.createOrAdvance.mockResolvedValueOnce({ id: "iss-1" });

        const id = await ensureApIssue({
            vendorName: "Colorado Worm Co.",
            invoiceNumber: "124618",
            handler: "ap-reconciler",
            inputs: { foo: "bar" },
        });

        expect(id).toBe("iss-1");
        expect(mocks.createOrAdvance).toHaveBeenCalledTimes(1);
        const args = mocks.createOrAdvance.mock.calls[0][0];
        expect(args.businessFlowKey).toBe("colorado-worm-co.|inv:124618");
        expect(args.title).toBe("Invoice 124618 from Colorado Worm Co.");
        expect(args.lifecycleState).toBe("working");
        expect(args.currentHandler).toBe("ap-reconciler");
        expect(args.inputs).toEqual({ foo: "bar" });
    });

    it("returns null when no key can be derived (no vendor, no message id)", async () => {
        const id = await ensureApIssue({});
        expect(id).toBeNull();
        expect(mocks.createOrAdvance).not.toHaveBeenCalled();
    });

    it("swallows underlying errors and returns null (best-effort contract)", async () => {
        mocks.createOrAdvance.mockRejectedValueOnce(new Error("DB exploded"));
        const id = await ensureApIssue({
            vendorName: "X",
            invoiceNumber: "1",
        });
        expect(id).toBeNull();
    });

    it("uses the explicit title when provided", async () => {
        mocks.createOrAdvance.mockResolvedValueOnce({ id: "iss-2" });
        await ensureApIssue({
            vendorName: "Y",
            invoiceNumber: "2",
            title: "Custom title",
        });
        expect(mocks.createOrAdvance.mock.calls[0][0].title).toBe("Custom title");
    });

    it("dropship fallback produces a sensible default title", async () => {
        mocks.createOrAdvance.mockResolvedValueOnce({ id: "iss-3" });
        await ensureApIssue({
            vendorName: "AutoPot",
            gmailMessageId: "msg-9",
        });
        const args = mocks.createOrAdvance.mock.calls[0][0];
        expect(args.businessFlowKey).toBe("gmail_messages:msg-9");
        expect(args.title).toBe("AutoPot email");
    });

    it("passes nextAction through so dashboard can show 'currently doing X'", async () => {
        mocks.createOrAdvance.mockResolvedValueOnce({ id: "iss-4" });
        await ensureApIssue({
            vendorName: "X",
            invoiceNumber: "1",
            nextAction: "Reconciling invoice against PO 124302",
        });
        expect(mocks.createOrAdvance.mock.calls[0][0].nextAction)
            .toBe("Reconciling invoice against PO 124302");
    });
});

describe("findApIssue", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses indexed getByBusinessFlowKey lookup (O(1), not a list scan)", async () => {
        mocks.getByBusinessFlowKey.mockResolvedValueOnce({ id: "iss-b" });
        const id = await findApIssue({
            vendorName: "Colorado Worm Co.",
            invoiceNumber: "124618",
        });
        expect(id).toBe("iss-b");
        expect(mocks.getByBusinessFlowKey).toHaveBeenCalledWith(
            "colorado-worm-co.|inv:124618",
            true, // onlyOpen by default
        );
        expect(mocks.listIssues).not.toHaveBeenCalled();
    });

    it("returns null when the index lookup misses", async () => {
        mocks.getByBusinessFlowKey.mockResolvedValueOnce(null);
        const id = await findApIssue({ vendorName: "X", invoiceNumber: "1" });
        expect(id).toBeNull();
    });

    it("returns null when key cannot be derived", async () => {
        const id = await findApIssue({});
        expect(id).toBeNull();
        expect(mocks.getByBusinessFlowKey).not.toHaveBeenCalled();
    });

    it("passes onlyOpen=false when caller opts to include closed issues", async () => {
        mocks.getByBusinessFlowKey.mockResolvedValueOnce({ id: "iss-c" });
        await findApIssue(
            { vendorName: "Y", invoiceNumber: "2" },
            { includeClosed: true },
        );
        expect(mocks.getByBusinessFlowKey).toHaveBeenCalledWith(
            "y|inv:2",
            false,
        );
    });
});

describe("apFlowInputs", () => {
    it("emits a stable canonical shape with nulls for missing fields", () => {
        const inputs = apFlowInputs({
            vendorName: "ULINE",
            invoiceNumber: "INV-1",
        });
        expect(inputs).toEqual({
            invoice_number: "INV-1",
            vendor_name: "ULINE",
            po_number: null,
            order_id: null,
            gmail_message_id: null,
        });
    });

    it("includes verdict + match_strategy only when provided", () => {
        expect(apFlowInputs({ vendorName: "X", verdict: "auto_approve" })).toMatchObject({
            verdict: "auto_approve",
        });
        expect(apFlowInputs({ vendorName: "X" })).not.toHaveProperty("verdict");
    });

    it("merges extras after the canonical fields", () => {
        const inputs = apFlowInputs({
            vendorName: "X",
            extras: { error: "boom", custom_flag: true },
        });
        expect(inputs.error).toBe("boom");
        expect(inputs.custom_flag).toBe(true);
        expect(inputs.vendor_name).toBe("X");
    });
});

describe("constants", () => {
    it("HANDLER values are stable strings", () => {
        expect(HANDLER.AP_AGENT).toBe("ap-agent");
        expect(HANDLER.AP_RECONCILER).toBe("ap-reconciler");
        expect(HANDLER.WILL).toBe("will");
    });

    it("HANDOFF_REASON values are stable strings", () => {
        expect(HANDOFF_REASON.NEEDS_APPROVAL_DASHBOARD).toBe("needs_approval — dashboard review");
        expect(HANDOFF_REASON.NEEDS_APPROVAL_TELEGRAM).toBe("needs_approval — Telegram");
    });
});

describe("best-effort wrappers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("recordApHandoff delegates to agent-issue.recordHandoff", async () => {
        await recordApHandoff("iss-1", "from-x", "to-y", "test reason");
        expect(mocks.recordHandoff).toHaveBeenCalledWith("iss-1", "from-x", "to-y", "test reason");
    });

    it("blockApIssue delegates to setBlocker", async () => {
        await blockApIssue("iss-1", "human_approval_required", "approve in TG");
        expect(mocks.setBlocker).toHaveBeenCalledWith(
            "iss-1",
            "human_approval_required",
            "approve in TG",
        );
    });

    it("unblockApIssue delegates to clearBlocker with default resume=working", async () => {
        await unblockApIssue("iss-1");
        expect(mocks.clearBlocker).toHaveBeenCalledWith("iss-1", "working");
    });

    it("completeApIssue delegates to complete with outputs", async () => {
        await completeApIssue("iss-1", { resolution: "approved" });
        expect(mocks.complete).toHaveBeenCalledWith("iss-1", { resolution: "approved" });
    });

    it("linkApTask delegates to linkTask", async () => {
        await linkApTask("task-1", "iss-1");
        expect(mocks.linkTask).toHaveBeenCalledWith("task-1", "iss-1");
    });

    it("all wrappers swallow underlying errors (never throw)", async () => {
        mocks.recordHandoff.mockRejectedValueOnce(new Error("nope"));
        mocks.setBlocker.mockRejectedValueOnce(new Error("nope"));
        mocks.clearBlocker.mockRejectedValueOnce(new Error("nope"));
        mocks.complete.mockRejectedValueOnce(new Error("nope"));
        mocks.linkTask.mockRejectedValueOnce(new Error("nope"));
        // None of these should reject:
        await expect(recordApHandoff("a", null, "b", "c")).resolves.toBeUndefined();
        await expect(blockApIssue("a", "unknown", "b")).resolves.toBeUndefined();
        await expect(unblockApIssue("a")).resolves.toBeUndefined();
        await expect(completeApIssue("a")).resolves.toBeUndefined();
        await expect(linkApTask("t", "i")).resolves.toBeUndefined();
    });
});
