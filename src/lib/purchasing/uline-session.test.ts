import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchPersistentContextMock, launchMock } = vi.hoisted(() => ({
    launchPersistentContextMock: vi.fn(),
    launchMock: vi.fn(),
}));

vi.mock("playwright", () => ({
    chromium: {
        launchPersistentContext: launchPersistentContextMock,
        launch: launchMock,
    },
}));

import { launchUlineSession, openUlineQuickOrder } from "./uline-session";

describe("launchUlineSession", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.ULINE_EMAIL;
        delete process.env.ULINE_PASSWORD;

        launchPersistentContextMock.mockResolvedValue({
            close: vi.fn().mockResolvedValue(undefined),
        });
    });

    it("uses the Chrome user-data root with the Default profile selected", async () => {
        await launchUlineSession({ headless: false });

        expect(launchPersistentContextMock).toHaveBeenCalledWith(
            path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data"),
            expect.objectContaining({
                channel: "chrome",
                args: expect.arrayContaining(["--profile-directory=Default"]),
            }),
        );
    });

    it("still prefers the persistent Chrome profile even when credentials are configured", async () => {
        process.env.ULINE_EMAIL = "ops@example.com";
        process.env.ULINE_PASSWORD = "secret";

        await launchUlineSession({ headless: false });

        expect(launchPersistentContextMock).toHaveBeenCalledTimes(1);
        expect(launchMock).not.toHaveBeenCalled();
    });

    it("treats the catalog quick order page as ready even if login selectors fail first", async () => {
        const page = {
            goto: vi.fn().mockResolvedValue(undefined),
            waitForSelector: vi.fn((selector: string) => {
                if (selector === "text=Catalog Quick Order") return Promise.resolve({});
                if (selector === "text=Paste Items Page") return new Promise(resolve => setTimeout(() => resolve({}), 25));
                return Promise.reject(new Error(`missing ${selector}`));
            }),
            waitForTimeout: vi.fn(() => new Promise(resolve => setTimeout(resolve, 50))),
            fill: vi.fn(),
            click: vi.fn(),
        } as any;

        const landed = await openUlineQuickOrder(page);

        expect(landed).toBe("ready");
    });
});
