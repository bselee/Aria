import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailGetMock,
    unifiedObjectGenerationMock,
    upsertShipmentEvidenceMock,
    queueState,
    purchaseOrdersState,
} = vi.hoisted(() => ({
    gmailGetMock: vi.fn(),
    unifiedObjectGenerationMock: vi.fn(),
    upsertShipmentEvidenceMock: vi.fn(),
    queueState: {
        messages: [] as Array<Record<string, any>>,
        updates: [] as Array<Record<string, any>>,
    },
    purchaseOrdersState: {
        rows: [] as Array<Record<string, any>>,
    },
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: {
                get: gmailGetMock,
            },
        },
    })),
}));

vi.mock("./llm", () => ({
    unifiedObjectGeneration: unifiedObjectGenerationMock,
}));

vi.mock("../tracking/shipment-intelligence", () => ({
    upsertShipmentEvidence: upsertShipmentEvidenceMock,
}));

vi.mock("../pdf/extractor", () => ({
    extractPDF: vi.fn().mockResolvedValue({ rawText: "" }),
}));

vi.mock("../supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "email_inbox_queue") {
                return {
                    select: () => ({
                        eq: () => ({
                            limit: async () => ({ data: queueState.messages, error: null }),
                        }),
                    }),
                    update: (values: Record<string, unknown>) => ({
                        eq: async (column: string, value: unknown) => {
                            queueState.updates.push({ values, column, value });
                            return { data: null, error: null };
                        },
                    }),
                };
            }

            if (table === "purchase_orders") {
                return {
                    select: () => ({
                        gte: () => ({
                            limit: async () => ({ data: purchaseOrdersState.rows, error: null }),
                        }),
                    }),
                };
            }

            throw new Error(`Unexpected table ${table}`);
        },
    })),
}));

import { TrackingAgent } from "./tracking-agent";

function encodeBody(text: string) {
    return Buffer.from(text, "utf8").toString("base64");
}

describe("TrackingAgent", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queueState.messages = [];
        queueState.updates = [];
        purchaseOrdersState.rows = [];
        unifiedObjectGenerationMock.mockResolvedValue({ poNumber: null });
        upsertShipmentEvidenceMock.mockImplementation(async (input: { trackingNumber: string }) => ({
            tracking_number: input.trackingNumber,
        }));
    });

    it("correlates a ShipStation tracking email to the vendor's only recent warehouse PO", async () => {
        queueState.messages = [
            {
                id: 1,
                gmail_message_id: "gmail-thirsty-earth",
                from_email: "tracking@shipstation.com",
                subject: "Your order has been shipped!",
                body_snippet: "Thank you for your order from Thirsty Earth! order (#19457) shipped via FedEx.",
                source_inbox: "default",
            },
        ];

        purchaseOrdersState.rows = [
            {
                po_number: "124503",
                vendor_name: "Thirsty Earth",
                created_at: "2026-03-27T19:29:31.000Z",
            },
        ];

        gmailGetMock.mockResolvedValue({
            data: {
                payload: {
                    body: {
                        data: encodeBody(
                            "Dear Jeremy Silva, Thank you for your order from Thirsty Earth! " +
                            "Your order (#19457) was shipped via FedEx Ground. " +
                            "Track Your Shipment: 8051904063"
                        ),
                    },
                },
            },
        });

        const result = await new TrackingAgent().processUnreadEmails();

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(expect.objectContaining({
            poNumber: "124503",
            trackingNumber: "8051904063",
            source: "email_tracking",
            sourceRef: "gmail-thirsty-earth",
        }));
        expect(result).toEqual([
            { poNumber: "124503", trackingNumbers: ["8051904063"] },
        ]);
    });

    it("matches dropship tracking only when the embedded order id maps to the dropship PO prefix", async () => {
        queueState.messages = [
            {
                id: 2,
                gmail_message_id: "gmail-autopot",
                from_email: "quickbooks@notification.intuit.com",
                subject: "New payment request from AutoPot USA - Invoice APUS-243996",
                body_snippet: "23371057 UPS - 1Z22YV580360436423",
                source_inbox: "default",
            },
        ];

        purchaseOrdersState.rows = [
            {
                po_number: "23371057-DropshipPO",
                vendor_name: "AutoPot USA",
                created_at: "2026-04-01T19:00:00.000Z",
            },
            {
                po_number: "23371687-DropshipPO",
                vendor_name: "AutoPot USA",
                created_at: "2026-04-01T19:10:00.000Z",
            },
        ];

        gmailGetMock.mockResolvedValue({
            data: {
                payload: {
                    body: {
                        data: encodeBody(
                            "Your invoice is ready! 23371057 UPS - 1Z22YV580360436423"
                        ),
                    },
                },
            },
        });

        const result = await new TrackingAgent().processUnreadEmails();

        expect(upsertShipmentEvidenceMock).toHaveBeenCalledWith(expect.objectContaining({
            poNumber: "23371057-DropshipPO",
            trackingNumber: "1Z22YV580360436423",
        }));
        expect(result).toEqual([
            { poNumber: "23371057-DropshipPO", trackingNumbers: ["1Z22YV580360436423"] },
        ]);
    });
});
