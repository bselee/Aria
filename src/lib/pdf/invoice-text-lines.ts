/**
 * @file    src/lib/pdf/invoice-text-lines.ts
 * @purpose Read goods lines from the invoice text layer. The PDF is the invoice.
 *          An empty line_items column is a missed read, not proof the page has no lines.
 * @author  Hermia
 * @created 2026-09-23
 * @deps    none
 * @env     none
 */

export interface InvoiceTextLine {
    sku: string;
    description: string;
    qty: number;
    unitPrice: number;
    total: number;
}

export interface InvoiceTextRead {
    lines: InvoiceTextLine[];
    balanced: boolean;
    poNumber: string | null;
}

const MONEY = /^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?)\s*$/;
const LEADING_QTY = /^(\d+(?:\.\d{1,4})?)\s+[A-Za-z]/;
const PO_MARK = /\bP\.?\s*O\.?\s*#?\s*:?\s*\d{4,6}\b/i;
const SKIP_DESC = /^(item code|description|qty|quantity|price|unit price|amount|total|extended|uom|unit)$/i;
const NOT_GOODS = /freight|shipping|handling|sales tax|^tax\b|finance charge/i;

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function keepPrice(n: number): number {
    return Math.round(n * 10000) / 10000;
}

function close(a: number, b: number): boolean {
    return Math.abs(a - b) <= 0.02;
}

function parseMoney(line: string): number | null {
    const match = line.trim().match(MONEY);
    if (!match) return null;
    const raw = match[1].replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    // A bare 4–6 digit integer is a purchase order or invoice number, not a price.
    if (!raw.includes(".") && n >= 1000) return null;
    return n;
}

function findTotal(text: string, known?: number | null): number | null {
    if (known && known > 0) return known;
    const patterns = [
        /invoice\s+total\s*:?\s*\$?\s*([0-9,]+\.\d{2})/i,
        /total\s+invoice\s*:?\s*\$?\s*([0-9,]+\.\d{2})/i,
        /amount\s+due\s*:?\s*\$?\s*([0-9,]+\.\d{2})/i,
        /balance\s+due\s*:?\s*\$?\s*([0-9,]+\.\d{2})/i,
        /(?:^|\n)\s*total\s*:?\s*\$\s*([0-9,]+\.\d{2})/i,
    ];
    for (const re of patterns) {
        const match = text.match(re);
        if (!match) continue;
        const n = Number(match[1].replace(/,/g, ""));
        if (n > 0) return n;
    }
    return null;
}

function pageTotal(text: string, known?: number | null): number | null {
    const labeled = findTotal(text, known);
    if (labeled) return labeled;
    const amounts = [...text.matchAll(/\$\s*([0-9,]+\.\d{2})/g)]
        .map((match) => Number(match[1].replace(/,/g, "")));
    const last = amounts[amounts.length - 1];
    return last > 0 ? last : null;
}

function finishRead(
    goods: InvoiceTextLine[],
    freightAndTax: number,
    text: string,
    knownTotal?: number | null,
): InvoiceTextRead {
    const total = pageTotal(text, knownTotal);
    const explained = round2(goods.reduce((sum, line) => sum + line.total, 0) + freightAndTax);
    const balanced = goods.length > 0 && total != null && close(explained, round2(total));
    return {
        lines: balanced ? goods : [],
        balanced,
        poNumber: findPo(text),
    };
}

function compactTriple(line: string): { qty: number; unitPrice: number; ext: number } | null {
    const compact = line.replace(/\s+/g, "");
    const split = compact.match(/^(.*[A-Za-z].*?)(\d[\d.]{2,})$/);
    if (!split) return null;
    const tail = split[2];
    for (let extLen = 4; extLen <= 12 && extLen < tail.length; extLen++) {
        const extStr = tail.slice(-extLen);
        if (!/^\d+\.\d{2}$/.test(extStr)) continue;
        const rest = tail.slice(0, -extLen);
        for (let priceLen = 4; priceLen <= 10 && priceLen < rest.length; priceLen++) {
            const priceStr = rest.slice(-priceLen);
            if (!/^\d+\.\d{2,4}$/.test(priceStr)) continue;
            const qtyStr = rest.slice(0, -priceLen);
            if (!/^\d+(?:\.\d{1,4})?$/.test(qtyStr)) continue;
            const qty = Number(qtyStr);
            const price = Number(priceStr);
            const ext = Number(extStr);
            if (qty <= 0 || qty > 100000 || price <= 0) continue;
            if (!close(round2(qty * price), round2(ext))) continue;
            return { qty, unitPrice: keepPrice(price), ext: round2(ext) };
        }
    }
    return null;
}

function columnTriple(line: string): { qty: number; unitPrice: number; ext: number } | null {
    const tokens = [...line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.\d+|\b\d+\b/g)]
        .map((match) => ({ raw: match[0], n: Number(match[0].replace(/,/g, "")) }))
        .filter((token) => Number.isFinite(token.n) && token.n > 0 && token.n < 1_000_000);
    const ext = [...tokens].reverse().find((token) => /\.\d{2}$/.test(token.raw));
    if (!ext) return null;
    const extAt = tokens.indexOf(ext);
    for (let i = extAt - 1; i >= 0; i--) {
        const price = tokens[i].n;
        if (price <= 0) continue;
        const quotient = ext.n / price;
        const qty = tokens.slice(0, i).find((token) => close(token.n, quotient));
        if (!qty) continue;
        if (!close(round2(qty.n * price), round2(ext.n))) continue;
        return { qty: qty.n, unitPrice: keepPrice(price), ext: round2(ext.n) };
    }
    return null;
}

function normalizeRow(line: string): string {
    return line
        .replace(/\$/g, "")
        .replace(/(\d),(\d)/g, "$1$2")
        .replace(/\t/g, "")
        .replace(/(lb|ea|cs|bag|ton)$/i, "");
}

function prefixedTriple(line: string): { qty: number; unitPrice: number; ext: number } | null {
    const compact = normalizeRow(line).replace(/\s+/g, "");
    const lead = compact.match(/^(\d+(?:\.\d{1,4})?)(?=[A-Za-z])/);
    if (!lead) return null;
    const qty = Number(lead[1]);
    if (qty <= 0 || qty > 100000) return null;
    const afterQty = compact.slice(lead[1].length);
    const lastLetter = afterQty.search(/[A-Za-z][^A-Za-z]*$/);
    if (lastLetter < 0) return null;
    const tail = afterQty.slice(lastLetter + 1);
    for (let extLen = 4; extLen <= 12 && extLen < tail.length; extLen++) {
        const extStr = tail.slice(-extLen);
        if (!/^\d+\.\d{2}$/.test(extStr)) continue;
        const priceStr = tail.slice(0, -extLen);
        if (!/^\d+\.\d{2,4}$/.test(priceStr)) continue;
        const price = Number(priceStr);
        const ext = Number(extStr);
        if (price <= 0) continue;
        if (!close(round2(qty * price), round2(ext))) continue;
        return { qty, unitPrice: keepPrice(price), ext: round2(ext) };
    }
    return null;
}

function numericTriple(line: string): { qty: number; unitPrice: number; ext: number } | null {
    const compact = normalizeRow(line).replace(/\s+/g, "");
    if (!/^\d[\d.]+$/.test(compact)) return null;
    for (let extLen = 4; extLen <= 12 && extLen < compact.length; extLen++) {
        const extStr = compact.slice(-extLen);
        if (!/^\d+\.\d{2}$/.test(extStr)) continue;
        const rest = compact.slice(0, -extLen);
        for (let priceLen = 4; priceLen <= 10 && priceLen < rest.length; priceLen++) {
            const priceStr = rest.slice(-priceLen);
            if (!/^\d+\.\d{2,4}$/.test(priceStr)) continue;
            const qtyStr = rest.slice(0, -priceLen);
            if (!/^\d+(?:\.\d{1,4})?$/.test(qtyStr)) continue;
            const qty = Number(qtyStr);
            const price = Number(priceStr);
            const ext = Number(extStr);
            if (qty <= 0 || qty > 100000 || price <= 0) continue;
            if (!close(round2(qty * price), round2(ext))) continue;
            return { qty, unitPrice: keepPrice(price), ext: round2(ext) };
        }
    }
    return null;
}

function feeAmount(line: string): { description: string; amount: number } | null {
    const cleaned = normalizeRow(line).replace(/\s+/g, " ").trim();
    if (!/^(freight|shipping|handling|sales tax|tax|fuel)/i.test(cleaned)) return null;
    const amounts = [...cleaned.matchAll(/(\d+\.\d{2})/g)].map((match) => Number(match[1]));
    const amount = amounts[amounts.length - 1];
    if (!amount || amount <= 0) return null;
    return { description: cleaned, amount };
}

function tripleOnLine(line: string): { qty: number; unitPrice: number; ext: number } | null {
    const cleaned = normalizeRow(line);
    const hit = compactTriple(cleaned) ?? columnTriple(cleaned) ?? prefixedTriple(cleaned) ?? numericTriple(cleaned);
    return hit;
}

function describeLine(line: string): string {
    return line
        .replace(/\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d*\.\d+|\$?\b\d+\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function linesOnSameRow(rows: string[]): { goods: InvoiceTextLine[]; freightAndTax: number } {
    const goods: InvoiceTextLine[] = [];
    let freightAndTax = 0;
    for (let i = 0; i < rows.length; i++) {
        const fee = feeAmount(rows[i]);
        const hit = tripleOnLine(rows[i]);
        if (!hit) {
            if (fee) freightAndTax = round2(freightAndTax + fee.amount);
            continue;
        }
        const wraps: string[] = [];
        for (let j = i + 1; j < rows.length && wraps.length < 3; j++) {
            if (tripleOnLine(rows[j]) || feeAmount(rows[j])) break;
            if (PO_MARK.test(rows[j]) || /^\$/.test(rows[j])) break;
            if (/^(total|subtotal|invoice|balance|amount due|b\/l|ship|unit:|load:|driver|terms:|restocking)/i.test(rows[j])) break;
            if (!/[A-Za-z]/.test(rows[j])) break;
            wraps.push(rows[j]);
        }
        const rawDesc = [describeLine(rows[i]), ...wraps].join(" ") || describeLine(rows[i - 1] || "");
        let description = rawDesc.replace(/[^A-Za-z0-9 .'&/-]/g, " ").replace(/\b(lb|ea|cs|bag|ton)\b/gi, " ").replace(/\s+/g, " ").trim();
        if (!/[A-Za-z]/.test(description)) {
            description = describeLine(rows[i - 1] || "").replace(/[^A-Za-z0-9 .'&/-]/g, " ").replace(/\s+/g, " ").trim();
        }
        if (!description || /eachpallets|quantitydescription|unitprice/i.test(description.replace(/\s/g, ""))) continue;
        if (NOT_GOODS.test(description)) {
            freightAndTax = round2(freightAndTax + hit.ext);
            continue;
        }
        goods.push({
            sku: "",
            description,
            qty: hit.qty,
            unitPrice: hit.unitPrice,
            total: hit.ext,
        });
    }
    return { goods, freightAndTax };
}

function findPo(text: string): string | null {
    const match = text.match(/\bP\.?\s*O\.?\s*(?:number|num|no|#)?\s*:?\s*#?\s*(1\d{5})\b/i)
        || text.match(/\bPO\s*#\s*(1\d{5})\b/i);
    return match?.[1] ?? null;
}

function descriptionFor(rows: string[], start: number, end: number): string {
    const textish = (line: string) =>
        parseMoney(line) == null
        && !LEADING_QTY.test(line)
        && !PO_MARK.test(line)
        && !SKIP_DESC.test(line)
        && /[A-Za-z]/.test(line);
    const between = rows.slice(start, end + 1).filter(textish);
    if (between.length > 0) return between.join(" ").replace(/\s+/g, " ").trim();
    const before: string[] = [];
    for (let i = start - 1; i >= 0 && before.length < 3; i--) {
        const line = rows[i];
        if (parseMoney(line) != null || LEADING_QTY.test(line)) break;
        if (SKIP_DESC.test(line) || /^p\.?\s*o\.?\b/i.test(line) || /^(invoice|bill to|ship to)$/i.test(line)) break;
        before.unshift(line);
    }
    return before.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Pull quantity, unit price, and extended amount from invoice text.
 * A line is kept only when quantity times unit price matches the extended amount.
 * The set is returned only when those extended amounts match the printed total.
 * A finance charge or a statement of several invoices has no such set.
 *
 * @param rawText - Text layer of the stored invoice PDF
 * @param knownTotal - Printed invoice total, when already known
 * @returns Balanced goods lines, or an empty list when the page does not balance
 */
export function extractGoodsLinesFromInvoiceText(
    rawText: string,
    knownTotal?: number | null,
): InvoiceTextRead {
    const text = rawText || "";
    const rows = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const same = linesOnSameRow(rows);
    const sameRow = finishRead(same.goods, same.freightAndTax, text, knownTotal);
    if (sameRow.balanced) return sameRow;
    const nums: Array<{ value: number; index: number }> = [];
    rows.forEach((line, index) => {
        const money = parseMoney(line);
        if (money != null) {
            nums.push({ value: money, index });
            return;
        }
        const lead = line.match(LEADING_QTY);
        if (!lead) return;
        const n = Number(lead[1]);
        if (n > 0 && n < 100000) nums.push({ value: n, index });
    });

    const used = new Set<number>();
    const goods: InvoiceTextLine[] = [];
    let freightAndTax = 0;
    for (let a = 0; a < nums.length; a++) {
        if (used.has(a)) continue;
        let best: { b: number; c: number; span: number } | null = null;
        for (let b = a + 1; b < nums.length; b++) {
            if (used.has(b)) continue;
            if (nums[b].index - nums[a].index > 8) break;
            for (let c = b + 1; c < nums.length; c++) {
                if (used.has(c)) continue;
                if (nums[c].index - nums[a].index > 8) break;
                if (!close(round2(nums[a].value * nums[b].value), round2(nums[c].value))) continue;
                if (nums[a].value > 100000 || nums[b].value > 100000) continue;
                const span = nums[c].index - nums[a].index;
                if (!best || span < best.span) best = { b, c, span };
            }
        }
        if (!best) continue;
        used.add(a);
        used.add(best.b);
        used.add(best.c);
        const description = descriptionFor(rows, nums[a].index, nums[best.c].index);
        if (!description) continue;
        const ext = round2(nums[best.c].value);
        if (NOT_GOODS.test(description)) {
            freightAndTax = round2(freightAndTax + ext);
            continue;
        }
        goods.push({
            sku: "",
            description,
            qty: nums[a].value,
            unitPrice: keepPrice(nums[best.b].value),
            total: ext,
        });
    }

    return finishRead(goods, freightAndTax, text, knownTotal);
}

/**
 * True when the stored row has no usable quantity and unit price.
 * That is a missed read. Open the PDF.
 *
 * @param lineItems - Stored or previously parsed lines
 */
export function invoiceLinesNeedPdfRead(lineItems: unknown): boolean {
    if (!Array.isArray(lineItems) || lineItems.length === 0) return true;
    return lineItems.every((item) => {
        const row = item as { unitPrice?: unknown; unit_price?: unknown; qty?: unknown; quantity?: unknown };
        const price = Number(row.unitPrice ?? row.unit_price ?? 0);
        const qty = Number(row.qty ?? row.quantity ?? 0);
        return !(price > 0 && qty > 0);
    });
}
