import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    createMock,
    saveArtifactMock,
    extractPDFMock,
    classifyDocumentMock,
    parseInvoiceMock,
} = vi.hoisted(() => ({
    createMock: vi.fn(),
    saveArtifactMock: vi.fn().mockResolvedValue({
        artifactId: "artifact-1",
    }),
    extractPDFMock: vi.fn(),
    classifyDocumentMock: vi.fn(),
    parseInvoiceMock: vi.fn(),
}));

vi.mock("openai", () => ({
    default: class OpenAI {
        chat = {
            completions: {
                create: createMock,
            },
        };
    },
}));

vi.mock("@/lib/copilot/artifacts", () => ({
    saveArtifact: saveArtifactMock,
}));

vi.mock("@/lib/pdf/extractor", () => ({
    extractPDF: extractPDFMock,
}));

vi.mock("@/lib/pdf/classifier", () => ({
    classifyDocument: classifyDocumentMock,
}));

vi.mock("@/lib/pdf/invoice-parser", () => ({
    parseInvoice: parseInvoiceMock,
}));

import { POST } from "./route";

describe("dashboard upload route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.OPENAI_API_KEY = "test-key";
        createMock.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: "Screenshot shows a ULINE cart with draft PO candidates.",
                    },
                },
            ],
        });
        extractPDFMock.mockResolvedValue({
            rawText: "Invoice 1001 from ULINE for shipping supplies",
        });
        classifyDocumentMock.mockResolvedValue({
            type: "INVOICE",
            confidence: 0.97,
        });
        parseInvoiceMock.mockResolvedValue({
            vendorName: "ULINE",
            invoiceNumber: "1001",
            poNumber: "PO-123",
            total: 799.7,
            dueDate: "2026-03-31",
            lineItems: [
                {
                    sku: "S-4551",
                    description: "30 x 15 x 15 box",
                    qty: 90,
                    unitPrice: 3.33,
                    total: 299.7,
                },
            ],
        });
    });

    it("persists image uploads as shared artifacts", async () => {
        const payload = {
            filename: "uline-cart.png",
            mimeType: "image/png",
            base64: Buffer.from("fake-image").toString("base64"),
        };

        const response = await POST(
            new Request("http://localhost/api/dashboard/upload", {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
            }),
        );

        expect(response.status).toBe(200);
        expect(saveArtifactMock).toHaveBeenCalledWith({
            threadId: "dashboard",
            channel: "dashboard",
            sourceType: "dashboard_upload",
            filename: "uline-cart.png",
            mimeType: "image/png",
            rawText: payload.base64,
            summary: "Screenshot shows a ULINE cart with draft PO candidates.",
            tags: ["dashboard", "upload"],
        });
    });

    it("persists PDF uploads with their classification metadata", async () => {
        const payload = {
            filename: "uline-invoice.pdf",
            mimeType: "application/pdf",
            base64: Buffer.from("fake-pdf").toString("base64"),
        };

        const response = await POST(
            new Request("http://localhost/api/dashboard/upload", {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
            }),
        );

        expect(response.status).toBe(200);
        expect(saveArtifactMock).toHaveBeenCalledWith(
            expect.objectContaining({
                threadId: "dashboard",
                channel: "dashboard",
                sourceType: "dashboard_upload",
                filename: "uline-invoice.pdf",
                mimeType: "application/pdf",
                rawText: "Invoice 1001 from ULINE for shipping supplies",
                structuredData: {
                    type: "INVOICE",
                    confidence: 0.97,
                },
                tags: ["dashboard", "upload", "invoice"],
            }),
        );
    });
});
