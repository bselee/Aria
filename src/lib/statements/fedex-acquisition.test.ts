import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
    archiveFedexCsvToAria,
    findLatestFedexCsvCandidate,
    getFedexStatementDir,
    writeFedexAcquisitionStatus,
} from "./fedex-acquisition";

describe("fedex acquisition helpers", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("prefers the Aria-owned folder over fallback locations when timestamps are newest", () => {
        vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\Tester");
        vi.spyOn(fs, "existsSync").mockImplementation((target) =>
            [
                "C:\\Users\\Tester\\AppData\\Local\\Aria\\statements\\fedex",
                "C:\\Users\\Tester\\Downloads",
                "C:\\Users\\Tester\\OneDrive\\Desktop\\Sandbox",
            ].includes(String(target)),
        );
        vi.spyOn(fs, "readdirSync").mockImplementation((target) => {
            if (String(target).includes("fedex")) return ["FEDEX_aria.csv"] as any;
            if (String(target).includes("Downloads")) return ["FEDEX_downloads.csv"] as any;
            return ["FEDEX_sandbox.csv"] as any;
        });
        vi.spyOn(fs, "statSync").mockImplementation((target) => {
            const file = String(target);
            return {
                mtimeMs: file.includes("aria") ? 300 : file.includes("downloads") ? 200 : 100,
            } as any;
        });

        const result = findLatestFedexCsvCandidate();
        expect(result).toMatchObject({
            source: "aria",
            fullPath: expect.stringContaining("FEDEX_aria.csv"),
        });
    });

    it("copies fallback CSVs into the Aria-owned statement folder", () => {
        vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\Tester");
        const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined as any);
        vi.spyOn(fs, "existsSync").mockReturnValue(false);
        const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => undefined);

        const archived = archiveFedexCsvToAria("C:\\Users\\Tester\\Downloads\\FEDEX_demo.csv");

        expect(mkdirSpy).toHaveBeenCalled();
        expect(copySpy).toHaveBeenCalledWith(
            "C:\\Users\\Tester\\Downloads\\FEDEX_demo.csv",
            path.join(getFedexStatementDir(), "FEDEX_demo.csv"),
        );
        expect(archived).toBe(path.join(getFedexStatementDir(), "FEDEX_demo.csv"));
    });

    it("writes a status file for manual success or failure visibility", () => {
        vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\Tester");
        vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);

        writeFedexAcquisitionStatus({
            success: true,
            mode: "existing_file",
            startedAt: "2026-04-01T10:00:00.000Z",
            finishedAt: "2026-04-01T10:00:05.000Z",
            sourcePath: "C:\\Users\\Tester\\Downloads\\FEDEX_demo.csv",
            savedPath: "C:\\Users\\Tester\\AppData\\Local\\Aria\\statements\\fedex\\FEDEX_demo.csv",
            message: "Archived existing CSV from Downloads.",
        });

        expect(writeSpy).toHaveBeenCalledOnce();
        expect(String(writeSpy.mock.calls[0][0])).toContain("latest-status.json");
        expect(String(writeSpy.mock.calls[0][1])).toContain("\"success\": true");
    });
});
