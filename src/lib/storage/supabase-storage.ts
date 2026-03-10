/**
 * @file    supabase-storage.ts
 * @purpose Uploads PDFs and other documents to Supabase Storage.
 *          Provides a clean API for the attachment handler and dropship store
 *          to archive files with structured paths.
 * @author  Aria (Antigravity)
 * @created 2026-03-10
 * @updated 2026-03-10
 * @deps    supabase/client
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "../supabase";

const BUCKET = "documents";

/**
 * Uploads a PDF buffer to Supabase Storage and returns the storage path.
 *
 * Files are stored under a structured path:
 *   documents/{type}/{vendor}/{date}/{filename}
 *
 * If the upload fails the error is thrown — callers should catch and degrade
 * gracefully (the upload is never critical-path for reconciliation).
 *
 * @param   buffer   - Raw PDF bytes
 * @param   meta     - Structured metadata used to build the storage path
 * @returns Storage path string (e.g., "INVOICE/acme/2026-03-10/inv-12345.pdf")
 * @throws  {Error}  If Supabase Storage upload fails
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
    const supabase = createClient();

    // Sanitize path components — remove special chars that break storage paths
    const safeName = (s: string) =>
        s.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\s+/g, "_").slice(0, 100);

    const storagePath = [
        safeName(meta.type),
        safeName(meta.vendor),
        meta.date,
        safeName(meta.filename),
    ].join("/");

    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, buffer, {
            contentType: "application/pdf",
            upsert: true, // Overwrite if same path exists (idempotent re-processing)
        });

    if (error) {
        throw new Error(`Supabase Storage upload failed: ${error.message}`);
    }

    return storagePath;
}
