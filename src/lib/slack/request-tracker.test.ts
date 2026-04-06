import { describe, expect, it } from "vitest";

import {
    findRecentCompletionMatches,
    type RecentPurchaseOrder,
    type SlackRequestRow,
} from "./request-tracker";

function makeRequest(overrides: Partial<SlackRequestRow> = {}): SlackRequestRow {
    return {
        id: "req-1",
        channel_id: "C123",
        channel_name: "purchase-orders",
        message_ts: "1710000000.000100",
        thread_ts: null,
        requester_user_id: "U123",
        requester_name: "Warehouse User",
        original_text: "Need BB106 and ALK101 please @Bill",
        items_requested: ["BB106", "ALK101"],
        matched_skus: ["BB106", "ALK101"],
        status: "pending",
        quantity: null,
        extracted_urls: null,
        completion_po_numbers: null,
        completed_at: null,
        completed_via: null,
        created_at: "2026-04-06T08:00:00.000Z",
        updated_at: "2026-04-06T08:00:00.000Z",
        ...overrides,
    };
}

function makePO(overrides: Partial<RecentPurchaseOrder> = {}): RecentPurchaseOrder {
    return {
        po_number: "PO-1001",
        status: "committed",
        created_at: "2026-04-06T09:00:00.000Z",
        updated_at: "2026-04-06T09:00:00.000Z",
        issue_date: "2026-04-06T09:00:00.000Z",
        line_items: [
            { sku: "BB106", quantity: 4 },
            { productId: "ALK101", quantity: 2 },
        ],
        ...overrides,
    };
}

describe("findRecentCompletionMatches", () => {
    it("matches pending requests to recent committed POs by exact SKU", () => {
        const matches = findRecentCompletionMatches({
            requests: [makeRequest()],
            purchaseOrders: [makePO()],
            now: "2026-04-06T12:00:00.000Z",
            lookbackHours: 48,
        });

        expect(matches).toEqual([
            {
                requestId: "req-1",
                poNumbers: ["PO-1001"],
                matchedSkus: ["ALK101", "BB106"],
            },
        ]);
    });

    it("ignores requests when the PO is too old or not committed", () => {
        const matches = findRecentCompletionMatches({
            requests: [
                makeRequest({ id: "old-po" }),
                makeRequest({ id: "draft-po", matched_skus: ["BB106"] }),
                makeRequest({ id: "name-only", matched_skus: [] }),
            ],
            purchaseOrders: [
                makePO({
                    po_number: "PO-OLD",
                    created_at: "2026-04-01T08:00:00.000Z",
                    updated_at: "2026-04-01T08:00:00.000Z",
                }),
                makePO({
                    po_number: "PO-DRAFT",
                    status: "open",
                    line_items: [{ sku: "BB106", quantity: 1 }],
                }),
                makePO({
                    po_number: "PO-NAME",
                    line_items: [{ description: "Box item without sku" }],
                }),
            ],
            now: "2026-04-06T12:00:00.000Z",
            lookbackHours: 48,
        });

        expect(matches).toEqual([]);
    });
});
