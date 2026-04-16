/**
 * @file    extractor.ts
 * @purpose Handles PDF text extraction — text-based via pdf-parse, scanned via OpenRouter Gemini
 * @updated 2026-04-13
 *
 * Strategy:
 *   1. pdf-parse (fast, free) — works for digital/text PDFs
 *   2. OpenRouter google/gemini-2.5-flash (vision, ~65s for 22-page PDF) — works with PDF base64
 *   3. Free OpenRouter fallback models if Gemini credits run out
 */

// @ts-expect-error - No types available for pdf-parse
import pdfParse from "pdf-parse";

export interface PDFExtractionResult {
    rawText: string;
    pages: PageContent[];
    tables: TableData[];
    metadata: PDFMetadata;
    hasImages: boolean;
    ocrStrategy?: string;       // M1: Which extraction strategy succeeded (e.g., "pdf-parse", "anthropic", "openai", "openrouter", "gemini")
    ocrDurationMs?: number;     // M1: Time taken for extraction in milliseconds
}

export interface PageContent {
    pageNumber: number;
    text: string;
    hasTable: boolean;
}

export interface TableData {
    pageNumber: number;
    headers: string[];
    rows: string[][];
    confidence: number;
}

export interface PDFMetadata {
    pageCount: number;
    title?: string;
    author?: string;
    creationDate?: string;
    fileSize: number;
}

/**
 * Main entry point for PDF extraction.
 * Uses a tiered strategy: fast text parsing first, then table detection, 
 * and finally LLM-based OCR if the document appears to be scanned.
 */
export async function extractPDF(buffer: Buffer): Promise<PDFExtractionResult> {
    const startTime = Date.now();
    let parsed: any;
    try {
        parsed = await pdfParse(buffer, {
            max: 0,               // All pages
        });
    } catch (err: any) {
        console.warn(`⚠️ Fast PDF parse failed (${err.message}). Falling back to visual LLM OCR...`);
        return await extractScannedPDF(buffer, { rawText: "", tables: [], pageCount: 1 }, startTime);
    }

    const rawText = parsed.text;
    const pageCount = parsed.numpages;

    // Strategy 2: Detect and extract tables from text layout
    const tables = extractTablesFromText(rawText);

    // Strategy 3: If text is sparse (scanned PDF), flag for LLM fallback
    // Calculate density: characters per page
    const textDensity = rawText.replace(/\s/g, "").length / (pageCount * 1000);

    if (textDensity < 0.1) {
        // Scanned document — pass to LLM vision/document support
        return await extractScannedPDF(buffer, { rawText, tables, pageCount }, startTime);
    }

    return {
        rawText,
        pages: splitIntoPages(rawText, pageCount),
        tables,
        metadata: {
            pageCount,
            title: parsed.info?.Title,
            author: parsed.info?.Author,
            creationDate: parsed.info?.CreationDate,
            fileSize: buffer.length,
        },
        hasImages: textDensity < 0.3,
        ocrStrategy: "pdf-parse",
        ocrDurationMs: Date.now() - startTime,
    };
}

/**
 * Force LLM-based OCR extraction regardless of text density.
 * Used as a retry path when the fast pdf-parse extraction produces a suspicious
 * result (no PO, unbalanced totals, garbled text). Always escalates to the
 * strongest available vision model.
 */
export async function extractPDFWithLLM(buffer: Buffer): Promise<PDFExtractionResult> {
    const startTime = Date.now();
    let parsed: any;
    try {
        parsed = await pdfParse(buffer, { max: 0 });
    } catch {
        parsed = { text: "", numpages: 1 };
    }
    const rawText = parsed.text || "";
    const tables = extractTablesFromText(rawText);
    const pageCount = parsed.numpages || 1;
    console.log(`[extractor] Forced LLM OCR retry — bypassing text density check`);
    return await extractScannedPDF(buffer, { rawText, tables, pageCount }, startTime);
}

const SCANNED_PDF_PROMPT = "Extract all text from this invoice PDF. Include every line item, price, quantity, vendor name, invoice number, PO number, dates, addresses, and totals. Return the complete raw text content — do not summarize.";
const SCANNED_PDF_SYSTEM = "You are an expert OCR and document analysis engine. Extract ALL text from this PDF exactly as it appears. Preserve every number, date, vendor name, invoice number, PO number, line item, quantity, unit price, and total.";

/**
 * For scanned/image PDFs — passes the raw PDF bytes to OpenRouter Gemini 2.5 Flash.
 * OpenRouter Gemini supports PDF base64 directly (no file upload needed).
 * Fallback: free OpenRouter models if Gemini fails or credits run out.
 */
async function extractScannedPDF(
    buffer: Buffer,
    partial: { rawText: string; tables: TableData[]; pageCount: number },
    startTime: number = Date.now()
): Promise<PDFExtractionResult> {
    let extractedText = "";
    let successStrategy = "unknown";
    const base64 = buffer.toString("base64");

    const callOpenRouter = async (model: string): Promise<boolean> => {
        if (!process.env.OPENROUTER_API_KEY) return false;
        const controller = new AbortController();
        const tid = setTimeout(() => { console.warn(`[extractor] ${model} timed out after 120s`); controller.abort(); }, 120_000);
        try {
            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "https://aria.buildasoil.com",
                    "X-Title": "BuildASoil AP",
                },
                body: JSON.stringify({
                    model,
                    messages: [{
                        role: "user",
                        content: [
                            { type: "image_url", image_url: { url: `data:application/pdf;base64,${base64}` } },
                            { type: "text", text: `${SCANNED_PDF_SYSTEM}\n\n${SCANNED_PDF_PROMPT}` },
                        ],
                    }],
                }),
            });
            const data = await res.json() as any;
            if (data.error) { console.warn(`[extractor] ${model} error: ${data.error.message?.slice(0, 80)}`); return false; }
            extractedText = data.choices?.[0]?.message?.content || "";
            if (extractedText) { successStrategy = model; return true; }
            return false;
        } catch (err: any) {
            console.warn(`[extractor] ${model} failed: ${err.message.slice(0, 80)}`);
            return false;
        } finally { clearTimeout(tid); }
    };

    // Strategy 1: google/gemini-2.5-flash — works with PDF base64, fast, cheap
    console.log(`[extractor] Trying google/gemini-2.5-flash...`);
    if (await callOpenRouter("google/gemini-2.5-flash")) {
        console.log(`[extractor] ✅ google/gemini-2.5-flash — ${extractedText.length} chars`);
    }

    // Strategy 2: free fallback models on OpenRouter (no PDF base64 support — send as prompt text instead)
    if (!extractedText) {
        console.log(`[extractor] Trying free fallback...`);
        const freeModels = [
            "google/gemini-2.5-flash-preview",  // free tier
            "qwen/qwen3-8b",                      // free, good at text
        ];
        for (const model of freeModels) {
            if (await callOpenRouter(model)) {
                console.log(`[extractor] ✅ ${model} — ${extractedText.length} chars`);
                break;
            }
        }
    }

    if (!extractedText) {
        throw new Error(`[extractor] All OpenRouter strategies failed for PDF OCR`);
    }

    return {
        rawText: extractedText,
        pages: splitIntoPages(extractedText, partial.pageCount),
        tables: extractTablesFromText(extractedText),
        metadata: { pageCount: partial.pageCount, fileSize: buffer.length },
        hasImages: true,
        ocrStrategy: successStrategy,
        ocrDurationMs: Date.now() - startTime,
    };
}

/**
 * Detect tables in text using whitespace pattern analysis
 */
function extractTablesFromText(text: string): TableData[] {
    const tables: TableData[] = [];
    const lines = text.split("\n");
    let inTable = false;
    let tableLines: string[] = [];
    let pageNumber = 1;

    for (const line of lines) {
        // Look for 3+ columns separated by 2+ spaces
        const columnCount = line.trim().split(/\s{2,}|\t/).length;

        if (columnCount >= 3 && line.trim().length > 10) {
            if (!inTable) { inTable = true; tableLines = []; }
            tableLines.push(line);
        } else {
            if (inTable && tableLines.length >= 2) {
                tables.push(parseTableLines(tableLines, pageNumber));
            }
            inTable = false;
            if (line.includes("\x0C")) pageNumber++;
        }
    }

    return tables;
}

function parseTableLines(lines: string[], pageNumber: number): TableData {
    const splitLine = (line: string) => line.trim().split(/\s{2,}|\t/).filter(Boolean);
    const [headerLine, ...dataLines] = lines;
    const headers = splitLine(headerLine);
    const rows = dataLines.map(splitLine);

    return {
        pageNumber,
        headers,
        rows,
        confidence: headers.length >= 3 ? 0.8 : 0.5,
    };
}

/**
 * Split text into pages using form feed characters.
 * Fallback: if only 1 "page" detected but pageCount > 1, 
 * we split by pdf-lib (physical page extraction).
 */
function splitIntoPages(text: string, pageCount: number): PageContent[] {
    const markerPages = splitIntoPagesFromOCRMarkers(text);
    if (markerPages.length >= Math.max(1, Math.ceil(pageCount * 0.8))) {
        return markerPages;
    }

    const pages = text.split("\x0C"); // Form feed = page break

    // If form feed splitting worked, use it
    if (pages.length >= pageCount * 0.8) {
        return pages.map((pageText, i) => ({
            pageNumber: i + 1,
            text: pageText.trim(),
            hasTable: pageText.split(/\s{2,}/).length > 10,
        }));
    }

    // Fallback: form feeds didn't work, split text evenly by page count
    // This is approximate but better than one giant blob
    const avgCharsPerPage = Math.ceil(text.length / pageCount);
    const result: PageContent[] = [];
    for (let i = 0; i < pageCount; i++) {
        const start = i * avgCharsPerPage;
        const pageText = text.slice(start, start + avgCharsPerPage).trim();
        result.push({
            pageNumber: i + 1,
            text: pageText,
            hasTable: pageText.split(/\s{2,}/).length > 10,
        });
    }
    return result;
}

function splitIntoPagesFromOCRMarkers(text: string): PageContent[] {
    const markerRegex = /==Start of OCR for page\s+(\d+)==\s*([\s\S]*?)\s*==End of OCR for page\s+\1==/gi;
    const pages: PageContent[] = [];

    for (const match of text.matchAll(markerRegex)) {
        const pageNumber = Number(match[1]);
        const pageText = (match[2] || "").trim();

        pages.push({
            pageNumber: Number.isFinite(pageNumber) ? pageNumber : pages.length + 1,
            text: pageText,
            hasTable: pageText.split(/\s{2,}/).length > 10,
        });
    }

    return pages;
}

/**
 * Physical per-page extraction using pdf-lib + pdf-parse.
 * Splits the PDF into individual single-page PDFs, then extracts text from each.
 * More accurate than form-feed splitting for PDFs that don't use \x0C.
 */
export async function extractPerPage(buffer: Buffer): Promise<PageContent[]> {
    const { PDFDocument } = await import('pdf-lib');
    const sourcePdf = await PDFDocument.load(buffer);
    const totalPages = sourcePdf.getPageCount();
    const pages: PageContent[] = [];

    for (let i = 0; i < totalPages; i++) {
        const singlePagePdf = await PDFDocument.create();
        const [copiedPage] = await singlePagePdf.copyPages(sourcePdf, [i]);
        singlePagePdf.addPage(copiedPage);
        const singlePageBuffer = Buffer.from(await singlePagePdf.save());

        try {
            const parsed = await pdfParse(singlePageBuffer, { max: 0 });
            pages.push({
                pageNumber: i + 1,
                text: parsed.text.trim(),
                hasTable: parsed.text.split(/\s{2,}/).length > 10,
            });
        } catch {
            pages.push({ pageNumber: i + 1, text: '', hasTable: false });
        }
    }

    return pages;
}

