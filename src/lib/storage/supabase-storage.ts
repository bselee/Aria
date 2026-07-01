/**
 * @file    supabase-storage.ts
 * @purpose Local filesystem storage for PDFs and other documents.
 *          Replaces Supabase Storage. Files are stored under
 *          local/storage/{type}/{vendor}/{date}/{filename}.
 * @author  Aria (Antigravity)
 * @created 2026-03-10
 * @updated 2026-07-01 — migrated from Supabase Storage to local filesystem
 * @deps    fs, path
 */

import * as fs from "fs";
import * as path from "path";

const STORAGE_ROOT = path.join(process.cwd(), "local", "storage");

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
    // Sanitize path components
    const safeName = (s: string) =>
        s.replace(/[^a-zA-Z0-9_\-./ ]/g, "").replace(/\s+/g, "_").slice(0, 100);

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
