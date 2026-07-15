/**
 * @file    src/lib/storage/supabase-storage.ts
 * @purpose Local filesystem storage for PDFs and other documents.
 *          Replaces Supabase Storage. Files are stored under
 *          local/storage/{type}/{vendor}/{date}/{filename}.
 *
 *          Provides both upload and download operations.
 *          Used by the AP pipeline to persist and retrieve invoice PDFs.
 * @author  Hermia
 * @created 2026-03-10
 * @updated 2026-07-15 — added downloadPDF() to complete Supabase Storage replacement
 * @deps    fs, path
 */

import * as fs from "fs";
import * as path from "path";

const STORAGE_ROOT = path.join(process.cwd(), "local", "storage");

/**
 * Sanitize a filename component — strip special chars, limit length.
 */
function safeName(s: string): string {
    return s.replace(/[^a-zA-Z0-9_\-./ ]/g, "").replace(/\s+/g, "_").slice(0, 100);
}

/**
 * Writes a PDF buffer to the local filesystem and returns the storage path.
 *
 * Files are stored under a structured path:
 *   local/storage/{type}/{vendor}/{date}/{filename}
 *
 * @param   buffer   - Raw PDF bytes
 * @param   meta     - Structured metadata used to build the storage path
 * @returns Storage path string (e.g., "local/storage/INVOICE/acme/2026-03-10/inv-12345.pdf")
 */
export async function uploadPDF(
    buffer: Buffer,
    meta: {
        type: string;
        vendor: string;
        date: string;
        filename: string;
    }
): Promise<string> {
    const relativePath = [
        safeName(meta.type),
        safeName(meta.vendor),
        meta.date,
        safeName(meta.filename),
    ].join("/");

    const fullPath = path.join(STORAGE_ROOT, relativePath);

    try {
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, buffer);
    } catch (err: any) {
        console.warn(`[storage] Local write failed (non-critical): ${err?.message || err}`);
    }

    return path.join("local", "storage", relativePath).replace(/\\/g, "/");
}

/**
 * Read a PDF (or any file) from the local filesystem storage.
 *
 * @param   storagePath - Relative storage path (e.g., "local/storage/INVOICE/acme/...")
 * @returns The file buffer, or null if not found
 */
export async function downloadPDF(storagePath: string): Promise<Buffer | null> {
    try {
        const fullPath = path.resolve(STORAGE_ROOT, "..", "..", storagePath);

        // Also try direct STORAGE_ROOT join
        const altPath = path.join(STORAGE_ROOT, storagePath.replace(/^local\/storage\//, ""));

        // Try primary first, then fallback
        let resolvedPath = fullPath;
        if (!fs.existsSync(fullPath) && fs.existsSync(altPath)) {
            resolvedPath = altPath;
        }

        if (!fs.existsSync(resolvedPath)) {
            console.warn(`[storage] File not found: ${resolvedPath}`);
            return null;
        }

        return await fs.promises.readFile(resolvedPath);
    } catch (err: any) {
        console.error(`[storage] Download failed for ${storagePath}: ${err.message}`);
        return null;
    }
}

/**
 * Delete a file from local filesystem storage.
 *
 * @param storagePath - Relative storage path
 */
export async function deleteFile(storagePath: string): Promise<boolean> {
    try {
        const fullPath = path.join(STORAGE_ROOT, storagePath.replace(/^local\/storage\//, ""));
        if (fs.existsSync(fullPath)) {
            await fs.promises.unlink(fullPath);
            return true;
        }
        return false;
    } catch (err: any) {
        console.warn(`[storage] Delete failed for ${storagePath}: ${err.message}`);
        return false;
    }
}
