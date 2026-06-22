/**
 * @file    src/lib/dash/barcode-check.ts
 * @purpose Barcode verification for Dash print-ready label artwork.
 *          Downloads a label PDF/PNG from Dash, extracts the barcode
 *          using pyzbar (Python), and compares against the expected
 *          barcode from Finale.
 *
 *          This is the check that catches "CRAFT4 label with CRAFT10
 *          barcode" before the order goes to the printer.
 *
 * @author  Hermia
 * @created 2026-06-22
 * @deps    Python + pyzbar + pillow + PyMuPDF (fitz)
 * @env     None
 *
 * USAGE:
 *   import { verifyBarcode } from './barcode-check';
 *   const result = await verifyBarcode(pdfBuffer, 'CRAFT4');
 *   // → { matched: true/false, barcode: '810168421515', expected: '...', assetFilename: '...' }
 *
 * ARCHITECTURE:
 *   Python is called as a subprocess because pyzbar is Python-native.
 *   The TypeScript side handles Dash auth + file download, then hands
 *   the raw bytes to Python for barcode extraction.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Extract barcode(s) from a PDF or image buffer using pyzbar.
 * Returns all detected barcodes with their types and data.
 *
 * For PDF inputs, uses PyMuPDF (fitz) to render first page as PNG first.
 * For image inputs (PNG, JPG), passes directly to pyzbar.
 */
export function extractBarcodesFromBuffer(
    fileBuffer: Buffer,
    filename: string,
): Array<{ type: string; data: string }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-bc-'));
    const ext = path.extname(filename).toLowerCase();
    const isPdf = ext === '.pdf';
    const isImage = ['.png', '.jpg', '.jpeg'].includes(ext);
    if (!isPdf && !isImage) return [];

    try {
        const scriptPath = path.join(__dirname, '..', '..', '..', 'scripts', 'barcode-read.py');
        const tmpFile = path.join(tmpDir, `input${ext}`);

        if (isPdf) {
            // Script handles PDF→PNG conversion internally
            const outPath = path.join(tmpDir, 'out.png');
            fs.writeFileSync(tmpFile, fileBuffer);
            const result = execSync(
                `python "${scriptPath}" "${tmpFile}" "${outPath}"`,
                { timeout: 15000, encoding: 'utf-8' },
            );
            const output = result?.trim?.() || String(result).trim();
            return output ? JSON.parse(output) : [];
        }

        if (isImage) {
            fs.writeFileSync(tmpFile, fileBuffer);
            const result = execSync(
                `python "${scriptPath}" "${tmpFile}"`,
                { timeout: 15000, encoding: 'utf-8' },
            );
            const output = result?.trim?.() || String(result).trim();
            return output ? JSON.parse(output) : [];
        }

        return [];
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[barcode-check] Extraction failed: ${message}`);
        return [];
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/**
 * Normalize a barcode string for comparison.
 * Strips spaces, hyphens, and leading/trailing whitespace.
 */
export function normalizeBarcode(barcode: string): string {
    return barcode.replace(/[\s-]/g, '').trim();
}

/**
 * Verify that the barcode on a Dash artwork file matches the expected
 * barcode for a given Finale SKU.
 *
 * @param   fileBuffer      Raw bytes of the artwork file (PDF, PNG, etc.)
 * @param   filename        Original filename (used to determine file type)
 * @param   expectedBarcode The barcode that Finale expects for this SKU
 * @param   sku             The Finale SKU (for logging/reporting)
 * @returns Verification result
 */
export async function verifyBarcode(
    fileBuffer: Buffer,
    filename: string,
    expectedBarcode: string,
    sku: string,
): Promise<{
    verified: boolean;
    barcode: string | null;
    expected: string;
    normalizedMatch: boolean;
    message: string;
}> {
    const barcodes = extractBarcodesFromBuffer(fileBuffer, filename);

    if (barcodes.length === 0) {
        return {
            verified: false,
            barcode: null,
            expected: expectedBarcode,
            normalizedMatch: false,
            message: `No barcode detected in ${filename} for SKU ${sku}.`,
        };
    }

    const detected = barcodes[0].data;
    const normalizedDetected = normalizeBarcode(detected);
    const normalizedExpected = normalizeBarcode(expectedBarcode);
    const normalizedMatch = normalizedDetected === normalizedExpected;

    return {
        verified: normalizedMatch,
        barcode: detected,
        expected: expectedBarcode,
        normalizedMatch,
        message: normalizedMatch
            ? `✓ Barcode matches for ${sku}: ${detected}`
            : `✗ Barcode mismatch for ${sku}: art has "${detected}", expected "${expectedBarcode}"`,
    };
}

/**
 * Quick test function that reads a local file and checks its barcode.
 * Used for manual verification of label PDFs.
 *
 * Usage:
 *   npx tsx -e "import { testLocalFile } from './lib/dash/barcode-check'; testLocalFile('path/to/label.pdf', 'EXPECTED_BARCODE', 'SKU123').then(console.log)"
 */
export async function testLocalFile(
    filePath: string,
    expectedBarcode: string,
    sku: string,
): Promise<void> {
    const fs = await import('fs');
    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const result = await verifyBarcode(buffer, filename, expectedBarcode, sku);
    console.log('────────────────────────────────────────────');
    console.log(`File: ${filename}`);
    console.log(`SKU:  ${sku}`);
    console.log(`Result: ${result.verified ? '✓ MATCH' : '✗ MISMATCH'}`);
    console.log(`Detected: ${result.barcode || '(none)'}`);
    console.log(`Expected: ${result.expected}`);
    console.log(result.message);
    console.log('────────────────────────────────────────────');
}
