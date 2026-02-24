/**
 * @file    editor.ts
 * @purpose A comprehensive suite of PDF editing, filling, and manipulation tools.
 * @author  Antigravity
 * @created 2026-02-24
 * @deps    pdf-lib
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export interface PDFDrawOptions {
    text: string;
    x: number;
    y: number;
    size?: number;
    color?: { r: number; g: number; b: number };
}

/**
 * Main PDF Editor service providing tools for document manipulation.
 */
export class PDFEditor {

    /**
     * Fills a PDF form with the provided data.
     * @param buffer - Raw PDF buffer
     * @param data - Key-value pairs for form fields
     * @returns Processed PDF buffer
     */
    async fillForm(buffer: Buffer, data: Record<string, string | boolean>): Promise<Buffer> {
        const pdfDoc = await PDFDocument.load(buffer);
        const form = pdfDoc.getForm();

        for (const [key, value] of Object.entries(data)) {
            try {
                const field = form.getField(key);
                if (typeof value === 'boolean') {
                    const checkbox = form.getCheckBox(key);
                    if (value) checkbox.check();
                    else checkbox.uncheck();
                } else {
                    const textField = form.getTextField(key);
                    textField.setText(value);
                }
            } catch (err: any) {
                console.warn(`⚠️ Field "${key}" not found or incompatible: ${err.message}`);
            }
        }

        // Flatten the form to make it read-only and permanent
        // form.flatten(); 

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    }

    /**
     * Draws text at specific coordinates on specified pages.
     */
    async drawText(buffer: Buffer, draws: PDFDrawOptions[], pageIndices: number[] = [0]): Promise<Buffer> {
        const pdfDoc = await PDFDocument.load(buffer);
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const pages = pdfDoc.getPages();

        for (const pageIdx of pageIndices) {
            const page = pages[pageIdx];
            if (!page) continue;

            for (const draw of draws) {
                page.drawText(draw.text, {
                    x: draw.x,
                    y: draw.y,
                    size: draw.size ?? 12,
                    font,
                    color: draw.color ? rgb(draw.color.r, draw.color.g, draw.color.b) : rgb(0, 0, 0),
                });
            }
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    }

    /**
     * Adds a diagonal watermark to all pages of a PDF.
     */
    async addWatermark(buffer: Buffer, text: string = "BUILDASOIL - CONFIDENTIAL"): Promise<Buffer> {
        const pdfDoc = await PDFDocument.load(buffer);
        const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const pages = pdfDoc.getPages();

        for (const page of pages) {
            const { width, height } = page.getSize();
            page.drawText(text, {
                x: width / 4,
                y: height / 2,
                size: 50,
                font,
                color: rgb(0.75, 0.75, 0.75),
                opacity: 0.3,
                rotate: { type: 'degrees', angle: 45 } as any,
            });
        }

        const pdfBytes = await pdfDoc.save();
        return Buffer.from(pdfBytes);
    }

    /**
     * Merges multiple PDF buffers into a single document.
     */
    async mergePdfs(buffers: Buffer[]): Promise<Buffer> {
        const mergedPdf = await PDFDocument.create();

        for (const buffer of buffers) {
            const pdf = await PDFDocument.load(buffer);
            const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
            copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        const pdfBytes = await mergedPdf.save();
        return Buffer.from(pdfBytes);
    }

    /**
     * Splits a multi-page PDF into an array of single-page buffers.
     */
    async splitPdf(buffer: Buffer): Promise<Buffer[]> {
        const sourcePdf = await PDFDocument.load(buffer);
        const pageCount = sourcePdf.getPageCount();
        const outputBuffers: Buffer[] = [];

        for (let i = 0; i < pageCount; i++) {
            const newPdf = await PDFDocument.create();
            const [copiedPage] = await newPdf.copyPages(sourcePdf, [i]);
            newPdf.addPage(copiedPage);
            const pdfBytes = await newPdf.save();
            outputBuffers.push(Buffer.from(pdfBytes));
        }

        return outputBuffers;
    }

    /**
     * Removes specific pages from a PDF (0-indexed).
     * Returns a new PDF buffer with the specified pages removed.
     */
    async removePages(buffer: Buffer, pageIndicesToRemove: number[]): Promise<Buffer> {
        const sourcePdf = await PDFDocument.load(buffer);
        const totalPages = sourcePdf.getPageCount();
        const removeSet = new Set(pageIndicesToRemove);

        // Build list of pages to KEEP
        const keepIndices: number[] = [];
        for (let i = 0; i < totalPages; i++) {
            if (!removeSet.has(i)) keepIndices.push(i);
        }

        if (keepIndices.length === 0) throw new Error("Cannot remove all pages");

        const newPdf = await PDFDocument.create();
        const copiedPages = await newPdf.copyPages(sourcePdf, keepIndices);
        copiedPages.forEach(page => newPdf.addPage(page));

        const pdfBytes = await newPdf.save();
        return Buffer.from(pdfBytes);
    }
}

export const pdfEditor = new PDFEditor();
