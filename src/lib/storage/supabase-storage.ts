import { createClient } from "../supabase";

function getStorage() {
    const supabase = createClient();
    if (!supabase) throw new Error("Supabase is required for storage operations. Please configure NEXT_PUBLIC_SUPABASE_URL.");
    return supabase.storage;
}

// Organized folder structure:
// documents/{year}/{month}/{type}/{vendor}/{filename}
export async function uploadPDF(
    buffer: Buffer,
    meta: { type: string; vendor: string; date: string; filename: string }
): Promise<string> {
    const [year, month] = meta.date.split("-");
    const safeVendor = meta.vendor.replace(/[^a-zA-Z0-9-_]/g, "_").toLowerCase();
    const safeFilename = meta.filename.replace(/[^a-zA-Z0-9-_. ]/g, "_");
    const timestamp = Date.now();

    const path = `documents/${year}/${month}/${meta.type.toLowerCase()}/${safeVendor}/${timestamp}_${safeFilename}`;

    const { error } = await getStorage()
        .from("aria-documents")
        .upload(path, buffer, {
            contentType: "application/pdf",
            upsert: false,
        });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return path;
}

export async function getPDFUrl(path: string): Promise<string> {
    const { data } = await getStorage()
        .from("aria-documents")
        .createSignedUrl(path, 3600); // 1 hour expiry

    return data?.signedUrl ?? "";
}

export async function downloadPDF(path: string): Promise<Buffer> {
    const { data, error } = await getStorage()
        .from("aria-documents")
        .download(path);

    if (error || !data) throw new Error(`Download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
}
