/**
 * @file    ed-invoice.ts
 * @purpose Black-and-white Organic AG (Ed Zybura) invoice builder.
 *          Invoice number is always the Finale PO number. No colored banner.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    node:child_process, node:fs, node:os, node:path
 * @env     none
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Known Organic AG SKU labels when Finale itemDescription is blank. */
export const ED_SKU_LABELS: Readonly<Record<string, string>> = {
    PPD101: "15-1-1 (1# bags)",
};

export interface EdInvoiceLine {
    sku: string;
    description: string;
    qty: number;
    unitPrice: number;
    total: number;
}

export interface EdInvoiceSpec {
    invoiceNumber: string;
    poNumber: string;
    invoiceDate: string;
    shipDate: string;
    terms: string;
    vendorName: string;
    billTo: string[];
    lines: EdInvoiceLine[];
    subtotal: number;
    freight: number;
    freightLabel: string;
    total: number;
    tracking: string | null;
    notes: string;
}

export interface EdInvoiceFromPoInput {
    poNumber: string;
    orderDate?: string | null;
    items: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
        description?: string | null;
    }>;
    freight: number;
    tracking?: string | null;
    shipped?: string | null;
    freightLabel?: string;
}

/**
 * Format a USD amount with two decimals. Thousands separator on >= 1000.
 */
export function formatUsd(n: number): string {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    const [whole, frac] = abs.toFixed(2).split(".");
    const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${sign}$${withCommas}.${frac}`;
}

/**
 * Round to cents using banker's-unfriendly half-up via toFixed.
 */
export function cents(n: number): number {
    return Number(n.toFixed(2));
}

/**
 * Collapse UPS tracking to 1Z + 16 alphanumerics. Returns null if unusable.
 */
export function normalizeUpsTracking(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const compact = raw.replace(/[\s-]/g, "").toUpperCase();
    if (/^1Z[A-Z0-9]{16}$/.test(compact)) return compact;
    return compact.length >= 10 ? compact : null;
}

/**
 * Accept 8-24-26, 8/24/2026, or 2026-08-24. Two-digit years map to 2000+.
 */
export function parseCasualDate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return trimmed;
    const casual = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
    if (!casual) return null;
    const month = casual[1].padStart(2, "0");
    const day = casual[2].padStart(2, "0");
    const yearPart = casual[3];
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    return `${year}-${month}-${day}`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function lineDescription(item: EdInvoiceFromPoInput["items"][number]): string {
    const sku = (item.productId || "").trim();
    const fromPo = (item.description || "").trim();
    if (fromPo) return fromPo.includes(sku) || !sku ? fromPo : `${fromPo} ${sku}`;
    const known = sku ? ED_SKU_LABELS[sku] : undefined;
    if (known && sku) return `${known} ${sku}`;
    return sku || "Item";
}

/**
 * Build the invoice spec. Invoice number is always the PO number.
 */
export function buildEdInvoiceSpec(input: EdInvoiceFromPoInput): EdInvoiceSpec {
    const poNumber = String(input.poNumber).replace(/^#/, "").trim();
    if (!poNumber) {
        throw new Error("PO number is required");
    }
    const freight = cents(input.freight);
    if (!Number.isFinite(freight) || freight < 0) {
        throw new Error(`Invalid freight: ${input.freight}`);
    }

    const lines: EdInvoiceLine[] = input.items
        .filter((item) => item.productId && item.quantity > 0)
        .map((item) => {
            const qty = item.quantity;
            const unitPrice = cents(item.unitPrice);
            return {
                sku: item.productId,
                description: lineDescription(item),
                qty,
                unitPrice,
                total: cents(qty * unitPrice),
            };
        });

    if (lines.length === 0) {
        throw new Error(`PO ${poNumber} has no invoiceable lines`);
    }

    const subtotal = cents(lines.reduce((sum, line) => sum + line.total, 0));
    const total = cents(subtotal + freight);
    const shipDate = parseCasualDate(input.shipped) || parseCasualDate(input.orderDate) || "";
    const tracking = normalizeUpsTracking(input.tracking);
    const freightLabel = input.freightLabel || "UPS Ground";
    const noteParts = [
        tracking ? `${freightLabel} ${tracking}` : freightLabel,
        shipDate ? `Shipped ${shipDate}` : null,
    ].filter((part): part is string => Boolean(part));

    return {
        invoiceNumber: poNumber,
        poNumber,
        invoiceDate: shipDate || new Date().toISOString().slice(0, 10),
        shipDate,
        terms: "Net 30",
        vendorName: "Organic AG Products",
        billTo: ["BuildASoil", "1455 Branding Iron Dr", "Montrose, CO 81401"],
        lines,
        subtotal,
        freight,
        freightLabel,
        total,
        tracking,
        notes: noteParts.join(". ") + ".",
    };
}

/**
 * Black-and-white Letter HTML. No colored banner, no generated-document footer.
 */
export function buildEdInvoiceHtml(spec: EdInvoiceSpec): string {
    const lineRows = spec.lines
        .map(
            (line) => `      <tr>
        <td>${escapeHtml(line.description)}</td>
        <td class="r">${line.qty}</td>
        <td class="r">${formatUsd(line.unitPrice)}</td>
        <td class="r">${formatUsd(line.total)}</td>
      </tr>`
        )
        .join("\n");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice ${escapeHtml(spec.invoiceNumber)}</title>
<style>
  @page { size: Letter; margin: 0.7in; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    font: 10.5pt/1.4 "Segoe UI", Arial, Helvetica, sans-serif;
  }
  h1 {
    margin: 0 0 2px;
    font-size: 16pt;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .doctype {
    font-size: 11pt;
    letter-spacing: 0.12em;
    margin-bottom: 14px;
  }
  hr { border: none; border-top: 1px solid #000; margin: 0 0 18px; }
  .row { display: flex; justify-content: space-between; gap: 32px; margin-bottom: 22px; }
  .label { font-weight: 700; font-size: 8.5pt; margin: 0 0 4px; }
  .muted { color: #222; }
  .meta { text-align: right; min-width: 240px; }
  .meta table { border-collapse: collapse; margin-left: auto; }
  .meta td { padding: 1px 0 1px 16px; vertical-align: top; }
  .meta td:first-child { font-weight: 700; padding-left: 0; text-align: left; }
  table.lines { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.lines th {
    text-align: left;
    border-bottom: 1px solid #000;
    padding: 4px 6px 6px 0;
    font-size: 8.5pt;
  }
  table.lines td { padding: 8px 6px 8px 0; border-bottom: 1px solid #ccc; }
  table.lines th.r, table.lines td.r { text-align: right; padding-right: 0; }
  .qty { width: 10%; }
  .unit { width: 16%; }
  .amt { width: 16%; }
  .totals { width: 260px; margin: 16px 0 0 auto; border-collapse: collapse; }
  .totals td { padding: 3px 0; }
  .totals td.r { text-align: right; }
  .totals tr.grand td {
    border-top: 1px solid #000;
    font-weight: 700;
    padding-top: 8px;
  }
  .notes { margin-top: 28px; }
  .notes p { margin: 4px 0 0; }
</style>
</head>
<body>
  <h1>${escapeHtml(spec.vendorName)}</h1>
  <div class="doctype">INVOICE</div>
  <hr>
  <div class="row">
    <div>
      <div class="label">Bill To</div>
      <div>${escapeHtml(spec.billTo[0] || "")}</div>
      <div class="muted">${escapeHtml(spec.billTo[1] || "")}</div>
      <div class="muted">${escapeHtml(spec.billTo[2] || "")}</div>
    </div>
    <div class="meta">
      <table>
        <tr><td>Invoice #</td><td>${escapeHtml(spec.invoiceNumber)}</td></tr>
        <tr><td>Date</td><td>${escapeHtml(spec.invoiceDate)}</td></tr>
        <tr><td>PO</td><td>${escapeHtml(spec.poNumber)}</td></tr>
        <tr><td>Terms</td><td>${escapeHtml(spec.terms)}</td></tr>
      </table>
    </div>
  </div>
  <table class="lines">
    <thead>
      <tr>
        <th>Description</th>
        <th class="r qty">Qty</th>
        <th class="r unit">Unit Price</th>
        <th class="r amt">Total</th>
      </tr>
    </thead>
    <tbody>
${lineRows}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${formatUsd(spec.subtotal)}</td></tr>
    <tr><td>${escapeHtml(spec.freightLabel)}</td><td class="r">${formatUsd(spec.freight)}</td></tr>
    <tr class="grand"><td>Total</td><td class="r">${formatUsd(spec.total)}</td></tr>
  </table>
  <div class="notes">
    <div class="label">Notes</div>
    <p>${escapeHtml(spec.notes)}</p>
  </div>
</body>
</html>
`;
}

const CHROME_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

/**
 * First installed Chrome or Edge binary, or null.
 */
export function findChromium(): string | null {
    return CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
}

/**
 * Print the invoice HTML to a Letter PDF via headless Chrome/Edge.
 *
 * @param spec - Built invoice spec
 * @param outPath - Destination PDF path (Windows-native)
 * @returns Absolute output path
 */
export function renderEdInvoicePdf(spec: EdInvoiceSpec, outPath: string): string {
    const chrome = findChromium();
    if (!chrome) {
        throw new Error("Chrome or Edge not found for --print-to-pdf");
    }
    const dir = mkdtempSync(join(tmpdir(), "ed-invoice-"));
    const htmlPath = join(dir, `invoice-${spec.invoiceNumber}.html`);
    writeFileSync(htmlPath, buildEdInvoiceHtml(spec), "utf8");
    const fileUrl = `file:///${htmlPath.replace(/\\/g, "/")}`;
    execFileSync(
        chrome,
        ["--headless", "--disable-gpu", `--print-to-pdf=${outPath}`, "--no-pdf-header-footer", fileUrl],
        { timeout: 30_000 }
    );
    if (!existsSync(outPath)) {
        throw new Error(`Chrome did not write ${outPath}`);
    }
    return outPath;
}
