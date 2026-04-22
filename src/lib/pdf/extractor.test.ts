import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedPdfParse } = vi.hoisted(() => ({
    mockedPdfParse: vi.fn(),
}));

vi.mock("pdf-parse", () => ({
    default: mockedPdfParse,
}));

import { extractPDF } from "./extractor";

describe("extractPDF", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    });

    it("preserves OCR page markers as page boundaries instead of evenly chunking the full document", async () => {
        mockedPdfParse.mockResolvedValue({
            text: "",
            numpages: 3,
            info: {},
        });

        const longCoverSheet = Array.from({ length: 120 }, (_, index) => `SUMMARY LINE ${index + 1}`).join("\n");
        const ocrText = [
            "==Start of OCR for page 1==",
            "AAA COOPER TRANSPORTATION",
            "STATEMENT SUMMARY",
            longCoverSheet,
            "==End of OCR for page 1==",
            "==Start of OCR for page 2==",
            "AAA COOPER TRANSPORTATION",
            "INVOICE",
            "PRO NUMBER 64471587",
            "AMOUNT DUE $815.85",
            "==End of OCR for page 2==",
            "==Start of OCR for page 3==",
            "AAA COOPER TRANSPORTATION",
            "BILL OF LADING",
            "DELIVERY RECEIPT",
            "==End of OCR for page 3==",
        ].join("\n");

        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: ocrText,
                        },
                    },
                ],
            }),
        }));

        const result = await extractPDF(Buffer.from("fake-pdf"));

        expect(result.ocrStrategy).toBe("google/gemini-2.5-flash");
        expect(result.pages).toHaveLength(3);
        expect(result.pages[0].text).toContain("STATEMENT SUMMARY");
        expect(result.pages[0].text).not.toContain("PRO NUMBER 64471587");
        expect(result.pages[1].text).not.toContain("SUMMARY LINE 80");
        expect(result.pages[1].text).toContain("INVOICE");
        expect(result.pages[1].text).toContain("PRO NUMBER 64471587");
        expect(result.pages[2].text).toContain("BILL OF LADING");
        expect(result.pages[2].text).not.toContain("AMOUNT DUE $815.85");
    });
});
