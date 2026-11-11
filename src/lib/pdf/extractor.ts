/**
 * @file    extractor.ts
 * @purpose Handles PDF text extraction — text-based via pdf-parse, scanned via OpenRouter Gemini
 * @updated 2026-11-11
 *
 * Strategy:
 *   1. pdf-parse (fast, free) — works for digital/text PDFs
 *   2. OpenRouter google/gemini-2.5-flash (vision, ~65s for 22-page PDF) — works with PDF base64
 *   3. Cheap OpenRouter vision models if Gemini credits run out
 *   4. Local render + tesseract CLI (zero cost) — last resort when no LLM credits exist
 *
 * HERMIA(2026-11-11): Strategy 4 replaced the old tesseract.js branch, which was
 * dead twice over — `import("tesseract.js").recognize` is undefined under the CJS
 * default-export wrapper, AND tesseract cannot read a PDF buffer at all (it needs
 * rasterized pixels). Now delegates to the same PyMuPDF+tesseract primitive the
 * AP pre-send gate uses (scripts/invoice-ocr-gate.py), so scanned BOLs still
 * yield tracking numbers when every LLM provider is out of credits.
 */

// @ts-expect-error - No types available for pdf-parse
import pdfParse from "pdf-parse";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

    // KAIZEN #8: memoize base64 once per call so multi-strategy fallbacks
    // don't re-encode the same buffer. First strategy that needs it pays
    // the cost; subsequent strategies hit the cache.
    let _base64Cache: string | undefined;
    const toBase64 = () => {
        if (_base64Cache) return _base64Cache;
        _base64Cache = buffer.toString("base64");
        return _base64Cache;
    };

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
                            { type: "image_url", image_url: { url: `data:application/pdf;base64,${toBase64()}` } },
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

    // Strategy 2: cheap fallback models on OpenRouter when Gemini fails
    // HERMIA(2026-11-11): the previous list was three-for-three dead — an invalid
    // id (gemini-2.5-flash-preview 404), a text-only model (deepseek-v4-flash has
    // no image endpoints), and a deprecated one (qwen3-8b, retired Oct 2026).
    // Every scan burned three guaranteed-fail round-trips before reaching local OCR.
    if (!extractedText) {
            console.log(`[extractor] Trying cheap fallback models...`);
            const freeModels = [
                "deepseek/deepseek-v4.1-flash-1017", // ~$0.01/M in, image-capable
                "qwen/qwen3.7-flash",                // ~$0.03/M in, image-capable
                "z-ai/glm-5.3-flash",                // ~$0.04/M in, image-capable
            ];
            for (const model of freeModels) {
                if (await callOpenRouter(model)) {
                    console.log(`[extractor] ✅ ${model} — ${extractedText.length} chars`);
                    break;
                }
            }
        }

        // Strategy 3: local render + tesseract CLI — zero LLM cost last resort
        if (!extractedText) {
            console.log(`[extractor] Trying local render + tesseract OCR...`);
            const localText = await localOcrFallback(buffer);
            if (localText.trim().length > 50) {
                extractedText = localText;
                successStrategy = "local-ocr:tesseract";
                console.log(`[extractor] ✅ local tesseract OCR — ${extractedText.length} chars`);
            } else {
                console.warn(`[extractor] local tesseract OCR returned insufficient text`);
            }
        }

        if (!extractedText) {
        throw new Error(`[extractor] All OCR strategies failed (OpenRouter vision + local tesseract)`);
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
 * Resolve the Python render+OCR helper script. Delegates to the same primitive
 * the AP pre-send gate uses (scripts/invoice-ocr-gate.py) instead of duplicating
 * PyMuPDF/tesseract logic here.
 *
 * Tries cwd first (correct for CLI runs and Next.js server routes, where cwd is
 * the repo root) then falls back to a path walk from __dirname (compiled trees).
 *
 * @returns absolute script path, or null when the script is not on disk
 */
function localOcrScriptPath(): string | null {
    const candidates = [
        join(process.cwd(), "scripts", "invoice-ocr-gate.py"),
        resolve(join(__dirname, "..", "..", "..", "scripts", "invoice-ocr-gate.py")),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Resolve a Python interpreter that has PyMuPDF. Bare `python` is unreliable
 * (node subprocesses can inherit a runtime venv without pymupdf); on Windows
 * prefer the `py -3` launcher. ARIA_PYTHON overrides everything.
 */
function localOcrPython(): { cmd: string; args: string[] } {
    if (process.env.ARIA_PYTHON) return { cmd: process.env.ARIA_PYTHON, args: [] };
    if (process.platform === "win32") return { cmd: "py", args: ["-3"] };
    return { cmd: "python3", args: [] };
}

/** Hard cap on the local OCR subprocess (page-1 render at 300 DPI + tesseract). */
const LOCAL_OCR_TIMEOUT_MS = 120_000;

/**
 * Zero-cost OCR fallback for scanned PDFs: render page 1 with PyMuPDF and OCR it
 * with the tesseract CLI, via scripts/invoice-ocr-gate.py.
 *
 * Used only when every LLM vision strategy fails (no credits, provider outage).
 * Never throws — returns "" so the caller can report a clean extraction failure.
 *
 * @param buffer  raw PDF bytes
 * @returns OCR text (first ~2500 chars as emitted by the helper), or "" on failure
 */
async function localOcrFallback(buffer: Buffer): Promise<string> {
    const scriptPath = localOcrScriptPath();
    if (!scriptPath) {
        console.warn(`[extractor] local OCR skipped — scripts/invoice-ocr-gate.py not found`);
        return "";
    }

    let tmpDir: string;
    try {
        tmpDir = mkdtempSync(join(tmpdir(), "aria-extract-ocr-"));
        writeFileSync(join(tmpDir, "doc.pdf"), buffer);
    } catch (err: any) {
        console.warn(`[extractor] local OCR temp write failed: ${String(err?.message).slice(0, 80)}`);
        return "";
    }

    const py = localOcrPython();
    const pdfPath = join(tmpDir, "doc.pdf");

    return await new Promise<string>((resolveText) => {
        let stdout = "";
        let settled = false;
        const finish = (text: string) => {
            if (settled) return;
            settled = true;
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
            resolveText(text);
        };

        let child;
        try {
            child = spawn(py.cmd, [...py.args, scriptPath, pdfPath], { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err: any) {
            console.warn(`[extractor] local OCR spawn failed: ${String(err?.message).slice(0, 80)}`);
            finish("");
            return;
        }

        const timer = setTimeout(() => {
            console.warn(`[extractor] local OCR timed out after ${LOCAL_OCR_TIMEOUT_MS / 1000}s`);
            try { child.kill(); } catch { /* ignore */ }
            finish("");
        }, LOCAL_OCR_TIMEOUT_MS);

        child.stdout?.on("data", (d) => { stdout += d.toString(); });
        child.stderr?.on("data", () => { /* helper logs noise on stderr; ignore */ });
        child.on("error", (err: any) => {
            clearTimeout(timer);
            console.warn(`[extractor] local OCR process error: ${String(err?.message).slice(0, 80)}`);
            finish("");
        });
        child.on("close", () => {
            clearTimeout(timer);
            try {
                const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; rawText?: string; error?: string };
                if (parsed.ok && parsed.rawText) { finish(parsed.rawText); return; }
                console.warn(`[extractor] local OCR helper reported: ${parsed.error || "no text"}`);
            } catch {
                console.warn(`[extractor] local OCR returned unparseable output`);
            }
            finish("");
        });
    });
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

