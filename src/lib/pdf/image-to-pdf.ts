/**
 * @file    src/lib/pdf/image-to-pdf.ts
 * @purpose Convert invoice image attachments (JPEG/PNG) into single-page PDFs
 *          so AP can forward them to Bill.com (Bill.com expects PDF bills).
 * @author  Hermia
 * @created 2026-07-17
 * @deps    pdf-lib, sharp (optional resize for huge phone photos)
 * @env     none
 *
 * CONTEXT (2026-07-17):
 *   Down to Earth Worms (Gary Ambriole <garyambriole@icloud.com>, historically
 *   LuAnn <deeremother@hotmail.com>) sends phone photos as the invoice.
 *   ap-local-forwarder only accepted application/pdf and skipped these as
 *   "No PDF", so nothing reached Bill.com.
 */
import { PDFDocument } from "pdf-lib";

const IMAGE_MIME = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/pjpeg",
]);

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".jpe"];

/** Skip tiny logos/signatures; real phone-invoice photos are multi-MB. */
const MIN_IMAGE_BYTES = 80 * 1024;

/**
 * True if this Gmail part looks like a billable invoice image attachment.
 */
export function isInvoiceImagePart(mimeType: string, filename: string, sizeHint = 0): boolean {
    const mime = (mimeType || "").toLowerCase();
    const name = (filename || "").toLowerCase();
    const byMime = IMAGE_MIME.has(mime);
    const byExt = IMAGE_EXT.some((ext) => name.endsWith(ext));
    if (!byMime && !byExt) return false;
    if (!name) return false; // ignore nameless inline chrome
    if (sizeHint > 0 && sizeHint < MIN_IMAGE_BYTES) return false;
    return true;
}

/**
 * Build a PDF filename from an image attachment name.
 * IMG_1137.jpeg → IMG_1137.pdf
 */
export function imageFilenameToPdf(filename: string): string {
    const base = (filename || "invoice_image").replace(/\.[^.]+$/i, "");
    const safe = base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 160) || "invoice_image";
    return `${safe}.pdf`;
}

/**
 * Wrap a JPEG/PNG buffer in a single-page PDF, letter-sized, image fitted.
 *
 * @param imageBuffer - Raw image bytes
 * @param mimeType - image/jpeg | image/png (inferred from magic bytes if empty)
 * @returns PDF buffer ready for Bill.com forward
 */
export async function imageBufferToPdf(
    imageBuffer: Buffer,
    mimeType = "",
): Promise<Buffer> {
    if (!imageBuffer?.length) {
        throw new Error("imageBufferToPdf: empty buffer");
    }

    let bytes = imageBuffer;
    let mime = (mimeType || "").toLowerCase();

    // Infer mime from magic bytes if missing / wrong
    if (!IMAGE_MIME.has(mime)) {
        if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
        else if (bytes[0] === 0x89 && bytes[1] === 0x50) mime = "image/png";
        else throw new Error(`imageBufferToPdf: unsupported image type (${mime || "unknown"})`);
    }

    // Soft-resize huge phone photos so pdf-lib + Gmail stay happy
    // (Gary's photos are often 4–6 MB JPEGs).
    try {
        if (bytes.length > 2.5 * 1024 * 1024) {
            const sharp = (await import("sharp")).default;
            const pipeline = sharp(bytes).rotate(); // honor EXIF orientation
            const meta = await pipeline.metadata();
            const maxEdge = 2400;
            const w = meta.width || maxEdge;
            const h = meta.height || maxEdge;
            if (Math.max(w, h) > maxEdge) {
                bytes = await pipeline
                    .resize({
                        width: w >= h ? maxEdge : undefined,
                        height: h > w ? maxEdge : undefined,
                        fit: "inside",
                        withoutEnlargement: true,
                    })
                    .jpeg({ quality: 85, mozjpeg: true })
                    .toBuffer();
                mime = "image/jpeg";
            }
        } else {
            // Still apply EXIF rotation for correct page orientation
            const sharp = (await import("sharp")).default;
            if (mime.includes("jpeg") || mime.includes("jpg")) {
                bytes = await sharp(bytes).rotate().jpeg({ quality: 90 }).toBuffer();
                mime = "image/jpeg";
            } else if (mime.includes("png")) {
                bytes = await sharp(bytes).rotate().png().toBuffer();
                mime = "image/png";
            }
        }
    } catch {
        // sharp optional path failed — fall through with original bytes
    }

    const pdf = await PDFDocument.create();
    const embedded =
        mime.includes("png")
            ? await pdf.embedPng(bytes)
            : await pdf.embedJpg(bytes);

    // US Letter
    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 24;
    const maxW = pageWidth - margin * 2;
    const maxH = pageHeight - margin * 2;
    const scale = Math.min(maxW / embedded.width, maxH / embedded.height, 1);
    const drawW = embedded.width * scale;
    const drawH = embedded.height * scale;
    const x = (pageWidth - drawW) / 2;
    const y = (pageHeight - drawH) / 2;

    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, { x, y, width: drawW, height: drawH });

    const out = await pdf.save();
    return Buffer.from(out);
}
