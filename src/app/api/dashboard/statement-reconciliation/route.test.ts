import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    listDashboardData,
    launchStatementRun,
    launchFedexDownloadRun,
} = vi.hoisted(() => ({
    listDashboardData: vi.fn(),
    launchStatementRun: vi.fn(),
    launchFedexDownloadRun: vi.fn(),
}));

vi.mock("@/lib/statements/service", () => ({
    listStatementDashboardData: listDashboardData,
    launchStatementRun,
    launchFedexDownloadRun,
}));

import { GET, POST } from "./route";

describe("statement reconciliation dashboard route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns queue items and run history", async () => {
        listDashboardData.mockResolvedValue({
            queue: [{ id: "intake_1", vendorName: "FedEx" }],
            runs: [{ id: "run_1", vendorName: "FedEx" }],
            cachedAt: "2026-04-01T12:00:00.000Z",
        });

        const response = await GET({
            nextUrl: new URL("http://localhost/api/dashboard/statement-reconciliation?bust=1"),
        } as any);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.queue).toHaveLength(1);
        expect(body.runs).toHaveLength(1);
    });

    it("launches an existing intake reconciliation run", async () => {
        launchStatementRun.mockResolvedValue({ runId: "run_1", intakeId: "intake_1" });

        const response = await POST({
            json: async () => ({
                action: "run_existing_intake",
                intakeId: "intake_1",
            }),
        } as any);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(launchStatementRun).toHaveBeenCalledWith("intake_1", "dashboard");
        expect(body).toMatchObject({ runId: "run_1", intakeId: "intake_1" });
    });

    it("launches a FedEx download reconciliation request", async () => {
        launchFedexDownloadRun.mockResolvedValue({ runId: "run_2", intakeId: "intake_2" });

        const response = await POST({
            json: async () => ({
                action: "run_fedex_download",
            }),
        } as any);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(launchFedexDownloadRun).toHaveBeenCalledWith("dashboard");
        expect(body).toMatchObject({ runId: "run_2", intakeId: "intake_2" });
    });
});
