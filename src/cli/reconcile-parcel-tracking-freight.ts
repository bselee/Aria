/**
 * @file    src/cli/reconcile-parcel-tracking-freight.ts
 * @purpose Put FedEx PARCEL carriage on the PO it belongs to, joined by tracking ID.
 *
 *          Some vendors ship on our FedEx account while their own invoice prints
 *          "Free Shipping" (Safe Solutions, and any vendor whose label is
 *          bill-recipient). The vendor's freight is genuinely $0, so nothing on
 *          their paperwork prices the carriage; the charge lands on a FedEx
 *          Billing Online invoice, per shipment, with no PO number on it.
 *
 *          The one reliable join is the TRACKING ID. This CLI:
 *            1. reads the PO from Finale (items, freight lines, status, shipments),
 *            2. collects tracking IDs from PostgREST `purchase_orders.tracking_numbers`
 *               and the Finale shipment docs,
 *            3. finds the FedEx parcel invoice PDF in the ap@ mailbox that carries
 *               that tracking ID and reads its `Total Charge`,
 *            4. when the PO is missing tracking (parcel invoices predate the
 *               tracking ingest, or the carrier split the order), scans the parcel
 *               invoices in the PO's ship window for the vendor as SENDER,
 *            5. compares that sum with the freight already on the PO and, with
 *               `--live`, appends the difference as a bare `Freight` line
 *               (ADJ_BY_WEIGHT + allocation), re-completing a completed PO.
 *
 *          Report-only by default. Every amount printed carries its provenance:
 *          FedEx invoice number, page, tracking ID.
 *
 *          PDF text comes from `pdftotext -table`. This host ships Xpdf's
 *          pdftotext (no -bbox-layout) and its `-layout` mode bleeds the money
 *          column onto the wrong shipment block; `-table` keeps label next to
 *          amount, which is what makes the parse safe.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/reconcile-parcel-tracking-freight.ts --vendor "safe solutions" --since 2026-01-01
 *   node --env-file=.env.local --import tsx src/cli/reconcile-parcel-tracking-freight.ts --pos 125076,124304 --live
 *   --live            append missing freight (default: report only)
 *   --scan-sender     also scan parcel invoices for the vendor as sender (default on)
 *   --gap <ms>        pause between Finale calls (default 1500)
 *
 * @author  Hermia
 * @created 2026-11-04
 * @deps    gmail/auth, @googleapis/gmail, pdf (pdftotext), finale/client,
 *          finale/freight-adjustment, lib/db
 * @env     Gmail OAuth tokens (ap), FINALE_API_KEY, FINALE_API_SECRET,
 *          FINALE_ACCOUNT_PATH, PGRST_URL, PGRST_JWT_SECRET
 */
import { readFileSync, mkdirSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";

const envRaw = (() => {
    try {
        return readFileSync(".env.local", "utf8");
    } catch {
        return "";
    }
})();
for (const line of envRaw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

import { createClient } from "../lib/db";
import { FinaleClient } from "../lib/finale/client";
import { freightAdjustmentForPo } from "../lib/finale/freight-adjustment";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { gmail as GmailApi, type gmail_v1 } from "@googleapis/gmail";

type GmailAuth = Parameters<typeof GmailApi>[0]["auth"];

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argVal = (flag: string, dflt: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LIVE = args.includes("--live");
const VENDOR = argVal("--vendor", "");
const POS_ARG = argVal("--pos", "");
const SINCE = argVal("--since", "2026-01-01");
const ACCOUNT = argVal("--account", "ap");
const GAP = Number(argVal("--gap", "1500"));
const SCAN_SENDER = !args.includes("--no-scan-sender");
const MAX_POS = Number(argVal("--max-pos", "40"));
const CACHE_DIR = ".tmp/parcel-invoices";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (n: number) => `$${Number(n).toFixed(2)}`;

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export interface ParcelCharge {
    tracking: string;
    amount: number | null;
    /** Trimmed text of the shipment block, for provenance and vendor matching. */
    senderHint: string;
    delivered: string | null;
    page: number;
    source: string; // FedEx invoice number, or the attachment filename when unknown
}

const MONEY = /(-?\$?\d[\d,]*\.\d{2})/;
const COMPONENT_LABELS =
    /(Transportation Charge|Earned Discount|Discount|Fuel Surcharge|Residential Delivery|DAS [A-Za-z ]+|Demand Surcharge|Delivery Area Surcharge|Additional Handling[ A-Za-z]*|Address Correction|Declared Value[ A-Za-z]*|Signature[ A-Za-z]*|Saturday Delivery|Oversize[ A-Za-z]*|Weight & Size[ A-Za-z]*|Peak Surcharge|Coupon Discount)/i;

/**
 * Split one invoice page into per-shipment blocks, keyed on the `Tracking ID` row.
 * Every later line belongs to the block that precedes it until the next one starts.
 */
export function splitShipmentBlocks(pageText: string): string[][] {
    const blocks: string[][] = [];
    let current: string[] | null = null;
    for (const line of pageText.split(/\r?\n/)) {
        if (/^\s*Tracking ID\s+\d{8,}/i.test(line)) {
            current = [line];
            blocks.push(current);
        } else if (current) {
            current.push(line);
        }
    }
    return blocks;
}

/** Parsed amount block for one shipment: `Total Charge` plus its components. */
export interface BlockAmounts {
    total: number | null;
    billRecipientTotal: number | null;
    components: Array<{ label: string; amount: number }>;
}

/**
 * Read the money column of one shipment block.
 *
 * Xpdf's `-table` output keeps `label … amount` on one line. `Total Charge` is the
 * authority; `Bill Recipient Subtotal` is printed when the label rides the
 * recipient's account, and is accepted as a fallback when the total is absent.
 */
export function parseBlockAmounts(block: string[]): BlockAmounts {
    const out: BlockAmounts = { total: null, billRecipientTotal: null, components: [] };
    for (const line of block) {
        // The invoice prints a prose sentence ("The Earned Discount for this ship
        // date has been calculated based on a revenue threshold of USD 2,587,377.19")
        // whose number is a company-wide revenue figure, not a charge.
        if (/revenue threshold|calculated based on/i.test(line)) continue;
        const total = line.match(/Total Charge\b[^0-9-]*(-?\$?[\d,]*\.\d{2})/i);
        if (total) {
            out.total = Number(total[1].replace(/[$,]/g, ""));
            continue;
        }
        const bill = line.match(/Bill Recipient Subtotal\b[^0-9-]*(-?\$?[\d,]*\.\d{2})/i);
        if (bill) {
            out.billRecipientTotal = Number(bill[1].replace(/[$,]/g, ""));
            continue;
        }
        const label = line.match(COMPONENT_LABELS);
        if (label) {
            const tail = line.slice((label.index ?? 0) + label[0].length);
            const amt = tail.match(MONEY);
            if (amt) {
                out.components.push({
                    label: label[1].trim(),
                    amount: Number(amt[1].replace(/[$,]/g, "")),
                });
            }
        }
    }
    return out;
}

/** True when the components sum to the stated total (the parse self-check). */
export function amountsBalance(a: BlockAmounts): boolean {
    if (a.total == null) return false;
    const sum = a.components
        .filter((c) => !/^Prepaid Subtotal$/i.test(c.label))
        .reduce((s, c) => s + c.amount, 0);
    return Math.abs(sum - a.total) <= 0.02;
}

/** Tracking IDs from `purchase_orders.tracking_numbers` (`FedEx:::123` style). */
export function trackingIdsFromRows(values: Array<string | null | undefined>): string[] {
    const out = new Set<string>();
    for (const v of values) {
        for (const tok of String(v ?? "").split(/[,;\s]+/)) {
            const digits = tok.replace(/\D/g, "");
            if (digits.length >= 10) out.add(digits);
        }
    }
    return [...out];
}

/** Does this shipment block name the vendor? Sender name and address share it. */
export function blockMentionsVendor(text: string, vendorToken: string): boolean {
    const hay = text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    const needle = vendorToken.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!needle) return false;
    return hay.includes(needle) || hay.replace(/ /g, "").includes(needle.replace(/ /g, ""));
}

// ── Gmail + PDF plumbing ────────────────────────────────────────────────────

interface AttachmentRef {
    messageId: string;
    attachmentId: string;
    filename: string;
}

type GmailPart = gmail_v1.Schema$MessagePart;
type GmailInstance = ReturnType<typeof GmailApi>;

function walkParts(part: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
    if (!part) return out;
    if (part.filename && part.body?.attachmentId) out.push(part);
    for (const p of part.parts || []) walkParts(p, out);
    return out;
}

async function gmailClient(): Promise<GmailInstance> {
    const auth = (await getAuthenticatedClient(ACCOUNT)) as unknown as GmailAuth;
    return GmailApi({ version: "v1", auth });
}

let _gmail: GmailInstance | null = null;
async function gmail(): Promise<GmailInstance> {
    if (!_gmail) _gmail = await gmailClient();
    return _gmail;
}

/** Every PDF attachment on a message. */
async function pdfAttachments(messageId: string): Promise<AttachmentRef[]> {
    const g = await gmail();
    const msg = await g.users.messages.get({ userId: "me", id: messageId, format: "full" });
    return walkParts(msg.data.payload ?? undefined)
        .filter((p) => /\.pdf$/i.test(String(p.filename || "")))
        .map((p) => ({
            messageId,
            attachmentId: String(p.body?.attachmentId || ""),
            filename: String(p.filename || ""),
        }))
        .filter((p) => p.attachmentId.length > 0);
}

/** Download an attachment once, return the local path. */
async function downloadAttachment(ref: AttachmentRef): Promise<string> {
    mkdirSync(CACHE_DIR, { recursive: true });
    const safe = ref.filename.replace(/[^\w.\-]/g, "_");
    const dest = `${CACHE_DIR}/${safe}`;
    if (existsSync(dest)) return dest;
    const g = await gmail();
    const att = await g.users.messages.attachments.get({
        userId: "me",
        messageId: ref.messageId,
        id: ref.attachmentId,
    });
    const { writeFileSync } = await import("fs");
    writeFileSync(dest, Buffer.from(att.data.data || "", "base64"));
    return dest;
}

/** Full PDF text in ONE `pdftotext -table` spawn; Xpdf separates pages with a form feed. */
function fullTableText(pdf: string): string {
    try {
        return execFileSync("pdftotext", ["-table", pdf, "-"], {
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch {
        return "";
    }
}

interface ParsedInvoice {
    source: string;
    charges: ParcelCharge[];
}

/** Every shipment block in a parcel invoice PDF, with page + amount provenance. */
export function parseParcelInvoice(pdf: string, source: string): ParsedInvoice {
    const charges: ParcelCharge[] = [];
    fullTableText(pdf)
        .split("\f")
        .forEach((pageText, idx) => {
            if (!pageText.trim()) return;
            for (const block of splitShipmentBlocks(pageText)) {
                const head = block[0].match(/Tracking ID\s+(\d{8,})/i);
                if (!head) continue;
                const amounts = parseBlockAmounts(block);
                const text = block.join("\n");
                const delivered = text.match(/Delivered\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
                charges.push({
                    tracking: head[1],
                    amount: amounts.total ?? amounts.billRecipientTotal,
                    senderHint: block
                        .slice(1, 8)
                        .map((l) => l.replace(/\s+/g, " ").trim())
                        .filter((l) => l.length > 0)
                        .slice(0, 3)
                        .join(" | ")
                        .slice(0, 180),
                    delivered: delivered ? delivered[1] : null,
                    page: idx + 1,
                    source,
                });
            }
        });
    return { source, charges };
}

/** FedEx Billing Online invoice number, from the attachment name or the PDF header. */
function invoiceNumberFromFilename(name: string): string {
    const m = name.match(/\.(\d{9,12})\.XXXXX/);
    return m ? m[1] : name;
}

// ── Mailbox lookups ─────────────────────────────────────────────────────────

interface MailHit {
    messageId: string;
    internalDate: string;
}

async function searchMessages(query: string, limit = 40): Promise<MailHit[]> {
    const g = await gmail();
    const res = await g.users.messages.list({ userId: "me", q: query, maxResults: limit });
    return (res.data.messages || []).map((m) => ({ messageId: String(m.id || ""), internalDate: "" }));
}

const _parsedByPdf = new Map<string, ParsedInvoice>();

async function parseCached(pdf: string): Promise<ParsedInvoice> {
    if (_parsedByPdf.has(pdf)) return _parsedByPdf.get(pdf)!;
    const parsed = parseParcelInvoice(pdf, invoiceNumberFromFilename(pdf.split("/").pop() || pdf));
    _parsedByPdf.set(pdf, parsed);
    return parsed;
}

/** Charges for one tracking ID, found by searching the mailbox for the number. */
async function chargesForTracking(tracking: string): Promise<ParcelCharge[]> {
    const hits = await searchMessages(`"${tracking}"`, 10);
    const out: ParcelCharge[] = [];
    for (const hit of hits) {
        for (const ref of await pdfAttachments(hit.messageId)) {
            const pdf = await downloadAttachment(ref);
            const parsed = await parseCached(pdf);
            for (const c of parsed.charges) {
                if (c.tracking === tracking) out.push({ ...c, source: parsed.source });
            }
        }
    }
    return out;
}

/** Parcel charges where the vendor appears as SENDER, inside a date window. */
async function chargesForVendorWindow(
    vendorToken: string,
    after: string,
    before: string,
): Promise<ParcelCharge[]> {
    const hits = await searchMessages(
        `from:noreply@fedex.com after:${after} before:${before}`,
        60,
    );
    const out: ParcelCharge[] = [];
    for (const hit of hits) {
        for (const ref of await pdfAttachments(hit.messageId)) {
            const pdf = await downloadAttachment(ref);
            const parsed = await parseCached(pdf);
            for (const block of parsed.charges) {
                if (!blockMentionsVendor(block.senderHint, vendorToken)) continue;
                out.push(block);
            }
        }
    }
    return out;
}

// ── Vendor invoice → tracking ID ────────────────────────────────────────────
//
// The shipment's tracking number is printed on the VENDOR's own invoice
// ("Tracking no.: 887976290599", with a "Shipping / BAS FedEx Account" line at
// $0). That makes the vendor invoice the most reliable tracking source: Finale
// shipment docs are usually blank and Aria's tracking ingest only knows what it
// has seen. This is the join that survives a label nobody captured.

/** Tracking IDs printed on a vendor invoice's text. */
export function trackingIdsFromInvoiceText(text: string): string[] {
    const out = new Set<string>();
    const re = /Tracking\s*(?:no\.?|number|#)?\s*[:.]?\s*([0-9][0-9\s-]{9,30})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const digits = m[1].replace(/\D/g, "");
        if (digits.length >= 10 && digits.length <= 22) out.add(digits);
    }
    return [...out];
}

/** True when the vendor's invoice shows the label riding OUR carrier account. */
export function invoiceOnOurFedexAccount(text: string): boolean {
    return /BAS\s+FedEx\s+Account/i.test(text) || /\bShip\s*via\s*:?\s*FedEx\b/i.test(text);
}

/**
 * Tracking IDs off every vendor invoice filed against this PO — local archived
 * PDF when there is one, otherwise the Gmail attachment behind `source_ref`.
 */
async function trackingFromVendorInvoices(po: string): Promise<string[]> {
    const sb = createClient();
    if (!sb) return [];
    const { data } = (await sb
        .from("vendor_invoices")
        .select("invoice_number, source_ref, pdf_storage_path")
        .eq("po_number", po)
        .limit(6)) as {
        data: Array<{ invoice_number: string | null; source_ref: string | null; pdf_storage_path: string | null }> | null;
    };

    const out = new Set<string>();
    for (const row of data || []) {
        try {
            let pdf: string | null = null;
            mkdirSync(CACHE_DIR, { recursive: true });
            const local = `${CACHE_DIR}/vendor-${po}-${row.invoice_number || row.source_ref || "inv"}.pdf`;
            const archived = row.pdf_storage_path && existsSync(row.pdf_storage_path) ? row.pdf_storage_path : null;
            if (archived) {
                // Some archived paths carry a directory ending in a dot
                // ("Safe_Solutions_Inc.") — Windows/Xpdf cannot open those, so
                // copy to a clean name before parsing.
                if (!existsSync(local)) {
                    const { copyFileSync } = await import("fs");
                    copyFileSync(archived, local);
                }
                pdf = local;
            } else if (row.source_ref && /^[0-9a-f]{12,}$/i.test(row.source_ref)) {
                if (!existsSync(local)) {
                    const refs = (await pdfAttachments(row.source_ref)).filter((r) => /invoice|INVOICE/i.test(r.filename));
                    const ref = refs[0];
                    if (!ref) continue;
                    const g = await gmail();
                    const att = await g.users.messages.attachments.get({
                        userId: "me",
                        messageId: ref.messageId,
                        id: ref.attachmentId,
                    });
                    const { writeFileSync } = await import("fs");
                    writeFileSync(local, Buffer.from(att.data.data || "", "base64"));
                }
                pdf = local;
            }
            if (!pdf) continue;
            const text = execFileSync("pdftotext", ["-table", pdf, "-"], {
                encoding: "utf8",
                maxBuffer: 16 * 1024 * 1024,
                stdio: ["ignore", "pipe", "ignore"],
            });
            for (const t of trackingIdsFromInvoiceText(text)) out.add(t);
        } catch {
            /* an unreadable invoice must not abort the audit */
        }
    }
    return [...out];
}

// ── PO enumeration ──────────────────────────────────────────────────────────

interface PoRow {
    po_number: string;
    vendor_name: string;
    status: string;
    issue_date: string | null;
    receive_date: string | null;
    total: number | null;
    tracking_numbers: string[] | null;
}

async function loadPos(): Promise<PoRow[]> {
    const sb = createClient();
    if (!sb) throw new Error("PostgREST client not configured");
    let q = sb
        .from("purchase_orders")
        .select("po_number, vendor_name, status, issue_date, receive_date, total, tracking_numbers")
        .gte("issue_date", SINCE)
        .order("issue_date", { ascending: true })
        .limit(MAX_POS);
    if (POS_ARG) {
        q = q.in("po_number", POS_ARG.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (VENDOR) {
        q = q.ilike("vendor_name", `%${VENDOR}%`);
    } else {
        throw new Error("pass --vendor <name> or --pos <csv>");
    }
    const { data, error } = (await q) as { data: PoRow[] | null; error: { message: string } | null };
    if (error) throw new Error(error.message);
    const rows = (data || []).filter((r) => String(r.status || "").toLowerCase() !== "closed");

    // A PO named explicitly must be audited even when Aria's PO cache has no row
    // for it (older POs predate the cache) — Finale is the authority on existence.
    if (POS_ARG) {
        const have = new Set(rows.map((r) => String(r.po_number)));
        for (const po of POS_ARG.split(",").map((s) => s.trim()).filter(Boolean)) {
            if (have.has(po)) continue;
            rows.push({
                po_number: po,
                vendor_name: "",
                status: "",
                issue_date: null,
                receive_date: null,
                total: null,
                tracking_numbers: [],
            });
        }
    }
    return rows;
}

/** Vendor name filed on this PO's invoices — the fallback when the PO cache is silent. */
async function vendorNameForPo(po: string): Promise<string> {
    const sb = createClient();
    if (!sb) return "";
    const { data } = (await sb
        .from("vendor_invoices")
        .select("vendor_name")
        .eq("po_number", po)
        .limit(1)) as { data: Array<{ vendor_name: string | null }> | null };
    return (data && data[0] && data[0].vendor_name) || "";
}

// ── Apply ──────────────────────────────────────────────────────────────────

/** The slice of a Finale order doc this CLI reads. */
interface FinaleItem {
    productId?: string;
    quantity?: number;
    unitPrice?: number;
    weight?: number;
}

interface FinaleAdjustment {
    amount?: number | string | null;
    productPromoUrl?: string | null;
    description?: string | null;
}

interface FinaleDoc {
    statusId?: string;
    orderItemList?: FinaleItem[];
    orderAdjustmentList?: FinaleAdjustment[];
    shipmentUrlList?: string[];
}

/** Operations used against the Finale client (all provided by FinaleClient). */
interface ParcelFinaleOps {
    getOrderDetails(po: string): Promise<FinaleDoc>;
    getShipmentDetails(url: string): Promise<{ trackingCode?: string; shipDate?: string; receiveDate?: string }>;
    unlockForEditing(doc: FinaleDoc, po: string): Promise<string>;
    freightAllocLines(items: FinaleItem[]): Promise<Array<{ quantity: number; weight?: number }>>;
    post(path: string, body: unknown): Promise<unknown>;
    restoreOrderStatus(po: string, status: string): Promise<void>;
    completeOrder(po: string): Promise<unknown>;
}

function freightLines(doc: FinaleDoc): FinaleAdjustment[] {
    return (doc.orderAdjustmentList || []).filter((a) => String(a.productPromoUrl || "").includes("/10007"));
}

async function applyFreight(client: ParcelFinaleOps, po: string, amount: number): Promise<string> {
    const doc = await client.getOrderDetails(po);
    const originalStatus = await client.unlockForEditing(doc, po);
    const allocLines = await client.freightAllocLines(doc.orderItemList || []);
    doc.orderAdjustmentList = [...(doc.orderAdjustmentList || []), freightAdjustmentForPo(amount, allocLines)];
    await sleep(GAP);
    await client.post(
        `/${process.env.FINALE_ACCOUNT_PATH || "buildasoilorganics"}/api/order/${encodeURIComponent(po)}`,
        doc,
    );
    await sleep(GAP);
    await client.restoreOrderStatus(po, originalStatus);
    if (originalStatus === "ORDER_COMPLETED") {
        await sleep(GAP);
        await client.completeOrder(po);
    }
    await sleep(GAP);
    const after = await client.getOrderDetails(po);
    const on = freightLines(after).reduce((s, a) => s + Number(a.amount || 0), 0);
    return `${after.statusId} freight=${money(on)}`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const rows = await loadPos();
    if (!rows.length) {
        console.log("no POs matched");
        return;
    }
    console.log(`${rows.length} PO(s) | mode=${LIVE ? "LIVE" : "report only"} | account=${ACCOUNT}\n`);

    const client = new FinaleClient() as unknown as ParcelFinaleOps;

    for (const row of rows) {
        const po = String(row.po_number);
        let doc: FinaleDoc;
        try {
            doc = await client.getOrderDetails(po);
        } catch (e: unknown) {
            console.log(`${po}  ERROR ${e instanceof Error ? e.message : String(e)}`);
            await sleep(GAP);
            continue;
        }
        const onPo = freightLines(doc).reduce((s, a) => s + Number(a.amount || 0), 0);
        const items = (doc.orderItemList || []).filter((i) => Boolean(i.productId));
        const goods = items.reduce((s, i) => s + Number(i.unitPrice || 0) * Number(i.quantity || 0), 0);

        // Vendor name: the PO cache, the override flag, or the filed invoice.
        const invoiceVendor = await vendorNameForPo(po);
        const vendorToken = (VENDOR || row.vendor_name || invoiceVendor || "").trim();

        // 1. tracking IDs we already know — PO cache, Finale shipments, filed invoices
        let trackings = trackingIdsFromRows(row.tracking_numbers || []);
        const shipDates: string[] = [];
        for (const s of doc.shipmentUrlList || []) {
            try {
                const sh = await client.getShipmentDetails(s);
                trackings.push(...trackingIdsFromRows([sh.trackingCode]));
                if (sh.receiveDate) shipDates.push(String(sh.receiveDate).slice(0, 10));
                else if (sh.shipDate) shipDates.push(String(sh.shipDate).slice(0, 10));
                await sleep(GAP);
            } catch {
                /* shipment 404s on dropships — ignore */
            }
        }
        trackings = [...new Set([...trackings, ...(await trackingFromVendorInvoices(po))])];
        const shipments = (doc.shipmentUrlList || []).length;

        // 2. charges per tracking
        const found: ParcelCharge[] = [];
        for (const t of trackings) {
            const hits = await chargesForTracking(t);
            found.push(...hits);
        }

        // 3. fallback: scan the ship window for the vendor as sender
        let scanned: ParcelCharge[] = [];
        if (SCAN_SENDER && found.length < Math.max(shipments, 1)) {
            const issue = row.issue_date ? row.issue_date.slice(0, 10) : SINCE;
            const recv = row.receive_date
                ? row.receive_date.slice(0, 10)
                : shipDates.length
                    ? shipDates.sort()[shipDates.length - 1]
                    : new Date().toISOString().slice(0, 10);
            const before = new Date(new Date(recv).getTime() + 45 * 86400_000).toISOString().slice(0, 10);
            scanned = (await chargesForVendorWindow(vendorToken, issue, before)).filter(
                (c) => !trackings.includes(c.tracking),
            );
        }

        const all = [...found, ...scanned];
        // One charge per tracking ID (the same bill can appear on two accounts/notices).
        const byTracking = new Map<string, ParcelCharge>();
        for (const c of all) {
            const prev = byTracking.get(c.tracking);
            if (!prev || (prev.amount == null && c.amount != null)) byTracking.set(c.tracking, c);
        }
        const charges = [...byTracking.values()];
        const expected = charges.reduce((s, c) => s + Number(c.amount || 0), 0);

        console.log(
            `${po}  ${doc.statusId}  items=${items.length}  goods=${money(goods)}  ` +
            `freightOnPo=${money(onPo)}  shipments=${shipments}  trackings=${trackings.length}  ` +
            `parcelCharges=${charges.length}  parcel=${money(expected)}`,
        );
        for (const c of charges) {
            const routed = trackings.includes(c.tracking) ? "tracking" : "sender-scan";
            console.log(
                `    ${routed}  ${c.tracking}  ${money(Number(c.amount || 0))}  ` +
                `inv ${c.source} p${c.page}  delivered ${c.delivered ?? "?"}  ${c.senderHint.slice(0, 90)}`,
            );
        }

        const gap = Math.round((expected - onPo) * 100) / 100;
        if (!charges.length) {
            console.log("    -> NO PARCEL CHARGE FOUND in the mailbox window (needs FBO lookup)\n");
            await sleep(GAP);
            continue;
        }
        if (Math.abs(gap) <= 0.02) {
            console.log("    -> aligned\n");
            await sleep(GAP);
            continue;
        }
        if (!LIVE) {
            console.log(`    -> would append Freight ${money(gap)} (delta)\n`);
            await sleep(GAP);
            continue;
        }
        const result = await applyFreight(client, po, gap);
        console.log(`    -> appended ${money(gap)} | now ${result}\n`);
        const sb = createClient();
        if (sb) {
            await sb.from("ap_activity_log").insert({
                intent: "PARCEL_FREIGHT_ALIGNED",
                created_at: new Date().toISOString(),
                metadata: {
                    poNumber: po,
                    lane: "parcel",
                    delta: gap,
                    parcelTotal: expected,
                    trackings: charges.map((c) => ({ tracking: c.tracking, amount: c.amount, invoice: c.source })),
                },
            });
        }
        await sleep(GAP);
    }
}

const isEntrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
