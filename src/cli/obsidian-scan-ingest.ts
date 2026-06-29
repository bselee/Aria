/**
 * @file    src/cli/obsidian-scan-ingest.ts
 * @purpose CLI tool that watches a directory for new PDF/image files, runs OCR
 *          via the existing Aria PDF extractor, and writes structured notes
 *          into the Obsidian vault. Designed to run as a cron job.
 *
 *          Bridge 2 of 3: Scans/Downloads → Obsidian Vault
 *
 * @author  Hermia
 * @created 2026-06-26
 * @deps    fs, path, pdf/extractor, obsidian/bridge
 * @env     OBSIDIAN_VAULT_PATH
 *          OBSIDIAN_SCAN_DIR (default: ~/Documents/Scans)
 *          OBSIDIAN_DOWNLOAD_DIR (default: ~/Downloads)
 */

import * as fs from "fs";
import * as path from "path";
import { extractPDF } from "../lib/pdf/extractor";
import { writeScanNote, type ScanNote } from "../lib/obsidian/bridge";

const VAULT_PROCESSED_DIR = ".obsidian-processed";

function getDefaultScanDirs(): string[] {
    const home = process.env.USERPROFILE || process.env.HOME || "C:\\Users\\BuildASoil";
    const dirs: string[] = [];

    const scanDir = process.env.OBSIDIAN_SCAN_DIR || path.join(home, "Documents", "Scans");
    if (fs.existsSync(scanDir)) dirs.push(scanDir);

    const downloadDir = process.env.OBSIDIAN_DOWNLOAD_DIR || path.join(home, "Downloads");
    if (fs.existsSync(downloadDir)) dirs.push(downloadDir);

    return dirs;
}

function isDocumentFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return [".pdf", ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".txt"].includes(ext);
}

function ensureProcessedDir(dir: string): string {
    const processed = path.join(dir, VAULT_PROCESSED_DIR);
    if (!fs.existsSync(processed)) {
        fs.mkdirSync(processed, { recursive: true });
    }
    return processed;
}

async function processFile(
    filePath: string,
    source: string
): Promise<string | null> {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const ingestedAt = new Date().toISOString();

    console.log(`[obsidian-scan-ingest] Processing: ${fileName}`);

    try {
        let ocrText = "";
        let extractedData: Record<string, unknown> | undefined;

        if (ext === ".pdf") {
            const buffer = fs.readFileSync(filePath);
            const result = await extractPDF(buffer);
            ocrText = result.rawText || "";
            extractedData = {
                pageCount: result.metadata.pageCount,
                ocrStrategy: result.ocrStrategy,
                hasImages: result.hasImages,
            };
        } else if (ext === ".txt") {
            ocrText = fs.readFileSync(filePath, "utf-8");
        } else {
            // For images, we'd need a vision model — log and skip for now
            ocrText = `[Image file: ${fileName}] — OCR for images requires vision model integration.`;
            extractedData = { fileType: "image", note: "Vision OCR not yet integrated" };
        }

        const note: ScanNote = {
            fileName,
            filePath,
            fileType: ext.replace(".", ""),
            ocrText,
            extractedData,
            ingestedAt,
            source,
        };

        return writeScanNote(note);
    } catch (err: any) {
        console.error(`[obsidian-scan-ingest] Failed to process ${fileName}: ${err.message}`);
        return null;
    }
}

async function main() {
    const dirs = getDefaultScanDirs();

    if (dirs.length === 0) {
        console.log("[obsidian-scan-ingest] No scan/download directories found. Nothing to do.");
        process.exit(0);
    }

    let processedCount = 0;
    let failedCount = 0;

    for (const dir of dirs) {
        const source = dir.toLowerCase().includes("download") ? "downloads" : "scans";
        const processedDir = ensureProcessedDir(dir);

        console.log(`[obsidian-scan-ingest] Scanning: ${dir} (source: ${source})`);

        const files = fs.readdirSync(dir).filter(
            (f: string) =>
                isDocumentFile(f) &&
                !f.startsWith(".") &&
                !fs.existsSync(path.join(processedDir, f))
        );

        if (files.length === 0) {
            console.log(`[obsidian-scan-ingest] No new files in ${dir}.`);
            continue;
        }

        console.log(`[obsidian-scan-ingest] Found ${files.length} new file(s).`);

        for (const file of files) {
            const filePath = path.join(dir, file);
            const result = await processFile(filePath, source);

            if (result) {
                processedCount++;
                // Move to processed dir to avoid reprocessing
                const processedPath = path.join(processedDir, file);
                fs.renameSync(filePath, processedPath);
                console.log(`  → ${result}`);
                console.log(`  → Moved to: ${processedPath}`);
            } else {
                failedCount++;
            }
        }
    }

    console.log(
        `[obsidian-scan-ingest] Done: ${processedCount} processed, ${failedCount} failed.`
    );
}

main().catch((err) => {
    console.error("[obsidian-scan-ingest] Fatal:", err);
    process.exit(1);
});
