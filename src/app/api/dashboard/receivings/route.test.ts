import { beforeEach, describe, expect, it, vi } from "vitest";

const { getTodaysReceivedPOsMock } = vi.hoisted(() => ({
    getTodaysReceivedPOsMock: vi.fn(),
}));

vi.mock("@/lib/finale/client", () => ({
    FinaleClient: class {
        getTodaysReceivedPOs = getTodaysReceivedPOsMock;
    },
}));

import { GET, getDenverWeekStart } from "./route";

describe("dashboard receivings route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it("defaults to Denver week-to-date receipts", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T18:00:00.000Z"));
        getTodaysReceivedPOsMock.mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/dashboard/receivings"));

        expect(response.status).toBe(200);
        // NOTE(2026-07-28): Product changed from week-to-date to rolling 30d window
        // (commit that introduced DEFAULT_RECEIVINGS_DAYS). Test updated to match.
        expect(getTodaysReceivedPOsMock).toHaveBeenCalledWith("2026-03-04", "2026-04-04");

        const body = await response.json();
        expect(body).toMatchObject({
            received: [],
            days: 30,
            range: "rolling_30d",
            startDate: "2026-03-04",
            asOf: "2026-04-03",
        });
    });

    it("keeps rolling-day override when days is provided", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-03T18:00:00.000Z"));
        getTodaysReceivedPOsMock.mockResolvedValue([]);

        const response = await GET(new Request("http://localhost/api/dashboard/receivings?days=7"));

        expect(response.status).toBe(200);
        expect(getTodaysReceivedPOsMock).toHaveBeenCalledWith("2026-03-27", "2026-04-04");

        const body = await response.json();
        expect(body).toMatchObject({
            days: 7,
            range: "rolling_days",
        });
    });

    it("computes Monday week start in Denver time", () => {
        expect(getDenverWeekStart(new Date("2026-04-03T18:00:00.000Z"))).toBe("2026-03-30");
    });
});
