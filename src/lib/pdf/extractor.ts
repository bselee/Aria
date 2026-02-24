/**
 * @file    extractor.ts
 * @purpose Handles PDF text extraction with support for text-based and scanned PDFs.
 * @deps    pdf-parse, pdfjs-dist, anthropic-sdk
 */

import pdfParse from "pdf-parse";
import { unifiedTextGeneration } from "../intelligence/llm";

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

/**
 * For scanned/image PDFs — utilizes LLM document capabilities.
 * Currently defaults to Anthropic's native PDF support via unified service logic
 * but falls back to OpenAI if needed.
 */
async function extractScannedPDF(
    buffer: Buffer,
    partial: { rawText: string; tables: TableData[]; pageCount: number }
): Promise<PDFExtractionResult> {
    // Note: unifiedTextGeneration currently handles text, but for scanned PDFs
    // we would ideally need multi-modal support. 
    // For now, we'll use a specific prompt and the raw text we DID get (if any).
    // If it's truly zero text, the LLM will struggle without the actual buffer.

    // DECISION(2026-02-20): Using unifiedTextGeneration to handle the "sparse text" case.
    // In a future update, we can pass the actual base64 to the unified service if it supports multi-modal.

    const extractedText = await unifiedTextGeneration({
        system: "You are an expert OCR and document analysis engine.",
        prompt: `The following document text was extracted with low confidence (likely scanned). 
        Please clean it up, fix any typos, and ensure all data points (dates, amounts, vendor names) are preserved.
        
        PARTIAL TEXT:
        ${partial.rawText.slice(0, 4000)}`
    });

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

function splitIntoPages(text: string, pageCount: number): PageContent[] {
    const pages = text.split("\x0C"); // Form feed = page break
    return pages.map((pageText, i) => ({
        pageNumber: i + 1,
        text: pageText.trim(),
        hasTable: pageText.split(/\s{2,}/).length > 10,
    }));
}
