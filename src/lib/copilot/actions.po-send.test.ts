import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftPOReview } from "../finale/client";

// commitAndSendPO contains a real 8s setTimeout for post-send Finale verification —
// the default 5s testTimeout reliably flakes the success-path test.
vi.setConfig({ testTimeout: 15000 });

const {
    sessionRows,
    commitDraftPOMock,
    sendPurchaseOrderEmailMock,
    gmailSendMock,
    createClientMock,
    upsertFromSourceMock,
    updateBySourceMock,
} = vi.hoisted(() => {
    const sessionRows = new Map<string, any>();
    const commitDraftPOMock = vi.fn().mockResolvedValue(undefined);
    const sendPurchaseOrderEmailMock = vi.fn().mockResolvedValue({
        orderId: "PO-1001",
        sent: true,
        pdfAttached: true,
        actionUrl: "/buildasoil/api/order/PO-1001/action/emailPurchaseOrder",
    });
    const gmailSendMock = vi.fn().mockResolvedValue({ data: { id: "gmail-1" } });
    const upsertFromSourceMock = vi.fn().mockResolvedValue("task-1");
    const updateBySourceMock = vi.fn().mockResolvedValue(undefined);

    const createClientMock = vi.fn(() => ({
        from(table: string) {
            if (table === "copilot_action_sessions") {
                return {
                    upsert: async (row: any) => {
                        sessionRows.set(row.session_id, { ...row });
                        return { data: row, error: null };
                    },
                    select: () => ({
                        eq: (_field: string, value: string) => ({
                            maybeSingle: async () => ({
                                data: sessionRows.get(value) ?? null,
                                error: null,
                            }),
                        }),
                    }),
                    update: (values: any) => ({
                        eq: async (_field: string, value: string) => {
                            const row = sessionRows.get(value);
                            if (row) {
                                sessionRows.set(value, { ...row, ...values });
                            }
                            return { data: row ? [{ ...row, ...values }] : [], error: null };
                        },
                    }),
                };
            }

            if (table === "po_sends") {
                return {
                    select: () => ({
                        eq: (_field: string, value: string) => ({
                            order: () => ({
                                limit: () => ({
                                    maybeSingle: async () => ({
                                        data: value === "PO-ALREADY-SENT"
                                            ? { po_number: value, sent_at: "2026-05-01T12:00:00.000Z" }
                                            : null,
                                        error: null,
                                    }),
                                }),
                            }),
                        }),
                    }),
                    insert: async (_row: any) => ({ data: null, error: null }),
                };
            }

            if (table === "ap_activity_log") {
                return {
                    insert: async (_row: any) => ({ data: null, error: null }),
                };
            }

            return {
                insert: async (_row: any) => ({ data: null, error: null }),
                upsert: async (_row: any, _options?: any) => ({ data: null, error: null }),
            };
        },
    }));

    return {
        sessionRows,
        commitDraftPOMock,
        sendPurchaseOrderEmailMock,
        gmailSendMock,
        createClientMock,
        upsertFromSourceMock,
        updateBySourceMock,
    };
});

vi.mock("../supabase", () => ({
    createClient: createClientMock,
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: {
                send: gmailSendMock,
            },
        },
    })),
}));

vi.mock("../finale/client", () => ({
    FinaleClient: class FinaleClient {
        commitDraftPO = commitDraftPOMock;
        sendPurchaseOrderEmail = sendPurchaseOrderEmailMock;
    },
}));

vi.mock("../intelligence/agent-task", () => ({
    upsertFromSource: upsertFromSourceMock,
    updateBySource: updateBySourceMock,
}));

import { executePOSendAction } from "./actions";
import {
    clearPendingPOSendCache,
    generatePOEmailBody,
    getPendingPOSend,
    storePendingPOSend,
} from "../purchasing/po-sender";

function makeReview(orderId = "PO-1001"): DraftPOReview {
    return {
        orderId,
        vendorName: "ULINE",
        vendorPartyId: "vendor-1",
        orderDate: "2026-03-26",
        total: 199.5,
        items: [
            {
                productId: "S-4551",
                productName: "Corrugated Boxes",
                quantity: 90,
                unitPrice: 3.33,
                lineTotal: 299.7,
            },
        ],
        finaleUrl: "https://finale.example/po/PO-1001",
        canCommit: true,
    };
}

describe("PO send actions", () => {
    beforeEach(() => {
        sessionRows.clear();
        vi.clearAllMocks();
        commitDraftPOMock.mockResolvedValue(undefined);
        sendPurchaseOrderEmailMock.mockResolvedValue({
            orderId: "PO-1001",
            sent: true,
            pdfAttached: true,
            actionUrl: "/buildasoil/api/order/PO-1001/action/emailPurchaseOrder",
        });
        gmailSendMock.mockResolvedValue({ data: { id: "gmail-1" } });
        upsertFromSourceMock.mockResolvedValue("task-1");
        updateBySourceMock.mockResolvedValue(undefined);
        clearPendingPOSendCache();
    });

    it("restores a pending send session after cache clear", async () => {
        const sendId = await storePendingPOSend("PO-1001", makeReview(), "vendor@example.com", "vendor_profiles", {
            channel: "dashboard",
        });

        clearPendingPOSendCache();

        const restored = await getPendingPOSend(sendId);
        expect(restored?.orderId).toBe("PO-1001");
    });

    it("mirrors a pending PO send into the task hub and stores task_id on the spoke row", async () => {
        const sendId = await storePendingPOSend("PO-1001", makeReview(), "vendor@example.com", "vendor_profiles", {
            channel: "dashboard",
        });

        expect(upsertFromSourceMock).toHaveBeenCalledWith(expect.objectContaining({
            sourceTable: "copilot_action_sessions",
            sourceId: sendId,
            type: "po_send_confirm",
            status: "NEEDS_APPROVAL",
            owner: "will",
            requiresApproval: true,
        }));
        expect(sessionRows.get(sendId)?.task_id).toBe("task-1");
    });

    it("fails cleanly when the send session is expired", async () => {
        const sendId = await storePendingPOSend("PO-1002", makeReview("PO-1002"), "vendor@example.com", "vendor_profiles", {
            channel: "dashboard",
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });

        clearPendingPOSendCache();

        const result = await executePOSendAction({
            sendId,
            triggeredBy: "dashboard",
        });

        expect(result.status).toBe("failed");
        expect(result.userMessage).toMatch(/expired|start a new review/i);
        expect(updateBySourceMock).toHaveBeenCalledWith(
            "copilot_action_sessions",
            sendId,
            expect.objectContaining({ status: "EXPIRED" }),
        );
    });

    it("formats vendor PO email using the approved subject and concise body", () => {
        const email = generatePOEmailBody({
            ...makeReview("124790"),
            vendorName: "Clarke",
            orderDate: "2026-05-01",
        });

        expect(email.subject).toBe("BuildASoil PO # 124790 - Clarke - 5/1/2026");
        expect(email.body).toBe([
            "Hi Clarke,",
            "",
            "Please see our attached PO.",
            "",
            "Please acknowledge receipt and send ETA in this email thread.",
            "",
            "Thanks,",
            "",
            "BuildASoil Purchasing",
        ].join("\n"));
    });

    it("uses Finale native PO email so the PDF attachment is included", async () => {
        const sendId = await storePendingPOSend("PO-1003", makeReview("PO-1003"), "vendor@example.com", "vendor_profiles", {
            channel: "dashboard",
        });

        const result = await executePOSendAction({
            sendId,
            triggeredBy: "dashboard",
        });

        expect(result.status).toBe("success");
        expect(sendPurchaseOrderEmailMock).toHaveBeenCalledWith("PO-1003", expect.objectContaining({
            toEmail: "vendor@example.com",
            subject: "BuildASoil PO # PO-1003 - ULINE - 3/26/2026",
            body: expect.stringContaining("Please see our attached PO."),
        }));
        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(result.details).toMatchObject({
            finaleEmailSent: true,
            pdfAttached: true,
            emailSkipped: false,
        });
        expect(updateBySourceMock).toHaveBeenCalledWith(
            "copilot_action_sessions",
            sendId,
            expect.objectContaining({ status: "SUCCEEDED" }),
        );
    });

    it("returns partial_success when Finale commits but the native PO email action is unavailable", async () => {
        sendPurchaseOrderEmailMock.mockRejectedValueOnce(new Error("Finale native PO email action was not available"));
        const sendId = await storePendingPOSend("PO-1004", makeReview("PO-1004"), "vendor@example.com", "vendor_profiles", {
            channel: "dashboard",
        });

        const result = await executePOSendAction({
            sendId,
            triggeredBy: "dashboard",
        });

        // Finale commit cannot be rolled back — partial_success surfaces the email failure
        // with full context (emailError + attempted recipient) so Will can act.
        expect(result.status).toBe("partial_success");
        expect(result.userMessage).toMatch(/Finale native PO email action/i);
        expect((result.details as any)?.emailError).toMatch(/Finale native PO email action/i);
        expect((result.details as any)?.verification?.issues ?? []).toEqual(
            expect.arrayContaining([expect.stringMatching(/email send failed.*Finale native PO email action/i)]),
        );
        expect(gmailSendMock).not.toHaveBeenCalled();
    });

    it("blocks duplicate vendor emails when a PO has already been sent", async () => {
        const sendId = await storePendingPOSend(
            "PO-ALREADY-SENT",
            makeReview("PO-ALREADY-SENT"),
            "vendor@example.com",
            "vendor_profiles",
            { channel: "dashboard" },
        );

        const result = await executePOSendAction({
            sendId,
            triggeredBy: "dashboard",
        });

        expect(result.status).toBe("failed");
        expect(result.userMessage).toMatch(/already sent/i);
        expect(commitDraftPOMock).not.toHaveBeenCalled();
        expect(sendPurchaseOrderEmailMock).not.toHaveBeenCalled();
        expect(gmailSendMock).not.toHaveBeenCalled();
    });
});
