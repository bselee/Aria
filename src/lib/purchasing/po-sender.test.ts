import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftPOReview } from "../finale/client";

const {
    sessionRows,
    poSendRows,
    purchaseOrderRows,
    commitDraftPOMock,
    gmailSendMock,
    createClientMock,
} = vi.hoisted(() => {
    const sessionRows = new Map<string, any>();
    const poSendRows: any[] = [];
    const purchaseOrderRows = new Map<string, any>();
    const commitDraftPOMock = vi.fn().mockResolvedValue(undefined);
    const gmailSendMock = vi.fn().mockResolvedValue({ data: { id: "gmail-42" } });

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
                            if (row) sessionRows.set(value, { ...row, ...values });
                            return { data: row ? [{ ...row, ...values }] : [], error: null };
                        },
                    }),
                };
            }

            if (table === "po_sends") {
                return {
                    insert: async (row: any) => {
                        poSendRows.push(row);
                        return { data: row, error: null };
                    },
                };
            }

            if (table === "purchase_orders") {
                return {
                    upsert: async (row: any) => {
                        purchaseOrderRows.set(row.po_number, { ...(purchaseOrderRows.get(row.po_number) || {}), ...row });
                        return { data: row, error: null };
                    },
                };
            }

            return {
                insert: async (_row: any) => ({ data: null, error: null }),
            };
        },
    }));

    return {
        sessionRows,
        poSendRows,
        purchaseOrderRows,
        commitDraftPOMock,
        gmailSendMock,
        createClientMock,
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
    },
}));

import { commitAndSendPO, clearPendingPOSendCache, storePendingPOSend } from "./po-sender";

function makeReview(orderId = "PO-2001"): DraftPOReview {
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
        finaleUrl: "https://finale.example/po/PO-2001",
        canCommit: true,
    };
}

describe("commitAndSendPO", () => {
    beforeEach(() => {
        sessionRows.clear();
        poSendRows.length = 0;
        purchaseOrderRows.clear();
        vi.clearAllMocks();
        commitDraftPOMock.mockResolvedValue(undefined);
        gmailSendMock.mockResolvedValue({ data: { id: "gmail-42" } });
        clearPendingPOSendCache();
    });

    it("persists commit/send lifecycle evidence onto purchase_orders", async () => {
        const sendId = await storePendingPOSend("PO-2001", makeReview(), "vendor@example.com", "vendor_profiles");

        const result = await commitAndSendPO(sendId, "dashboard");

        expect(result.orderId).toBe("PO-2001");
        expect(poSendRows[0]).toEqual(expect.objectContaining({
            po_number: "PO-2001",
            committed_at: expect.any(String),
            sent_at: expect.any(String),
            gmail_message_id: "gmail-42",
        }));
        expect(purchaseOrderRows.get("PO-2001")).toEqual(expect.objectContaining({
            po_number: "PO-2001",
            vendor_name: "ULINE",
            po_email_message_id: "gmail-42",
            lifecycle_stage: "sent",
        }));
    });
});
