/**
 * @file    invoice-ocr-gate.test.ts
 * @purpose Unit tests for the pure classifier (classifyGateOutput) behind the
 *          pre-send OCR gate. No Python, no subprocess, no filesystem — the
 *          verdict logic is exercised against synthetic helper outputs that
 *          mirror real tesseract results for (a) a clean stamped invoice,
 *          (b) the CR Minerals weight-ticket leak, and (c) a failed redaction.
 * @author  Hermia
 * @created 2026-09-15
 * @deps    vitest, ./invoice-ocr-gate
 */

import { describe, it, expect } from "vitest";
import { classifyGateOutput, type GatePyOutput } from "./invoice-ocr-gate";

describe("classifyGateOutput", () => {
    it("passes a clean invoice with an invoice number and no customer number", () => {
        const out: GatePyOutput = {
            ok: true,
            rendered: true,
            invoiceNumberHits: ["64058402"],
            ticketHits: false,
            customerNumberHits: [],
            rawText: "INVOICE # 64058402 ...",
        };
        const r = classifyGateOutput(out);
        expect(r.verdict).toBe("pass");
        expect(r.invoiceNumbers).toContain("64058402");
        expect(r.ocrRan).toBe(true);
    });

    it("flags a weight ticket / BOL (ticket label, no invoice number)", () => {
        const out: GatePyOutput = {
            ok: true,
            rendered: true,
            invoiceNumberHits: [],
            ticketHits: true,
            customerNumberHits: [],
            rawText: "Ticket #: NMM000003464 PO#: PO#125180 ...",
        };
        const r = classifyGateOutput(out);
        expect(r.verdict).toBe("no_invoice_number");
        expect(r.ticketDetected).toBe(true);
    });

    it("flags a failed redaction (customer number still present)", () => {
        const out: GatePyOutput = {
            ok: true,
            rendered: true,
            invoiceNumberHits: ["64058402"],
            ticketHits: false,
            customerNumberHits: ["1159492"],
            rawText: "CUSTOMER NUMBER 1159492 ...",
        };
        const r = classifyGateOutput(out);
        expect(r.verdict).toBe("customer_number");
        expect(r.customerNumbers).toContain("1159492");
    });

    it("prioritizes customer_number over no_invoice_number when both signals present", () => {
        const out: GatePyOutput = {
            ok: true,
            rendered: true,
            invoiceNumberHits: [],
            ticketHits: true,
            customerNumberHits: ["1159492"],
            rawText: "Ticket # ... CUSTOMER NUMBER 1159492",
        };
        const r = classifyGateOutput(out);
        expect(r.verdict).toBe("customer_number");
    });

    it("flags no invoice number even without a ticket label", () => {
        const out: GatePyOutput = {
            ok: true,
            rendered: true,
            invoiceNumberHits: [],
            ticketHits: false,
            customerNumberHits: [],
            rawText: "some document with no identifiers",
        };
        const r = classifyGateOutput(out);
        expect(r.verdict).toBe("no_invoice_number");
    });

    it("returns skipped when the helper reports a render/OCR failure", () => {
        const out: GatePyOutput = { ok: false, error: "tesseract not available" };
        const r = classifyGateOutput(out);
        expect(r.verdict).toBe("skipped");
        expect(r.ocrRan).toBe(false);
        expect(r.reason).toContain("tesseract");
    });
});
