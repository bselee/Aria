import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    gmailListMock,
    gmailThreadsGetMock,
    gmailMessagesGetMock,
    gmailSendMock,
    purchaseOrderRows,
    vendorProfileRows,
    outsideThreadAlerts,
    searchMessages,
    outsideThreadMessages,
    threadById,
    metadataByMessageId,
    indexOperationalContextMock,
    upsertShipmentEvidenceMock,
} = vi.hoisted(() => ({
    gmailListMock: vi.fn(),
    gmailThreadsGetMock: vi.fn(),
    gmailMessagesGetMock: vi.fn(),
    gmailSendMock: vi.fn(),
    purchaseOrderRows: new Map<string, Record<string, any>>(),
    vendorProfileRows: new Map<string, Record<string, any>>(),
    outsideThreadAlerts: new Map<string, Record<string, any>>(),
    searchMessages: [] as Array<Record<string, any>>,
    outsideThreadMessages: [] as Array<Record<string, any>>,
    threadById: new Map<string, Record<string, any>>(),
    metadataByMessageId: new Map<string, Record<string, any>>(),
    indexOperationalContextMock: vi.fn(),
    upsertShipmentEvidenceMock: vi.fn(),
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: {
                list: gmailListMock,
                get: gmailMessagesGetMock,
                send: gmailSendMock,
            },
            threads: {
                get: gmailThreadsGetMock,
            },
        },
    })),
}));

vi.mock("../supabase", () => ({
    createClient: vi.fn(() => ({
        from: (table: string) => {
            if (table === "purchase_orders") {
                return {
                    select: () => ({
                        eq: (_column: string, value: string) => ({
                            maybeSingle: async () => ({ data: purchaseOrderRows.get(value) || null, error: null }),
                        }),
                    }),
                    upsert: async (row: Record<string, any>) => {
                        purchaseOrderRows.set(row.po_number, { ...(purchaseOrderRows.get(row.po_number) || {}), ...row });
                        return { data: row, error: null };
                    },
                };
            }

            if (table === "vendor_profiles") {
                return {
                    select: () => ({
                        eq: (_column: string, value: string) => ({
                            maybeSingle: async () => ({ data: vendorProfileRows.get(value) || null, error: null }),
                        }),
                    }),
                    upsert: async (row: Record<string, any>) => {
                        vendorProfileRows.set(row.vendor_name, { ...(vendorProfileRows.get(row.vendor_name) || {}), ...row });
                        return { data: row, error: null };
                    },
                };
            }

            if (table === "outside_thread_alerts") {
                return {
                    upsert: async (row: Record<string, any>) => {
                        outsideThreadAlerts.set(row.gmail_message_id, row);
                        return { data: row, error: null };
                    },
                };
            }

            throw new Error(`Unexpected table ${table}`);
        },
    })),
}));

vi.mock("./pinecone", () => ({
    indexOperationalContext: indexOperationalContextMock,
}));

vi.mock("../tracking/shipment-intelligence", () => ({
    upsertShipmentEvidence: upsertShipmentEvidenceMock,
    listShipmentsForPurchaseOrders: vi.fn(),
}));

vi.mock("../finale/client", () => ({
    finaleClient: {
        getPOLineItems: vi.fn().mockResolvedValue(null),
    },
    FinaleClient: class { },
}));

vi.mock("../carriers/tracking-service", () => ({
    TRACKING_PATTERNS: {
        ups: /1Z[A-Z0-9]{16}/g,
        fedex: /\b\d{12,15}\b/g,
        generic: /\bTRACKING-([A-Z0-9-]+)\b/g,
        pro: /\bPRO-([A-Z0-9-]+)\b/g,
        bol: /\bBOL-([A-Z0-9-]+)\b/g,
    },
    detectLTLCarrier: vi.fn().mockReturnValue(null),
    getTrackingStatus: vi.fn().mockResolvedValue(null),
    carrierUrl: vi.fn((tracking: string) => `https://carrier.test/${tracking}`),
    buildFollowUpEmail: vi.fn(() => "raw-follow-up-email"),
    isFedExNumber: vi.fn().mockReturnValue(false),
}));

vi.mock("./ap-agent", () => ({ APAgent: class { constructor() { } } }));
vi.mock("./workers/ap-identifier", () => ({ APIdentifierAgent: class { constructor() { } } }));
vi.mock("./workers/email-ingestion", () => ({ EmailIngestionWorker: class { constructor() { } } }));
vi.mock("./workers/ap-forwarder", () => ({ APForwarderAgent: class { constructor() { } } }));
vi.mock("./tracking-agent", () => ({ TrackingAgent: class { constructor() { } } }));
vi.mock("./acknowledgement-agent", () => ({ AcknowledgementAgent: class { constructor() { } } }));
vi.mock("./supervisor-agent", () => ({ SupervisorAgent: class { constructor() { } } }));

import { OpsManager } from "./ops-manager";

function encodeBody(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}

function buildThreadMessage(input: {
    internalDate: string;
    subject?: string;
    to?: string;
    from?: string;
    messageId?: string;
    snippet?: string;
    bodyText?: string;
}): Record<string, any> {
    const headers = [
        { name: "Subject", value: input.subject || "BuildASoil PO # 124564 - JABB of the Carolinas, Inc. - 4/1/2026" },
        { name: "To", value: input.to || "JABB <barends@jabbspe.com>" },
        { name: "From", value: input.from || "Bill Selee <bill.selee@buildasoil.com>" },
        { name: "Message-ID", value: input.messageId || "<msg-1>" },
    ];

    return {
        internalDate: input.internalDate,
        snippet: input.snippet || "",
        payload: {
            headers,
            body: input.bodyText ? { data: encodeBody(input.bodyText) } : {},
        },
    };
}

describe("OpsManager.syncPOConversations", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        purchaseOrderRows.clear();
        vendorProfileRows.clear();
        outsideThreadAlerts.clear();
        searchMessages.length = 0;
        outsideThreadMessages.length = 0;
        threadById.clear();
        metadataByMessageId.clear();

        gmailListMock.mockImplementation(async ({ q }: { q: string }) => {
            if (q.startsWith("label:PO")) {
                return { data: { messages: searchMessages } };
            }

            if (q.startsWith("from:")) {
                return { data: { messages: outsideThreadMessages } };
            }

            return { data: { messages: [] } };
        });

        gmailThreadsGetMock.mockImplementation(async ({ id }: { id: string }) => ({
            data: threadById.get(id) || { messages: [] },
        }));

        gmailMessagesGetMock.mockImplementation(async ({ id }: { id: string }) => ({
            data: metadataByMessageId.get(id) || { snippet: "", payload: { headers: [] } },
        }));

        gmailSendMock.mockResolvedValue({ data: { id: "follow-up-1" } });
        indexOperationalContextMock.mockResolvedValue(undefined);
        upsertShipmentEvidenceMock.mockResolvedValue(null);
    });

    it("records vendor acknowledgement evidence on the first vendor reply", async () => {
        searchMessages.push({ id: "search-1", threadId: "thread-1" });
        threadById.set("thread-1", {
            id: "thread-1",
            messages: [
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-01T14:00:00Z").getTime()),
                }),
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-01T16:30:00Z").getTime()),
                    from: "Ben Arends <barends@jabbspe.com>",
                    messageId: "<msg-2>",
                    snippet: "Confirmed, thanks Bill.",
                    bodyText: "Confirmed, thanks Bill.",
                }),
            ],
        });

        const bot = { telegram: { sendMessage: vi.fn() } } as any;
        await new OpsManager(bot).syncPOConversations();

        const row = purchaseOrderRows.get("124564");
        expect(row?.vendor_acknowledged_at).toBe("2026-04-01T16:30:00.000Z");
        expect(row?.vendor_ack_source).toBe("po_thread:thread-1");
        expect(row?.lifecycle_stage).toBe("vendor_acknowledged");
    });

    it("creates trustworthy ETA evidence and advances the PO beyond broad in-transit", async () => {
        searchMessages.push({ id: "search-2", threadId: "thread-2" });
        threadById.set("thread-2", {
            id: "thread-2",
            messages: [
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-01T14:00:00Z").getTime()),
                }),
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-02T17:00:00Z").getTime()),
                    from: "Ben Arends <barends@jabbspe.com>",
                    messageId: "<msg-eta>",
                    snippet: "This shipped today. ETA Monday, April 6.",
                    bodyText: "This shipped today. ETA Monday, April 6.",
                }),
            ],
        });

        const bot = { telegram: { sendMessage: vi.fn() } } as any;
        await new OpsManager(bot).syncPOConversations();

        const row = purchaseOrderRows.get("124564");
        expect(row?.shipping_evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: "vendor_eta",
                source: "po_thread:thread-2",
                trustworthyTracking: true,
            }),
        ]));
        expect(row?.lifecycle_stage).toBe("moving_with_tracking");
    });

    it("requests tracking after the threshold when shipment evidence exists but no trustworthy tracking was found", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));

        searchMessages.push({ id: "search-3", threadId: "thread-3" });
        threadById.set("thread-3", {
            id: "thread-3",
            messages: [
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-01T14:00:00Z").getTime()),
                }),
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-04T18:00:00Z").getTime()),
                    from: "Ben Arends <barends@jabbspe.com>",
                    messageId: "<msg-shipped>",
                    snippet: "This freight shipment left Friday.",
                    bodyText: "This freight shipment left Friday.",
                }),
            ],
        });

        const bot = { telegram: { sendMessage: vi.fn() } } as any;
        await new OpsManager(bot).syncPOConversations();

        const row = purchaseOrderRows.get("124564");
        expect(gmailSendMock).toHaveBeenCalledTimes(1);
        expect(row?.tracking_requested_at).toBe("2026-04-09T12:00:00.000Z");
        expect(row?.tracking_request_count).toBe(1);
        expect(row?.tracking_unavailable_at).toBe("2026-04-09T12:00:00.000Z");
        expect(row?.lifecycle_stage).toBe("tracking_unavailable");
    });

    it("suppresses automated follow-up when the vendor already communicated outside the PO thread", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));

        searchMessages.push({ id: "search-4", threadId: "thread-4" });
        threadById.set("thread-4", {
            id: "thread-4",
            messages: [
                buildThreadMessage({
                    internalDate: String(new Date("2026-04-01T14:00:00Z").getTime()),
                }),
            ],
        });

        outsideThreadMessages.push({ id: "outside-1", threadId: "outside-thread-1" });
        metadataByMessageId.set("outside-1", {
            snippet: "Checking in on the order from last week.",
            payload: {
                headers: [{ name: "Subject", value: "Order update" }],
            },
        });

        const bot = { telegram: { sendMessage: vi.fn() } } as any;
        await new OpsManager(bot).syncPOConversations();

        const row = purchaseOrderRows.get("124564");
        expect(gmailSendMock).not.toHaveBeenCalled();
        expect(row?.tracking_requested_at).toBeUndefined();
    });
});
