import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock } = vi.hoisted(() => ({
    launchMock: vi.fn(),
}));

vi.mock("playwright", () => ({
    chromium: {
        launch: launchMock,
    },
}));

import { launchUlineSession, openUlineQuickOrder } from "./uline-session";

describe("launchUlineSession", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.ULINE_EMAIL;
        delete process.env.ULINE_PASSWORD;
    });

    it("launches chromium and creates a fresh browser context", async () => {
        const newPage = vi.fn().mockResolvedValue({});
        const newContext = vi.fn().mockResolvedValue({
            pages: vi.fn().mockReturnValue([]),
            newPage,
            addCookies: vi.fn().mockResolvedValue(undefined),
        });
        const close = vi.fn().mockResolvedValue(undefined);
        launchMock.mockResolvedValue({
            newContext,
            close,
        });

        await launchUlineSession({ headless: false });

        expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({
            headless: false,
            args: expect.arrayContaining(["--disable-blink-features=AutomationControlled"]),
        }));
        expect(newContext).toHaveBeenCalledTimes(1);
        expect(newPage).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it("still launches a fresh browser context even when credentials are configured", async () => {
        process.env.ULINE_EMAIL = "ops@example.com";
        process.env.ULINE_PASSWORD = "secret";

        const newContext = vi.fn().mockResolvedValue({
            pages: vi.fn().mockReturnValue([{}]),
            newPage: vi.fn(),
            addCookies: vi.fn().mockResolvedValue(undefined),
        });
        launchMock.mockResolvedValue({
            newContext,
            close: vi.fn().mockResolvedValue(undefined),
        });

        await launchUlineSession({ headless: false });

        expect(launchMock).toHaveBeenCalledTimes(1);
        expect(newContext).toHaveBeenCalledTimes(1);
    });

    it("treats the catalog quick order page as ready after a retry when body text indicates success", async () => {
        const evaluate = vi.fn()
            .mockResolvedValueOnce("unknown")
            .mockResolvedValueOnce("ready");
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            waitForTimeout: vi.fn(() => Promise.resolve(undefined)),
            evaluate,
            fill: vi.fn(),
            click: vi.fn(),
        } as any;

        const landed = await openUlineQuickOrder(page);

        expect(landed).toBe("ready");
        expect(page.goto).toHaveBeenCalledWith(
            "https://www.uline.com/Ordering/QuickOrder",
            expect.objectContaining({
                waitUntil: "domcontentloaded",
            }),
        );
        expect(evaluate).toHaveBeenCalledTimes(2);
    });
});
