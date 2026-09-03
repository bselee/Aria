/**
 * @file    repair-failed-invoices.test.ts
 * @purpose Regression tests for the failed-invoice repair CLI's core decision:
 *          deterministic regex (extractPDF + normalizeInvoiceForDb with
 *          parsed=null) must recover money/identity fields from real invoice
 *          PDFs that the LLM mangled. Locks the PO 125212 / Aloe Corp 3327
 *          class of failures (2026-08-27).
 * @author  Hermia
 * @created 2026-08-27
 * @deps    vitest, @/lib/pdf/extractor, @/lib/pdf/invoice-field-normalize
 */
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ createClient: vi.fn(() => null) }));

// The CLI itself is exercised via its imported pure pieces; the module's
// main() requires a live DB so we only unit-test the decision logic here.
import { normalizeInvoiceForDb, computeExtractionQuality, extractInvoiceFieldsFromOcrText } from "../lib/pdf/invoice-field-normalize";

const ALOE_TEXT = `Customer No.
Customer PO Number
1/1
125212
C0000275
08/21/2026
Document Number
3327
Due Date
09/20/2026
Invoice Subtotal:
 3,960.00 $
Total Amount: 3,960.00 $
`;

describe("repair path — deterministic regex recovers LLM-mangled invoices", () => {
    it("recovers PO 125212 + $3,960 + inv 3327 + date 8/21 from raw text alone", () => {
        // parsed=null is exactly what the repair CLI passes (regex-only path)
        const norm = normalizeInvoiceForDb(null, ALOE_TEXT, {});
        expect(norm.poNumber).toBe("125212");
        expect(norm.total).toBe(3960);
        expect(norm.invoiceNumber).toBe("3327");
        expect(norm.invoiceDate).toBe("2026-08-21");
        expect(computeExtractionQuality({ total: norm.total, invoiceNumber: norm.invoiceNumber }))
            .toBe("complete");
    });

    it("never fabricates a total when the text has no labeled amount", () => {
        const norm = normalizeInvoiceForDb(null, "PO 99999\nInvoice #123\nNo money here", {});
        expect(norm.total).toBe(0);
        expect(norm.invoiceNumber).toBe("123");
    });

    it("regex layer returns clean fields without any LLM call", () => {
        // extractInvoiceFieldsFromOcrText is pure — the CLI's speedup claim
        const fb = extractInvoiceFieldsFromOcrText(ALOE_TEXT);
        expect(fb.poNumber).toBe("125212");
        expect(fb.total).toBe(3960);
        expect(fb.invoiceNumber).toBe("3327");
    });
});
