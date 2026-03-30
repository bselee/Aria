/**
 * Gold-sample invoice regression tests.
 *
 * These test the deterministic extraction layer (regex PO, vendor parsers,
 * shipping-to-freight) against real vendor OCR text samples. The LLM is
 * mocked to return a deliberately weak parse — the test verifies that the
 * deterministic corrections produce the expected output.
 *
 * To add a new vendor: drop a .txt + .expected.json in fixtures/invoices/
 */

import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { unifiedObjectGenerationMock } = vi.hoisted(() => ({
    unifiedObjectGenerationMock: vi.fn(),
}));

vi.mock("../lib/intelligence/llm", () => ({
    unifiedObjectGeneration: unifiedObjectGenerationMock,
}));

import { parseInvoice, extractPOByRegex } from "../lib/pdf/invoice-parser";

const FIXTURES_DIR = path.join(__dirname, "fixtures", "invoices");

interface ExpectedFields {
    vendorName?: string;
    poNumber?: string;
    freight?: number;
    total?: number;
    lineItemCount?: number;
    lineItemDescriptionContains?: string;
}

// Discover all fixture pairs
const fixtures: Array<{ name: string; text: string; expected: ExpectedFields }> = [];
if (fs.existsSync(FIXTURES_DIR)) {
    for (const file of fs.readdirSync(FIXTURES_DIR)) {
        if (!file.endsWith(".txt")) continue;
        const baseName = file.replace(/\.txt$/, "");
        const expectedPath = path.join(FIXTURES_DIR, `${baseName}.expected.json`);
        if (!fs.existsSync(expectedPath)) continue;
        fixtures.push({
            name: baseName,
            text: fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8"),
            expected: JSON.parse(fs.readFileSync(expectedPath, "utf-8")),
        });
    }
}

describe("Gold-sample invoice regression", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    for (const fixture of fixtures) {
        describe(fixture.name, () => {
            it("extractPOByRegex finds the PO number", () => {
                if (!fixture.expected.poNumber) return;
                const po = extractPOByRegex(fixture.text);
                expect(po).toBe(fixture.expected.poNumber);
            });

            it("parseInvoice produces correct critical fields", async () => {
                // Mock LLM to return a deliberately weak parse — no PO, no freight,
                // shipping left in line items. The deterministic layer must fix it.
                unifiedObjectGenerationMock.mockResolvedValue({
                    documentType: "invoice",
                    invoiceNumber: "UNKNOWN",
                    poNumber: null,
                    vendorName: "UNKNOWN",
                    invoiceDate: "2026-01-01",
                    lineItems: [
                        { description: "GroAloe Powder 1 Kilo", qty: 20, unitPrice: 230, total: 4600 },
                        { description: "Shipping and Handling", qty: 1, unitPrice: 88.72, total: 88.72 },
                    ],
                    subtotal: 4600,
                    freight: null,
                    total: fixture.expected.total || 0,
                    amountDue: fixture.expected.total || 0,
                    confidence: "medium",
                });

                const invoice = await parseInvoice(fixture.text);

                if (fixture.expected.poNumber) {
                    expect(invoice.poNumber).toBe(fixture.expected.poNumber);
                }
                if (fixture.expected.vendorName) {
                    expect(invoice.vendorName).toBe(fixture.expected.vendorName);
                }
                if (fixture.expected.freight !== undefined) {
                    expect(invoice.freight).toBe(fixture.expected.freight);
                }
                if (fixture.expected.lineItemCount !== undefined) {
                    expect(invoice.lineItems).toHaveLength(fixture.expected.lineItemCount);
                }
                if (fixture.expected.lineItemDescriptionContains) {
                    expect(
                        invoice.lineItems.some(li =>
                            li.description.includes(fixture.expected.lineItemDescriptionContains!)
                        )
                    ).toBe(true);
                }
            });
        });
    }

    it("has at least one fixture loaded", () => {
        expect(fixtures.length).toBeGreaterThan(0);
    });
});
