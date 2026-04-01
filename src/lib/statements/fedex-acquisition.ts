import fs from "fs";
import os from "os";
import path from "path";

export interface FedexCsvCandidate {
    fullPath: string;
    source: "aria" | "downloads" | "sandbox";
    mtimeMs: number;
}

export interface FedexAcquisitionStatus {
    success: boolean;
    mode: "probe" | "existing_file" | "playwright_download" | "failed";
    startedAt: string;
    finishedAt: string;
    detectedState?: "logged_in" | "login_required" | "unknown";
    sourcePath?: string | null;
    savedPath?: string | null;
    message: string;
    error?: string | null;
}

export function getFedexStatementDir(): string {
    return path.join(os.homedir(), "AppData", "Local", "Aria", "statements", "fedex");
}

export function getFedexStatusPath(): string {
    return path.join(getFedexStatementDir(), "latest-status.json");
}

export function ensureFedexStatementDir(): string {
    const dir = getFedexStatementDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

export function fedexSearchDirs(): Array<{ dir: string; source: FedexCsvCandidate["source"] }> {
    return [
        { dir: getFedexStatementDir(), source: "aria" },
        { dir: path.join(os.homedir(), "Downloads"), source: "downloads" },
        { dir: path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox"), source: "sandbox" },
    ];
}

export function findLatestFedexCsvCandidate(): FedexCsvCandidate | null {
    const candidates = fedexSearchDirs()
        .filter(({ dir }) => fs.existsSync(dir))
        .flatMap(({ dir, source }) =>
            fs.readdirSync(dir)
                .filter((name) => /^FEDEX.*\.csv$/i.test(name))
                .map((name) => {
                    const fullPath = path.join(dir, name);
                    return {
                        fullPath,
                        source,
                        mtimeMs: fs.statSync(fullPath).mtimeMs,
                    } satisfies FedexCsvCandidate;
                }),
        )
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    return candidates[0] ?? null;
}

export function archiveFedexCsvToAria(sourcePath: string): string {
    const dir = ensureFedexStatementDir();
    const targetPath = path.join(dir, path.basename(sourcePath));
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
        fs.copyFileSync(sourcePath, targetPath);
    }
    return targetPath;
}

export function writeFedexAcquisitionStatus(status: FedexAcquisitionStatus) {
    ensureFedexStatementDir();
    fs.writeFileSync(getFedexStatusPath(), JSON.stringify(status, null, 2), "utf8");
}
