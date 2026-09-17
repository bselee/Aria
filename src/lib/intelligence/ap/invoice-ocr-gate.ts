/**
 * @file    src/lib/intelligence/ap/invoice-ocr-gate.ts
 * @purpose Pre-send OCR gate: render page 1 of a prepared AP invoice PDF,
 *          OCR it with tesseract (via the Python render+OCR primitive in
 *          scripts/invoice-ocr-gate.py), and assert the two signals that
 *          decide whether Bill.com will key the bill correctly:
 *
 *            1. invoice number present (no invoice# = weight ticket / BOL /
 *               payment confirmation — NOT an invoice, Bill.com mints a
 *               phantom bill from a ticket# / PO# / customer#)
 *            2. customer number absent (AAA Cooper "1159492" — after redaction
 *               this must be gone, else Bill.com keys the bill on it)
 *
 *          This is the deterministic confidence layer behind the forward path.
 *          It runs on the FINAL prepared bytes (post stamp + redact + trim),
 *          so it verifies exactly what Bill.com will receive. No network, no
 *          Bill.com dependency, no WAF.
 *
 *          NON-BLOCKING CONTRACT (Bill Selee): the gate NEVER blocks a bill
 *          from reaching Bill.com. It returns a verdict; the caller logs the
 *          result and sends regardless. On any failure (Python missing,
 *          tesseract missing, render error) it degrades to `skipped`.
 *
 * @author  Hermia
 * @created 2026-09-15
 * @deps    child_process (spawn), scripts/invoice-ocr-gate.py (PyMuPDF + tesseract CLI)
 * @env     none (falls back to skipped when tooling is absent)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Highest-level outcome of the gate. */
export type OcrGateVerdict =
    | "pass"               // invoice# present, customer# absent
    | "no_invoice_number"  // looks like a weight ticket / BOL / non-invoice
    | "customer_number"    // redaction failed — contaminant still present
    | "skipped";           // tooling unavailable or render/OCR failed

/** Full structured result from the gate. */
export interface OcrGateResult {
    verdict: OcrGateVerdict;
    /** Human-readable reason, safe for logs. */
    reason: string;
    /** Invoice-number tokens OCR found (empty when none). */
    invoiceNumbers: string[];
    /** True when OCR found a "Ticket #" label (weight-ticket signal). */
    ticketDetected: boolean;
    /** Contaminant customer numbers still present in the render. */
    customerNumbers: string[];
    /** First ~2.5k chars of OCR text (diagnostic only). */
    rawText: string;
    /** True when the Python/tesseract subprocess ran; false when skipped. */
    ocrRan: boolean;
}

/** Raw JSON contract emitted by scripts/invoice-ocr-gate.py. */
export interface GatePyOutput {
    ok: boolean;
    rendered?: boolean;
    error?: string;
    invoiceNumberHits?: string[];
    ticketHits?: boolean;
    customerNumberHits?: string[];
    rawText?: string;
}

/**
 * Classify the Python helper's raw output into a verdict. Pure function —
 * no I/O, no Python — so it is directly unit-testable with synthetic outputs.
 *
 * @param out  parsed JSON from scripts/invoice-ocr-gate.py
 */
export function classifyGateOutput(out: GatePyOutput): OcrGateResult {
    const empty: OcrGateResult = {
        verdict: "skipped",
        reason: "gate unavailable",
        invoiceNumbers: [],
        ticketDetected: false,
        customerNumbers: [],
        rawText: "",
        ocrRan: false,
    };

    if (!out.ok || !out.rendered) {
        return { ...empty, reason: out.error || "render failed" };
    }

    const invoiceNumbers = (out.invoiceNumberHits || []).slice();
    const customerNumbers = (out.customerNumberHits || []).slice();
    const ticketDetected = Boolean(out.ticketHits);
    const rawText = out.rawText || "";

    // 1. Contaminant customer number still present → redaction failed.
    if (customerNumbers.length > 0) {
        return {
            verdict: "customer_number",
            reason: `customer number still present after redaction: ${customerNumbers.join(", ")}`,
            invoiceNumbers,
            ticketDetected,
            customerNumbers,
            rawText,
            ocrRan: true,
        };
    }

    // 2. No invoice number, and a ticket label present → non-invoice document.
    if (invoiceNumbers.length === 0 && ticketDetected) {
        return {
            verdict: "no_invoice_number",
            reason: "weight ticket / BOL / non-invoice (no invoice#, ticket label present)",
            invoiceNumbers,
            ticketDetected,
            customerNumbers,
            rawText,
            ocrRan: true,
        };
    }

    // 3. No invoice number at all → can't confirm, but not a confirmed ticket.
    if (invoiceNumbers.length === 0) {
        return {
            verdict: "no_invoice_number",
            reason: "no invoice number detected in render",
            invoiceNumbers,
            ticketDetected,
            customerNumbers,
            rawText,
            ocrRan: true,
        };
    }

    return {
        verdict: "pass",
        reason: `invoice# ${invoiceNumbers[0]}`,
        invoiceNumbers,
        ticketDetected,
        customerNumbers,
        rawText,
        ocrRan: true,
    };
}

/** Timeout for the Python render+OCR subprocess (ms). */
const GATE_TIMEOUT_MS = 60_000;

/**
 * Resolve the Python helper script path. Works from the compiled dist/ tree
 * (scripts/ sits at repo root, four levels above src/lib/intelligence/ap/).
 */
function gateScriptPath(): string {
    return resolve(join(__dirname, "..", "..", "..", "..", "scripts", "invoice-ocr-gate.py"));
}

/**
 * Resolve a Python interpreter that has PyMuPDF. The bare `python` on PATH is
 * unreliable (node subprocesses can inherit Hermes's runtime Python, which
 * lacks pymupdf). On Windows prefer the `py -3` launcher, which maps to the
 * system CPython; allow an explicit override via ARIA_PYTHON.
 */
function pythonCommand(): { cmd: string; args: string[] } {
    if (process.env.ARIA_PYTHON) {
        return { cmd: process.env.ARIA_PYTHON, args: [] };
    }
    if (process.platform === "win32") {
        return { cmd: "py", args: ["-3"] };
    }
    return { cmd: "python3", args: [] };
}

/**
 * Run the Python render+OCR helper against a PDF buffer.
 *
 * @param pdfBuffer  prepared PDF bytes (post stamp/redact/trim)
 * @returns parsed GatePyOutput, or a synthetic `{ok:false}` on failure
 */
function runGatePython(pdfBuffer: Buffer): Promise<GatePyOutput> {
    return new Promise((resolveP) => {
        let tmpDir: string | null = null;
        let pdfPath: string;
        try {
            tmpDir = mkdtempSync(join(tmpdir(), "ocr-gate-"));
            pdfPath = join(tmpDir, "invoice.pdf");
            writeFileSync(pdfPath, pdfBuffer);
        } catch {
            resolveP({ ok: false, error: "temp file write failed" });
            return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (out: GatePyOutput) => {
            if (settled) return;
            settled = true;
            if (tmpDir) {
                try {
                    rmSync(tmpDir, { recursive: true, force: true });
                } catch {
                    /* ignore cleanup errors */
                }
            }
            resolveP(out);
        };

        const child = spawn(pythonCommand().cmd, [...pythonCommand().args, gateScriptPath(), pdfPath], {
            stdio: ["ignore", "pipe", "pipe"],
        });

        const timer = setTimeout(() => {
            child.kill();
            finish({ ok: false, error: "gate subprocess timed out" });
        }, GATE_TIMEOUT_MS);

        child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString("utf-8");
        });
        child.stderr.on("data", (d: Buffer) => {
            stderr += d.toString("utf-8");
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            finish({ ok: false, error: `spawn failed: ${err.message}` });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                finish({ ok: false, error: `exit ${code}: ${stderr.trim().slice(0, 200)}` });
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim()) as GatePyOutput;
                finish(parsed);
            } catch {
                finish({ ok: false, error: `bad JSON: ${stdout.trim().slice(0, 120)}` });
            }
        });
    });
}

/**
 * Run the pre-send OCR gate on a prepared invoice PDF.
 *
 * Renders page 1 at 300 DPI and OCRs it, then classifies:
 *   - `no_invoice_number`  — no invoice# found AND a "Ticket #" label present
 *                            (weight ticket / BOL / delivery receipt)
 *   - `customer_number`    — the AAA Cooper customer number "1159492" is still
 *                            present (redaction failed)
 *   - `pass`               — invoice# found and no contaminant customer number
 *   - `skipped`            — tooling unavailable or subprocess failed
 *
 * NEVER throws. NEVER blocks the forward — the caller sends regardless and
 * records the verdict.
 *
 * @param pdfBuffer  prepared PDF bytes (post stamp/redact/trim)
 */
export async function verifyInvoiceForBillCom(pdfBuffer: Buffer): Promise<OcrGateResult> {
    const empty: OcrGateResult = {
        verdict: "skipped",
        reason: "gate unavailable",
        invoiceNumbers: [],
        ticketDetected: false,
        customerNumbers: [],
        rawText: "",
        ocrRan: false,
    };

    if (!pdfBuffer || pdfBuffer.length === 0) {
        return { ...empty, reason: "empty buffer" };
    }

    let out: GatePyOutput;
    try {
        out = await runGatePython(pdfBuffer);
    } catch (err) {
        return { ...empty, reason: `gate threw: ${(err as Error).message}` };
    }

    return classifyGateOutput(out);
}

// ── Anchor-relative redaction locator (2026-09-17 plan 4.3) ─────────────────

/** A white-out region on page 1 in PDF points, top-left origin. */
export interface CustomerBox {
    x1: number;
    yTop1: number;
    x2: number;
    yTop2: number;
}

/** Raw JSON contract of `invoice-ocr-gate.py --locate-customer`. */
interface LocatePyOutput {
    ok: boolean;
    boxes?: CustomerBox[];
    customerNumberHits?: string[];
    error?: string | null;
}

/**
 * Locate the customer-number contaminant on page 1 by OCR (tesseract TSV word
 * boxes) and return white-out boxes in PDF points. Used BEFORE stamping so the
 * redaction follows the actual text position instead of hardcoded template
 * coordinates — one template shift no longer silently un-redacts the number.
 *
 * NEVER throws. Returns null when tooling is unavailable or nothing matched —
 * the caller then falls back to the static template boxes.
 *
 * @param pdfBuffer  ORIGINAL (pre-redaction) PDF bytes
 */
export async function locateCustomerNumberBoxes(
    pdfBuffer: Buffer,
): Promise<{ boxes: CustomerBox[]; hits: string[] } | null> {
    if (!pdfBuffer || pdfBuffer.length === 0) return null;

    return new Promise((resolveP) => {
        let tmpDir: string | null = null;
        let pdfPath: string;
        try {
            tmpDir = mkdtempSync(join(tmpdir(), "ocr-locate-"));
            pdfPath = join(tmpDir, "invoice.pdf");
            writeFileSync(pdfPath, pdfBuffer);
        } catch {
            resolveP(null);
            return;
        }

        let stdout = "";
        let settled = false;
        const finish = (out: { boxes: CustomerBox[]; hits: string[] } | null) => {
            if (settled) return;
            settled = true;
            if (tmpDir) {
                try {
                    rmSync(tmpDir, { recursive: true, force: true });
                } catch {
                    /* ignore */
                }
            }
            resolveP(out);
        };

        const child = spawn(
            pythonCommand().cmd,
            [...pythonCommand().args, gateScriptPath(), "--locate-customer", pdfPath],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        const timer = setTimeout(() => {
            child.kill();
            finish(null);
        }, GATE_TIMEOUT_MS);

        child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString("utf-8");
        });
        child.on("error", () => {
            clearTimeout(timer);
            finish(null);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                finish(null);
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim()) as LocatePyOutput;
                if (!parsed.ok || !parsed.boxes?.length) {
                    finish(null);
                    return;
                }
                finish({ boxes: parsed.boxes, hits: parsed.customerNumberHits || [] });
            } catch {
                finish(null);
            }
        });
    });
}
