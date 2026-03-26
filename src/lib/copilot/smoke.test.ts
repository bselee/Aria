import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase", () => ({
    createClient: vi.fn().mockReturnValue(null),
}));
vi.mock("../intelligence/llm", () => ({
    unifiedTextGeneration: vi.fn().mockResolvedValue("ok"),
}));

import { getStartupHealth } from "./smoke";

describe("startup health", () => {
    it("reports Slack watchdog startup state explicitly", async () => {
        const result = await getStartupHealth();
        expect(["running", "disabled"]).toContain(result.slack);
    });

    it("reports bot startup state explicitly", async () => {
        const result = await getStartupHealth();
        expect(["running", "disabled", "error"]).toContain(result.bot);
    });

    it("reports dashboard startup state explicitly", async () => {
        const result = await getStartupHealth();
        expect(["running", "disabled", "error"]).toContain(result.dashboard);
    });

    it("never throws during health check", async () => {
        await expect(getStartupHealth()).resolves.toBeDefined();
    });
});
