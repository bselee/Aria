import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    boardMock,
    answerMock,
} = vi.hoisted(() => ({
    boardMock: vi.fn(),
    answerMock: vi.fn(),
}));

vi.mock("@/lib/tracking/shipment-intelligence", () => ({
    buildTodayShipmentSummary: vi.fn((board) => ({
        headline: `${board.outForDelivery?.length || 0} out for delivery, ${board.arrivingToday?.length || 0} arriving today`,
        lines: [],
    })),
    getDashboardTrackingBoard: boardMock,
    getBestTrackingAnswerForQuery: answerMock,
}));

import { GET } from "./route";

describe("dashboard tracking route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns grouped shipment board data", async () => {
        boardMock.mockResolvedValue({
            board: {
                arrivingToday: [],
                outForDelivery: [],
                deliveredAwaitingReceipt: [],
                exceptions: [],
                stale: [],
                recentlyDelivered: [],
            },
            shipments: [],
            asOf: "2026-04-02T15:00:00.000Z",
        });
        answerMock.mockResolvedValue(null);

        const response = await GET(new Request("http://localhost/api/dashboard/tracking"));

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.board).toHaveProperty("arrivingToday");
        expect(body.shipments).toEqual([]);
        expect(body.todaySummary).toHaveProperty("headline");
        expect(answerMock).not.toHaveBeenCalled();
    });

    it("returns a best-answer payload when search is present", async () => {
        boardMock.mockResolvedValue({
            board: {
                arrivingToday: [],
                outForDelivery: [],
                deliveredAwaitingReceipt: [],
                exceptions: [],
                stale: [],
                recentlyDelivered: [],
            },
            shipments: [],
            asOf: "2026-04-02T15:00:00.000Z",
        });
        answerMock.mockResolvedValue({
            primaryLine: "PO-100 - Out for delivery",
            metaLine: "fresh 3m ago",
            shipments: [],
        });

        const response = await GET(new Request("http://localhost/api/dashboard/tracking?q=PO-100"));

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(answerMock).toHaveBeenCalledWith("PO-100");
        expect(body.answer).toMatchObject({
            primaryLine: "PO-100 - Out for delivery",
        });
    });
});
