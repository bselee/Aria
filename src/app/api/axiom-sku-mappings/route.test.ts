import { beforeEach, describe, expect, it, vi } from "vitest";

const fromMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
    createClient: () => ({ from: fromMock }),
}));

import { POST } from "./route";

describe("axiom SKU mappings route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.DASHBOARD_BASIC_AUTH_USER = "admin";
        process.env.DASHBOARD_BASIC_AUTH_PASSWORD = "secret";
        fromMock.mockReturnValue({
            upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockResolvedValue({
                    data: [{ axiom_job_name: "APL102", finale_skus: ["APL102"], qty_fraction: 1 }],
                    error: null,
                }),
            }),
        });
    });

    it("accepts dashboard-local mapping writes without a separate basic-auth prompt", async () => {
        const response = await POST(new Request("http://localhost/api/axiom-sku-mappings", {
            method: "POST",
            body: JSON.stringify({
                axiom_job_name: "APL102",
                finale_skus: ["APL102"],
                qty_fraction: 1,
            }),
        }) as any);

        expect(response.status).toBe(200);
        expect(fromMock).toHaveBeenCalledWith("axiom_sku_mappings");
    });
});
