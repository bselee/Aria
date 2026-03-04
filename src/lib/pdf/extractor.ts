/**
 * @file    extractor.ts
 * @purpose Handles PDF text extraction with support for text-based and scanned PDFs.
 * @deps    pdf-parse, pdfjs-dist, anthropic-sdk
 */

// @ts-expect-error - No types available for pdf-parse
import pdfParse from "pdf-parse";
import { getAnthropicClient } from "../anthropic";

export interface PDFExtractionResult {
    rawText: string;
    pages: PageContent[];
    tables: TableData[];
    metadata: PDFMetadata;
    hasImages: boolean;
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
    // Strategy 1: pdf-parse for raw text (fast, handles most text PDFs)
    const parsed = await pdfParse(buffer, {
        max: 0,               // All pages
    });

    const rawText = parsed.text;
    const pageCount = parsed.numpages;

    // Strategy 2: Detect and extract tables from text layout
    const tables = extractTablesFromText(rawText);

    // Strategy 3: If text is sparse (scanned PDF), flag for LLM fallback
    // Calculate density: characters per page
    const textDensity = rawText.replace(/\s/g, "").length / (pageCount * 1000);

    if (textDensity < 0.1) {
        // Scanned document — pass to LLM vision/document support
        return await extractScannedPDF(buffer, { rawText, tables, pageCount });
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
    };
}

const SCANNED_PDF_PROMPT = "Extract all text from this invoice PDF. Include every line item, price, quantity, vendor name, invoice number, PO number, dates, addresses, and totals. Return the complete raw text content — do not summarize.";
const SCANNED_PDF_SYSTEM = "You are an expert OCR and document analysis engine. Extract ALL text from this PDF exactly as it appears. Preserve every number, date, vendor name, invoice number, PO number, line item, quantity, unit price, and total.";

/**
 * For scanned/image PDFs — passes the raw PDF bytes to an LLM with native PDF support.
 * Strategy order: Anthropic (A) → OpenAI Files API (B) → OpenRouter (C) → Gemini direct (D, last resort).
 * Gemini direct is last because the free-tier quota is 0 — it will always fail unless on a paid plan.
 */
async function extractScannedPDF(
    buffer: Buffer,
    partial: { rawText: string; tables: TableData[]; pageCount: number }
): Promise<PDFExtractionResult> {
    let extractedText = "";

    // Strategy A: Anthropic direct SDK (native PDF document blocks — cheap Haiku, paid key always available)
    console.log(`[extractor] Strategy A — Anthropic key: ${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);
    if (!extractedText && process.env.ANTHROPIC_API_KEY) {
        try {
            const anthropic = getAnthropicClient();
            const response = await anthropic.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 4000,
                system: SCANNED_PDF_SYSTEM,
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "document",
                                source: {
                                    type: "base64",
                                    media_type: "application/pdf",
                                    data: buffer.toString("base64"),
                                },
                            } as any,
                            { type: "text", text: SCANNED_PDF_PROMPT },
                        ],
                    },
                ],
            });
            extractedText = response.content
                .filter(b => b.type === "text")
                .map(b => (b as any).text)
                .join("\n");
            if (extractedText) console.log(`[extractor] Strategy B succeeded — ${extractedText.length} chars`);
        } catch (err: any) {
            console.warn("⚠️ Anthropic PDF extraction failed:", err.message);
        }
    }

    // Strategy B: OpenAI — upload PDF via Files API then reference by file_id in Responses API.
    // Split upload + inference avoids large base64 JSON bodies that can hang on slow connections.
    console.log(`[extractor] Strategy B — extractedText empty: ${!extractedText}, OpenAI key: ${process.env.OPENAI_API_KEY ? "SET" : "MISSING"}`);
    if (!extractedText && process.env.OPENAI_API_KEY) {
        let uploadedFileId: string | null = null;
        try {
            console.log("[extractor] Uploading PDF to OpenAI Files API...");
            const uploadController = new AbortController();
            const uploadTimeout = setTimeout(() => uploadController.abort(), 30_000);
            try {
                const formData = new FormData();
                formData.append("file", new Blob([buffer as unknown as BlobPart], { type: "application/pdf" }), "invoice.pdf");
                formData.append("purpose", "user_data");
                const uploadRes = await fetch("https://api.openai.com/v1/files", {
                    method: "POST",
                    signal: uploadController.signal,
                    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: formData,
                });
                console.log(`[extractor] OpenAI upload status: ${uploadRes.status}`);
                const uploadData = await uploadRes.json() as any;
                if (uploadData.error) throw new Error(JSON.stringify(uploadData.error));
                uploadedFileId = uploadData.id;
                console.log(`[extractor] OpenAI file uploaded: ${uploadedFileId}`);
            } finally {
                clearTimeout(uploadTimeout);
            }

            if (uploadedFileId) {
                const inferController = new AbortController();
                const inferTimeout = setTimeout(() => {
                    console.warn("[extractor] OpenAI inference timed out after 60s — aborting");
                    inferController.abort();
                }, 60_000);
                try {
                    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
                        method: "POST",
                        signal: inferController.signal,
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                        },
                        body: JSON.stringify({
                            model: "gpt-4o",
                            instructions: SCANNED_PDF_SYSTEM,
                            input: [{
                                role: "user",
                                content: [
                                    { type: "input_file", file_id: uploadedFileId },
                                    { type: "input_text", text: SCANNED_PDF_PROMPT },
                                ],
                            }],
                        }),
                    });
                    console.log(`[extractor] OpenAI Responses API status: ${openaiRes.status}`);
                    const openaiData = await openaiRes.json() as any;
                    if (openaiData.error) throw new Error(JSON.stringify(openaiData.error));
                    extractedText = openaiData.output?.[0]?.content?.[0]?.text || "";
                    console.log(`[extractor] Strategy C result — ${extractedText.length} chars`);
                } finally {
                    clearTimeout(inferTimeout);
                    // Best-effort cleanup: delete the uploaded file
                    fetch(`https://api.openai.com/v1/files/${uploadedFileId}`, {
                        method: "DELETE",
                        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
                    }).catch(() => {});
                }
            }
        } catch (err: any) {
            console.warn("⚠️ OpenAI PDF extraction failed:", err.message);
        }
    }

    // Strategy C: OpenRouter — Gemini 2.5 Flash Lite via OpenAI-compatible endpoint
    // Uses chat completions + image_url with PDF data URI (Gemini supports application/pdf)
    console.log(`[extractor] Strategy C — extractedText empty: ${!extractedText}, OpenRouter key: ${process.env.OPENROUTER_API_KEY ? "SET" : "MISSING"}`);
    if (!extractedText && process.env.OPENROUTER_API_KEY) {
        try {
            console.log("[extractor] Calling OpenRouter (Gemini 2.0 Flash)...");
            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                console.warn("[extractor] OpenRouter fetch timed out after 60s — aborting");
                controller.abort();
            }, 60_000);
            try {
                const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    signal: controller.signal,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                        "HTTP-Referer": "https://aria.buildasoil.com",
                        "X-Title": "Aria AP Agent",
                    },
                    body: JSON.stringify({
                        model: "google/gemini-2.5-flash-lite",
                        messages: [{
                            role: "user",
                            content: [
                                {
                                    type: "image_url",
                                    image_url: { url: `data:application/pdf;base64,${buffer.toString("base64")}` },
                                },
                                { type: "text", text: `${SCANNED_PDF_SYSTEM}\n\n${SCANNED_PDF_PROMPT}` },
                            ],
                        }],
                    }),
                });
                console.log(`[extractor] OpenRouter HTTP status: ${orRes.status}`);
                const orData = await orRes.json() as any;
                if (orData.error) throw new Error(JSON.stringify(orData.error));
                extractedText = orData.choices?.[0]?.message?.content || "";
                console.log(`[extractor] Strategy D result — ${extractedText.length} chars`);
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (err: any) {
            console.warn("⚠️ OpenRouter PDF extraction failed:", err.message);
        }
    }

    // Strategy D: Gemini direct REST API — last resort only.
    // Free-tier quota is 0 (always fails unless on a paid Gemini plan). Kept as final fallback.
    console.log(`[extractor] Strategy D — extractedText empty: ${!extractedText}, Gemini key: ${process.env.GOOGLE_GENERATIVE_AI_API_KEY ? "SET" : "MISSING"}`);
    if (!extractedText && process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
        try {
            const geminiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_GENERATIVE_AI_API_KEY}`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: SCANNED_PDF_SYSTEM }] },
                        contents: [{
                            parts: [
                                { inlineData: { mimeType: "application/pdf", data: buffer.toString("base64") } },
                                { text: SCANNED_PDF_PROMPT },
                            ],
                        }],
                    }),
                }
            );
            const geminiData = await geminiRes.json() as any;
            if (geminiData.error) throw new Error(geminiData.error.message);
            extractedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (extractedText) console.log(`[extractor] Strategy D succeeded — ${extractedText.length} chars`);
        } catch (err: any) {
            console.warn("⚠️ Gemini PDF extraction failed:", err.message);
        }
    }

    if (!extractedText) {
        throw new Error("Scanned PDF extraction failed — Anthropic, OpenAI, OpenRouter, and Gemini all unavailable. Check API keys/credits.");
    }

    return {
        rawText: extractedText,
        pages: splitIntoPages(extractedText, partial.pageCount),
        tables: extractTablesFromText(extractedText),
        metadata: {
            pageCount: partial.pageCount,
            fileSize: buffer.length,
        },
        hasImages: true,
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

