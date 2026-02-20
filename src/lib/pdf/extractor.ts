import pdfParse from "pdf-parse";
import * as pdfLib from "pdfjs-dist";
import Anthropic from "@anthropic-ai/sdk";

let anthropicClient: Anthropic | null = null;

function getAnthropic() {
    if (!anthropicClient) {
        anthropicClient = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
    }
    return anthropicClient;
}

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

export async function extractPDF(buffer: Buffer): Promise<PDFExtractionResult> {
    // Strategy 1: pdf-parse for raw text (fast, handles most text PDFs)
    const parsed = await pdfParse(buffer, {
        max: 0,               // All pages
    });

    const rawText = parsed.text;
    const pageCount = parsed.numpages;

    // Strategy 2: Detect and extract tables from text layout
    const tables = extractTablesFromText(rawText);

    // Strategy 3: If text is sparse (scanned PDF), flag for OCR fallback
    const textDensity = rawText.replace(/\s/g, "").length / (pageCount * 1000);
    if (textDensity < 0.1) {
        // Scanned document — pass to Claude vision
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

// For scanned/image PDFs — send to Claude vision
async function extractScannedPDF(
    buffer: Buffer,
    partial: { rawText: string; tables: TableData[]; pageCount: number }
): Promise<PDFExtractionResult> {
    const base64 = buffer.toString("base64");

    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{
            role: "user",
            content: [
                {
                    type: "document",
                    source: { type: "base64", media_type: "application/pdf", data: base64 },
                },
                {
                    type: "text",
                    text: `Extract ALL text from this scanned document. Include every number, date, address, and line item exactly as shown. Format tables as pipe-delimited rows.`,
                }
            ],
        }],
    });

    const extractedText = response.content[0].type === "text" ? response.content[0].text : "";

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

// Detect tables in text using whitespace pattern analysis
function extractTablesFromText(text: string): TableData[] {
    const tables: TableData[] = [];
    const lines = text.split("\n");
    let inTable = false;
    let tableLines: string[] = [];
    let pageNumber = 1;

    for (const line of lines) {
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
