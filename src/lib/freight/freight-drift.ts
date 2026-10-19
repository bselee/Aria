/**
 * @file    freight-drift.ts
 * @purpose Shared booked-vs-actual freight drift computation. Fetches the FedEx
 *          Freight final invoices (freight@ mailbox + Billtrust CSV) and the LTL
 *          Select "booked" quote/scanned amounts, joins on PRO number, and
 *          returns drift rows = actual − booked (a positive reweigh/accessorial).
 *
 *          Both `reconcile-freight-mailbox.ts` (--drift) and the Friday
 *          `scripts/eow-purchasing-week.ts` PDF use this so there is ONE source
 *          of truth for drift.
 *
 * @author  Hermia
 * @created 2026-10-19
 * @deps    @googleapis/gmail, ltlselect/client, ltlselect/match,
 *          cli/reconcile-billtrust-freight, pdftotext (poppler on PATH)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 *          LTL_SELECT_*
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getAuthenticatedClient } from "../gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { VENDOR_ORIGIN_MAP, parseCollectEntry } from "../ltlselect/match";
import {
    loadLtlSelectEnv,
    getLtlSelectToken,
    fetchLtlSelectInvoices,
} from "../ltlselect/client";
import {
    findLatestBilltrustCsv,
    parseBilltrustCsv,
    dedupInboundInvoices,
    type BilltrustInvoice,
} from "../../cli/reconcile-billtrust-freight";

const NOTICE_SENDER = "from:fedex@billtrust.com";
const TMP_PDF_DIR = path.join(process.cwd(), ".tmp", "fedex-mailbox-pdfs");

/** One per-shipment FedEx Freight invoice parsed from a notice PDF. */
export interface FreightInvoice {
    freightBillNumber: string;
    shipDate: string; // MM/DD/YYYY
    invoiceDate: string; // MM/DD/YYYY
    terms: string; // COLLECT | PREPAID
    poNumber: string;
    bol: string;
    amountDue: number;
    shipper: string;
    vendor: string | null;
}

/** One booked-vs-actual drift row, joined on PRO number. */
export interface FreightDriftRow {
    vendor: string | null;
    pro: string;
    poNumber: string;
    booked: number;   // LTL Select amount (scanned invoice total, quote fallback)
    quote: number;    // LTL Select original quote
    actual: number;   // final FedEx invoice amount
    drift: number;    // actual − booked
}

/** Resolve a vendor from the full invoice block (shipper name + address). */
function resolveVendorFromBlock(block: string): string | null {
    for (const { alias, vendor } of VENDOR_ORIGIN_MAP) {
        if (alias.test(block)) return vendor;
    }
    return null;
}

/** Extract every per-shipment invoice from a FedEx Freight batch PDF's text. */
function parseFreightInvoicesFromText(text: string): FreightInvoice[] {
    const blocks = text.split(/Freight Bill Number/i);
    const out: FreightInvoice[] = [];
    for (const block of blocks) {
        const fb = block.match(/(\d{9,})/);
        if (!fb) continue;
        const freightBillNumber = fb[1];

        const shipInv = block.match(
            /Ship Date\s*\/\s*Invoice Date\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*\/\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
        );
        const terms = block.match(/Terms\s+(COLLECT|PREPAID)/i)?.[1]?.toUpperCase() || "";
        const po = block.match(/P\.?O\.?\s*Number\s*(?:Order\s*#\s*)?(\d{6})\b/i);
        const bol = block.match(/Bill of Lading Number\s+([A-Za-z0-9]+)/i);
        const amt = block.match(/Total Amount Due\s+([\d,]+\.\d{2})/i);
        const shipper = block.match(/Shipper\s+([A-Za-z0-9 ,&'.()/-]{2,50})/i);

        if (!terms) continue; // not an invoice header block

        out.push({
            freightBillNumber,
            shipDate: shipInv?.[1] || "",
            invoiceDate: shipInv?.[2] || "",
            terms,
            poNumber: po?.[1] || "",
            bol: bol?.[1] || "",
            amountDue: parseFloat((amt?.[1] || "0").replace(/,/g, "")) || 0,
            shipper: shipper?.[1]?.trim() || "",
            vendor: resolveVendorFromBlock(block),
        });
    }
    return out;
}

/** Download the PDF attachment and return its `pdftotext -layout` text. */
function pdfTextForAttachment(pdfPath: string): string {
    const txtPath = pdfPath.replace(/\.pdf$/i, ".txt");
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath], { stdio: "pipe" });
    return fs.readFileSync(txtPath, "utf-8");
}

/** Convert a Billtrust CSV inbound invoice into the shared FreightInvoice shape. */
function billtrustToFreightInvoice(bi: BilltrustInvoice): FreightInvoice {
    const poMatch = bi.poNumber.match(/\b(\d{6})\b/);
    return {
        freightBillNumber: bi.invoiceNumber,
        shipDate: bi.shipDate,
        invoiceDate: bi.invoiceDate,
        terms: bi.terms,
        poNumber: poMatch ? poMatch[1] : "",
        bol: bi.bol,
        amountDue: bi.amountDue,
        shipper: bi.shipFromAddress,
        vendor: bi.vendorName,
    };
}

function parseUsDate(s: string): string {
    const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return "";
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * Fetch the final FedEx Freight invoices from the freight@ mailbox (FedEx
 * Billing Online notices) folded with the Billtrust CSV, deduped by freight
 * bill number, filtered to inbound COLLECT.
 */
export async function fetchFinalFreightInvoices(csvPathOverride?: string | null): Promise<FreightInvoice[]> {
    const auth = await getAuthenticatedClient("freight");
    const gmail = GmailApi({ version: "v1", auth });
    const list = await gmail.users.messages.list({ userId: "me", q: NOTICE_SENDER, maxResults: 100 });
    const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);

    fs.mkdirSync(TMP_PDF_DIR, { recursive: true });

    const invoices: FreightInvoice[] = [];
    for (const id of ids) {
        const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const parts = msg.data.payload?.parts || [];
        const pdfParts = parts.filter((p) => p.mimeType === "application/pdf" && p.body?.attachmentId);
        for (const p of pdfParts) {
            const att = await gmail.users.messages.attachments.get({
                userId: "me", messageId: id, id: p.body.attachmentId,
            });
            const buf = Buffer.from(att.data.data || "", "base64");
            const pdfPath = path.join(TMP_PDF_DIR, `${id}_${p.filename}`);
            fs.writeFileSync(pdfPath, buf);
            let text = "";
            try {
                text = pdfTextForAttachment(pdfPath);
            } catch {
                continue;
            }
            invoices.push(...parseFreightInvoicesFromText(text));
        }
    }

    const csvPath = csvPathOverride || findLatestBilltrustCsv();
    if (csvPath && fs.existsSync(csvPath)) {
        try {
            const csvInvoices = dedupInboundInvoices(parseBilltrustCsv(csvPath)).map(billtrustToFreightInvoice);
            invoices.push(...csvInvoices);
        } catch {
            /* CSV optional */
        }
    }

    const seen = new Map<string, FreightInvoice>();
    for (const inv of invoices) {
        if (!seen.has(inv.freightBillNumber)) seen.set(inv.freightBillNumber, inv);
    }
    const all = [...seen.values()].sort((a, b) =>
        (parseUsDate(b.invoiceDate) || "").localeCompare(parseUsDate(a.invoiceDate) || ""),
    );
    return all.filter((i) => i.terms === "COLLECT");
}

/**
 * Compute booked-vs-actual drift: final invoice (actual) vs LTL Select booked
 * amount, joined on PRO. Only rows with BOTH a booking and |drift| ≥ driftMin
 * are returned (sub-threshold is rounding/fuel-tier noise, not a reweigh).
 */
export async function computeFreightDrift(
    inbound: FreightInvoice[],
    driftMin = 5,
    lookbackDays = 90,
): Promise<FreightDriftRow[]> {
    const env = loadLtlSelectEnv();
    const token = await getLtlSelectToken(env);
    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - lookbackDays * 86_400_000);
    const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const { invoices: ltlInvoices } = await fetchLtlSelectInvoices(token, env, {
        dateFrom: fmt(dateFrom),
        dateTo: fmt(dateTo),
    });

    const bookedByPro = new Map<string, { amount: number; quote: number }>();
    for (const li of ltlInvoices) {
        const e = parseCollectEntry(li);
        if (!e || !e.proNumber) continue;
        bookedByPro.set(e.proNumber, { amount: e.amount, quote: e.quoteAmount });
    }

    const rows: FreightDriftRow[] = [];
    for (const inv of inbound) {
        const booked = bookedByPro.get(inv.freightBillNumber);
        if (!booked) continue;
        const drift = inv.amountDue - booked.amount;
        if (Math.abs(drift) < driftMin) continue;
        rows.push({
            vendor: inv.vendor,
            pro: inv.freightBillNumber,
            poNumber: inv.poNumber,
            booked: booked.amount,
            quote: booked.quote,
            actual: inv.amountDue,
            drift,
        });
    }
    rows.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
    return rows;
}
