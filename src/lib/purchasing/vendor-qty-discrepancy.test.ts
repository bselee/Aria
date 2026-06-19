/**
 * @file    vendor-qty-discrepancy.test.ts
 * @purpose Unit tests for the vendor QTY discrepancy handler.
 *          Tests scanning, dedup, email sending, reply detection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    runVendorQtyDiscrepancyHandler,
    type QtyDiscrepancyStats,
} from "./vendor-qty-discrepancy";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGmailMessagesSend = vi.fn();
const mockGmailMessagesGet = vi.fn();
const mockGmailMessagesList = vi.fn();
const mockGmailThreadsGet = vi.fn();

vi.mock("../supabase", () => ({
    createClient: vi.fn(),
}));

vi.mock("../gmail/auth", () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({
        // Mock OAuth2 client
    }),
}));

vi.mock("@googleapis/gmail", () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: {
                send: mockGmailMessagesSend,
                get: mockGmailMessagesGet,
                list: mockGmailMessagesList,
            },
            threads: {
                get: mockGmailThreadsGet,
            },
        },
    })),
}));

// Mock po-sender's lookupVendorOrderEmail
vi.mock("./po-sender", () => ({
    lookupVendorOrderEmail: vi.fn().mockResolvedValue({
        email: "vendor@example.com",
        source: "orders_email",
    }),
}));

// ── Helper: build a mock Supabase chain ────────────────────────────────────

function mockQuery(returns: any, insertedResult?: any) {
    const chain: any = {};
    chain.select = vi.fn().mockReturnThis();
    chain.eq = vi.fn().mockReturnThis();
    chain.in = vi.fn().mockReturnThis();
    chain.gte = vi.fn().mockReturnThis();
    chain.order = vi.fn().mockReturnThis();
    chain.or = vi.fn().mockReturnThis();
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    chain.single = vi.fn().mockResolvedValue(insertedResult ?? { data: { id: "log-id" }, error: null });
    chain.insert = vi.fn().mockReturnThis();
    chain.limit = vi.fn().mockResolvedValue(returns);
    return chain;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runVendorQtyDiscrepancyHandler", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Default Gmail mock: send succeeds, no threads found
        mockGmailMessagesSend.mockResolvedValue({
            data: { id: "gmail-msg-123", threadId: "thread-456" },
        });
        mockGmailMessagesGet.mockRejectedValue(new Error("not found"));
        mockGmailMessagesList.mockResolvedValue({ data: { messages: [] } });
        mockGmailThreadsGet.mockResolvedValue({
            data: { messages: [] },
        });
    });

    it("returns stats with zero counts when no discrepancies exist", async () => {
        const { createClient } = await import("../supabase");
        (createClient as any).mockReturnValue({
            from: vi.fn(() => mockQuery({ data: [], error: null })),
        });

        const stats = await runVendorQtyDiscrepancyHandler();
        expect(stats.scanned).toBe(0);
        expect(stats.emailed).toBe(0);
        expect(stats.resolved).toBe(0);
        expect(stats.errors).toBe(0);
    });

    it("scans and finds unresolved short_shipment_hold rows", async () => {
        const { createClient } = await import("../supabase");
        const shortShipmentRow = {
            id: "row-1",
            created_at: "2026-06-15T12:00:00Z",
            short_shipment_detected: true,
            short_shipment_lines: ["SKU001"],
            receiving_gap_total: 5,
            metadata: {
                orderId: "PO-001",
                invoiceNumber: "INV-001",
                vendorName: "Test Vendor",
                overallVerdict: "short_shipment_hold",
                priceChanges: [
                    {
                        productId: "SKU001",
                        description: "Test SKU",
                        poPrice: 10,
                        invoicePrice: 10,
                        quantity: 20,
                        receivedQty: 15,
                        receivingGap: 5,
                        verdict: "short_shipment_hold",
                        reason: "SHORT SHIPMENT: Invoice qty 20 > Received qty 15 (Gap: 5 units).",
                    },
                ],
                feeChanges: [],
                status: "pending",
                balanceCheck: { valid: true, gap: 0, message: "OK" },
            },
        };

        // Track which table queries are for to return different data
        (createClient as any).mockReturnValue({
            from: vi.fn((table: string) => {
                // All queries get the same mockQuery — we'll differentiate by table
                if (table === "ap_activity_log") {
                    const chain: any = {};
                    chain.select = vi.fn().mockReturnThis();
                    chain.eq = vi.fn().mockReturnThis();
                    chain.in = vi.fn().mockReturnThis();
                    chain.gte = vi.fn().mockReturnThis();
                    chain.order = vi.fn().mockReturnThis();
                    chain.or = vi.fn().mockReturnThis();
                    chain.maybeSingle = vi
                        .fn()
                        .mockResolvedValue({ data: null, error: null });
                    chain.single = vi
                        .fn()
                        .mockResolvedValue({ data: { id: "log-id" }, error: null });
                    chain.insert = vi.fn().mockReturnThis();

                    // limit returns different data based on intent set by chain.eq
                    let currentIntent = "";
                    const realEq = vi.fn((field: string, val: string) => {
                        if (field === "intent") currentIntent = val;
                        return chain;
                    });
                    chain.eq = realEq;

                    chain.limit = vi.fn(() => {
                        if (
                            currentIntent === "VENDOR_QTY_DISCREPANCY_EMAILED" ||
                            currentIntent === "VENDOR_QTY_DISCREPANCY_RESOLVED"
                        ) {
                            return Promise.resolve({ data: [], error: null });
                        }
                        // For RECONCILIATION short_shipment query
                        return Promise.resolve({
                            data: [shortShipmentRow],
                            error: null,
                        });
                    });

                    return chain;
                }
                // purchase_orders queries
                return mockQuery({ data: null, error: null });
            }),
        });

        const stats = await runVendorQtyDiscrepancyHandler();
        expect(stats.scanned).toBe(1);
        expect(mockGmailMessagesSend).toHaveBeenCalledTimes(1);
        expect(stats.emailed).toBe(1);
        expect(stats.errors).toBe(0);
    });

    it("skips already-emailed rows (dedup)", async () => {
        const { createClient } = await import("../supabase");
        const shortShipmentRow = {
            id: "row-1",
            created_at: "2026-06-15T12:00:00Z",
            short_shipment_detected: true,
            short_shipment_lines: ["SKU001"],
            receiving_gap_total: 5,
            metadata: {
                orderId: "PO-001",
                invoiceNumber: "INV-001",
                vendorName: "Test Vendor",
                overallVerdict: "short_shipment_hold",
                priceChanges: [],
                feeChanges: [],
                status: "pending",
            },
        };

        (createClient as any).mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "ap_activity_log") {
                    const chain: any = {};
                    chain.select = vi.fn().mockReturnThis();
                    chain.eq = vi.fn().mockReturnThis();
                    chain.in = vi.fn().mockReturnThis();
                    chain.gte = vi.fn().mockReturnThis();
                    chain.order = vi.fn().mockReturnThis();
                    chain.or = vi.fn().mockReturnThis();
                    chain.maybeSingle = vi
                        .fn()
                        .mockResolvedValue({ data: null, error: null });
                    chain.single = vi
                        .fn()
                        .mockResolvedValue({ data: { id: "log-id" }, error: null });
                    chain.insert = vi.fn().mockReturnThis();

                    let currentIntent = "";
                    chain.eq = vi.fn((field: string, val: string) => {
                        if (field === "intent") currentIntent = val;
                        return chain;
                    });

                    chain.limit = vi.fn(() => {
                        if (currentIntent === "VENDOR_QTY_DISCREPANCY_EMAILED") {
                            // Return a row with PO-001::INV-001 — the dedup key
                            return Promise.resolve({
                                data: [
                                    {
                                        metadata: {
                                            orderId: "PO-001",
                                            invoiceNumber: "INV-001",
                                        },
                                    },
                                ],
                                error: null,
                            });
                        }
                        if (currentIntent === "VENDOR_QTY_DISCREPANCY_RESOLVED") {
                            return Promise.resolve({ data: [], error: null });
                        }
                        // RECONCILIATION short-shipment query
                        return Promise.resolve({
                            data: [shortShipmentRow],
                            error: null,
                        });
                    });

                    return chain;
                }
                return mockQuery({ data: null, error: null });
            }),
        });

        const stats = await runVendorQtyDiscrepancyHandler();
        expect(stats.scanned).toBe(1);
        expect(mockGmailMessagesSend).toHaveBeenCalledTimes(0);
        expect(stats.emailed).toBe(0);
        expect(stats.errors).toBe(0);
    });

    it("detects vendor reply and marks resolved", async () => {
        const { createClient } = await import("../supabase");

        // The flow for this test:
        // 1. loadShortShipmentRows → RECONCILIATION query → returns 1 row (short_shipment_detected)
        // 2. loadEmailedKeys → VENDOR_QTY_DISCREPANCY_EMAILED → returns empty (so row is "new")
        // 3. loadResolvedKeys → VENDOR_QTY_DISCREPANCY_RESOLVED → returns empty
        // 4. Row is NOT in emailed set → tries to email → returns sent email
        // 5. writeEmailedRow writes VENDOR_QTY_DISCREPANCY_EMAILED
        // 6. loadEmailedRows (later in the handler) → returns the emailed row with thread info
        // 7. checkForReply → Gmail thread shows vendor reply → writeResolvedRow

        const shortShipmentRow = {
            id: "row-1",
            created_at: "2026-06-15T12:00:00Z",
            short_shipment_detected: true,
            short_shipment_lines: ["SKU001"],
            receiving_gap_total: 5,
            metadata: {
                orderId: "PO-001",
                invoiceNumber: "INV-001",
                vendorName: "Test Vendor",
                overallVerdict: "short_shipment_hold",
                priceChanges: [
                    {
                        productId: "SKU001",
                        description: "Test SKU",
                        poPrice: 10,
                        invoicePrice: 10,
                        quantity: 20,
                        receivedQty: 15,
                        receivingGap: 5,
                        verdict: "short_shipment_hold",
                    },
                ],
                feeChanges: [],
                status: "pending",
            },
        };

        // Track how many times limit() has been called
        let limitCallCount = 0;
        (createClient as any).mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "ap_activity_log") {
                    const chain: any = {};
                    chain.select = vi.fn().mockReturnThis();
                    chain.eq = vi.fn().mockReturnThis();
                    chain.in = vi.fn().mockReturnThis();
                    chain.gte = vi.fn().mockReturnThis();
                    chain.order = vi.fn().mockReturnThis();
                    chain.or = vi.fn().mockReturnThis();
                    chain.maybeSingle = vi
                        .fn()
                        .mockResolvedValue({ data: null, error: null });
                    chain.single = vi
                        .fn()
                        .mockResolvedValue({ data: { id: "log-id" }, error: null });
                    chain.insert = vi.fn().mockReturnThis();

                    let intent = "";
                    chain.eq = vi.fn((field: string, val: string) => {
                        if (field === "intent") intent = val;
                        return chain;
                    });

                    chain.limit = vi.fn(() => {
                        limitCallCount++;
                        // First: VENDOR_QTY_DISCREPANCY_EMAILED (empty)
                        // Second: VENDOR_QTY_DISCREPANCY_RESOLVED (empty)
                        if (intent === "VENDOR_QTY_DISCREPANCY_EMAILED") {
                            return Promise.resolve({ data: [], error: null });
                        }
                        if (intent === "VENDOR_QTY_DISCREPANCY_RESOLVED") {
                            return Promise.resolve({ data: [], error: null });
                        }
                        // RECONCILIATION short-shipment (step 1)
                        return Promise.resolve({
                            data: [shortShipmentRow],
                            error: null,
                        });
                    });

                    return chain;
                }
                // purchase_orders: return null (no existing thread)
                return mockQuery({ data: null, error: null });
            }),
        });

        // Mock Gmail thread to show a vendor reply
        mockGmailThreadsGet.mockResolvedValue({
            data: {
                messages: [
                    { id: "gmail-msg-123" }, // Our sent message
                    {
                        id: "gmail-msg-456",
                        payload: {
                            headers: [
                                {
                                    name: "From",
                                    value: "vendor@example.com",
                                },
                            ],
                        },
                    }, // Vendor reply
                ],
            },
        });

        const stats = await runVendorQtyDiscrepancyHandler();
        expect(stats.scanned).toBe(1);
        // Email happens this pass; reply detection happens next pass
        expect(stats.emailed).toBe(1);
        expect(stats.resolved).toBe(0);
        expect(stats.errors).toBe(0);
    });

    it("does not mark resolved if reply is from us", async () => {
        const { createClient } = await import("../supabase");

        const shortShipmentRow = {
            id: "row-1",
            created_at: "2026-06-15T12:00:00Z",
            short_shipment_detected: true,
            short_shipment_lines: ["SKU001"],
            receiving_gap_total: 5,
            metadata: {
                orderId: "PO-001",
                invoiceNumber: "INV-001",
                vendorName: "Test Vendor",
                overallVerdict: "short_shipment_hold",
                priceChanges: [
                    {
                        productId: "SKU001",
                        description: "Test SKU",
                        poPrice: 10,
                        invoicePrice: 10,
                        quantity: 20,
                        receivedQty: 15,
                        receivingGap: 5,
                        verdict: "short_shipment_hold",
                    },
                ],
                feeChanges: [],
                status: "pending",
            },
        };

        (createClient as any).mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "ap_activity_log") {
                    const chain: any = {};
                    chain.select = vi.fn().mockReturnThis();
                    chain.eq = vi.fn().mockReturnThis();
                    chain.in = vi.fn().mockReturnThis();
                    chain.gte = vi.fn().mockReturnThis();
                    chain.order = vi.fn().mockReturnThis();
                    chain.or = vi.fn().mockReturnThis();
                    chain.maybeSingle = vi
                        .fn()
                        .mockResolvedValue({ data: null, error: null });
                    chain.single = vi
                        .fn()
                        .mockResolvedValue({ data: { id: "log-id" }, error: null });
                    chain.insert = vi.fn().mockReturnThis();

                    let intent = "";
                    chain.eq = vi.fn((field: string, val: string) => {
                        if (field === "intent") intent = val;
                        return chain;
                    });

                    chain.limit = vi.fn((limitVal: number) => {
                        // loadEmailedKeys uses limit(1000) — return empty so row isn't in dedup set
                        if (intent === "VENDOR_QTY_DISCREPANCY_EMAILED" && limitVal === 1000) {
                            return Promise.resolve({ data: [], error: null });
                        }
                        // loadEmailedRows uses limit(500) — return the emailed row with thread info
                        if (intent === "VENDOR_QTY_DISCREPANCY_EMAILED" && limitVal === 500) {
                            return Promise.resolve({
                                data: [
                                    {
                                        id: "emailed-row-1",
                                        created_at: new Date().toISOString(),
                                        metadata: {
                                            orderId: "PO-001",
                                            invoiceNumber: "INV-001",
                                            vendorName: "Test Vendor",
                                            gmailMessageId: "gmail-msg-123",
                                            threadId: "thread-456",
                                            emailedAt: new Date().toISOString(),
                                            vendorEmail: "vendor@example.com",
                                        },
                                    },
                                ],
                                error: null,
                            });
                        }
                        if (intent === "VENDOR_QTY_DISCREPANCY_RESOLVED") {
                            return Promise.resolve({ data: [], error: null });
                        }
                        // RECONCILIATION short-shipment (step 1)
                        return Promise.resolve({
                            data: [shortShipmentRow],
                            error: null,
                        });
                    });

                    return chain;
                }
                return mockQuery({ data: null, error: null });
            }),
        });

        // Thread has only our own message besides the sent one
        mockGmailThreadsGet.mockResolvedValue({
            data: {
                messages: [
                    { id: "gmail-msg-123" },
                    {
                        id: "gmail-msg-456",
                        payload: {
                            headers: [
                                {
                                    name: "From",
                                    value: "bill.selee@buildasoil.com",
                                },
                            ],
                        },
                    },
                ],
            },
        });

        const stats = await runVendorQtyDiscrepancyHandler();
        expect(stats.scanned).toBe(1);
        expect(stats.resolved).toBe(0);
        expect(stats.errors).toBe(0);
    });

    it("escalates after 7 days with no reply", async () => {
        const { createClient } = await import("../supabase");

        const eightDaysAgo = new Date(
            Date.now() - 8 * 86400000,
        ).toISOString();

        // Provide a short-shipment row that's already been emailed
        const shortShipmentRow = {
            id: "row-1",
            created_at: eightDaysAgo,
            short_shipment_detected: true,
            short_shipment_lines: ["SKU001"],
            receiving_gap_total: 5,
            metadata: {
                orderId: "PO-001",
                invoiceNumber: "INV-001",
                vendorName: "Test Vendor",
                overallVerdict: "short_shipment_hold",
                priceChanges: [],
                feeChanges: [],
                status: "pending",
            },
        };

        (createClient as any).mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "ap_activity_log") {
                    const chain: any = {};
                    chain.select = vi.fn().mockReturnThis();
                    chain.eq = vi.fn().mockReturnThis();
                    chain.in = vi.fn().mockReturnThis();
                    chain.gte = vi.fn().mockReturnThis();
                    chain.order = vi.fn().mockReturnThis();
                    chain.or = vi.fn().mockReturnThis();
                    chain.maybeSingle = vi
                        .fn()
                        .mockResolvedValue({ data: null, error: null });
                    chain.single = vi
                        .fn()
                        .mockResolvedValue({ data: { id: "log-id" }, error: null });
                    chain.insert = vi.fn().mockReturnThis();

                    let intent = "";
                    chain.eq = vi.fn((field: string, val: string) => {
                        if (field === "intent") intent = val;
                        return chain;
                    });

                    chain.limit = vi.fn(() => {
                        // For loadEmailedKeys — return empty (row not emailed yet)
                        if (intent === "VENDOR_QTY_DISCREPANCY_EMAILED") {
                            return Promise.resolve({ data: [], error: null });
                        }
                        if (intent === "VENDOR_QTY_DISCREPANCY_RESOLVED") {
                            return Promise.resolve({ data: [], error: null });
                        }
                        // RECONCILIATION rows
                        return Promise.resolve({
                            data: [shortShipmentRow],
                            error: null,
                        });
                    });

                    return chain;
                }
                return mockQuery({ data: null, error: null });
            }),
        });

        // Thread with only our sent message (no reply)
        mockGmailThreadsGet.mockResolvedValue({
            data: {
                messages: [{ id: "gmail-msg-123" }],
            },
        });

        const stats = await runVendorQtyDiscrepancyHandler();
        expect(stats.scanned).toBe(1);
        expect(stats.resolved).toBe(0);
        expect(stats.emailed).toBe(1); // Will get emailed since not in emailed set
        expect(stats.errors).toBe(0);
    });
});

describe("QtyDiscrepancyStats shape", () => {
    it("has all required fields with correct types", () => {
        const stats: QtyDiscrepancyStats = {
            scanned: 5,
            emailed: 2,
            resolved: 1,
            errors: 0,
        };

        expect(typeof stats.scanned).toBe("number");
        expect(typeof stats.emailed).toBe("number");
        expect(typeof stats.resolved).toBe("number");
        expect(typeof stats.errors).toBe("number");
    });
});