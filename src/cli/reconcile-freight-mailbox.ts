/**
 * @file    reconcile-freight-mailbox.ts
 * @purpose Reconcile FedEx Freight Billing Online notices (freight@ Gmail) against
 *          Finale POs. The mailbox receives "New Invoices Available" notices from
 *          fedex@billtrust.com, one PDF per batch, each PDF holding per-shipment
 *          invoices on account 646135168.
 *
 *          The notice BODY lists account / invoice number / amount; the PDF carries
 *          the full join: Freight Bill Number, P.O. Number, Shipper, Terms, BOL,
 *          ship date, invoice date, and Total Amount Due.
 *
 *          Amount of record = the PDF's Total Amount Due, i.e. the FINAL post-reweigh
 *          invoice (LTL Select quotes pre-reweigh and understate). Matching reuses the
 *          canonical LTL Select scorer (pickPoForEntry + scoreFreightApplyConfidence)
 *          so confidence is identical to the weekly reconcile, but the dollars are the
 *          true final freight.
 *
 *          REPORT-ONLY by default. `--live` applies ONLY high-confidence NEW freight
 *          (no freight already on the PO). A bill whose PO already carries a DIFFERENT
 *          amount is a CORRECTION and is reported; positive deltas auto-apply
 *          under --correct, negative deltas (savings) auto-apply only when
 *          unambiguous (hard PO ref, single carrier line, single-delivery).
 *
 * @usage
 *   node --import tsx --env-file=.env.local src/cli/reconcile-freight-mailbox.ts
 *   node --import tsx --env-file=.env.local src/cli/reconcile-freight-mailbox.ts --vendor all
 *   node --import tsx --env-file=.env.local src/cli/reconcile-freight-mailbox.ts --vendor uline
 *   node --import tsx --env-file=.env.local src/cli/reconcile-freight-mailbox.ts --live
 *   node --import tsx --env-file=.env.local src/cli/reconcile-freight-mailbox.ts --gap 800
 *
 * @author  Hermia
 * @created 2026-10-19
 * @deps    dotenv, @googleapis/gmail, finale/client, finale/freight-adjustment,
 *          ltlselect/match, pdftotext (poppler on PATH)
 * @env     FINALE_API_KEY, FINALE_API_SECRET, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { FinaleClient } from "../lib/finale/client";
import { freightAdjustmentForPo, resolveUnitWeightLb, splitFreightAcrossPos } from "../lib/finale/freight-adjustment";
import { getShipmentReceiptItems, getShipmentReceiptDateTime } from "../lib/finale/core-client";
import {
    VENDOR_ORIGIN_MAP,
    pickPoForEntry,
    pickPosForEntry,
    findBestReception,
    receiveWindowDaysForVendor,
    isMultiDeliveryVendor,
    isExcludedVendor,
    scoreFreightApplyConfidence,
    type CollectEntry,
} from "../lib/ltlselect/match";
import { computeFreightDrift } from "../lib/freight/freight-drift";
import { createClient } from "../lib/db";
import {
    findLatestBilltrustCsv,
    parseBilltrustCsv,
    dedupInboundInvoices,
    type BilltrustInvoice,
} from "./reconcile-billtrust-freight";
import type { FullPO } from "../lib/finale/client";
import { pathToFileURL } from "url";

// ── Config ───────────────────────────────────────────────────────────────────

const FINALE_ACCOUNT = "buildasoilorganics";
const NOTICE_SENDER = "from:fedex@billtrust.com";
const TMP_PDF_DIR = path.join(process.cwd(), ".tmp", "fedex-mailbox-pdfs");

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const CORRECT = args.includes("--correct");
const DRIFT = args.includes("--drift");
const vendorIdx = args.indexOf("--vendor");
const VENDOR_FILTER = (vendorIdx >= 0 ? args[vendorIdx + 1] : "all") || "all";
const gapIdx = args.indexOf("--gap");
const GAP_MS = gapIdx >= 0 ? Number(args[gapIdx + 1]) || 400 : 400;
const csvIdx = args.indexOf("--csv");
const CSV_PATH_OVERRIDE = csvIdx >= 0 ? args[csvIdx + 1] : null;

/** Narrow write surface over FinaleClient (same as LTL Select / Billtrust). */
interface PoDoc {
    statusId?: string;
    orderAdjustmentList?: Array<{
        amount?: number;
        description?: string;
        productPromoUrl?: string;
        orderAdjustmentAllocationList?: number[];
    }>;
    orderItemList?: Array<{ quantity?: number; weight?: number }>;
    shipmentUrlList?: string[];
    [key: string]: unknown;
}

interface FinaleWriteSurface {
    getOrderDetails(orderId: string): Promise<PoDoc>;
    unlockForEditing(currentPO: PoDoc, orderId: string): Promise<string>;
    restoreOrderStatus(orderId: string, originalStatus: string): Promise<void>;
    completeOrder(orderId: string): Promise<unknown>;
    post(endpoint: string, body: unknown): Promise<unknown>;
    freightAllocLines(
        orderItemList: Array<{ productId?: string; quantity?: number; weight?: number }> | undefined,
    ): Promise<Array<{ quantity: number; weight?: number }>>;
    getShipmentDetails(shipmentUrl: string): Promise<unknown>;
}

/** One per-shipment FedEx Freight invoice parsed from a notice PDF. */
interface FreightInvoice {
    freightBillNumber: string;
    shipDate: string; // MM/DD/YYYY
    invoiceDate: string; // MM/DD/YYYY
    terms: string; // COLLECT | PREPAID
    poNumber: string;
    bol: string;
    amountDue: number;
    shipper: string;
    /** Vendor resolved from the full block (shipper name + address). */
    vendor: string | null;
}

interface MailboxResult {
    invoice: FreightInvoice;
    vendor: string | null;
    finalePoId: string | null;
    matchSource: "po_ref" | "vendor_window" | "excluded" | "unmatched";
    confidence: "high" | "medium" | "low";
    wouldApply: boolean;
    /** Existing carrier freight already on the matched PO (> $2.50), if any. */
    freightOnPo: number | null;
    /** true when the PO already carries this exact amount. */
    freightAlreadyOnPO: boolean;
    /** invoice.amountDue − freightOnPo when a DIFFERENT amount is already on the PO. */
    correctionDelta: number | null;
    /** Count of /10007 lines above the house-charge threshold on the PO. */
    carrierLineCount: number | null;
    /** Multi-PO split (one truck → several POs), when applicable. */
    split?: Array<{ orderId: string; pounds: number; amount: number }>;
    lagDays: number | null;
    receiveDiffDays: number | null;
    reasons: string[];
    error?: string;
}

// ── Vendor resolution (canonical alias list, matched against the full block) ──

function resolveVendorFromBlock(block: string): string | null {
    for (const { alias, vendor } of VENDOR_ORIGIN_MAP) {
        if (alias.test(block)) return vendor;
    }
    return null;
}

// ── PDF text parsing ─────────────────────────────────────────────────────────

/**
 * Extract every per-shipment invoice from a FedEx Freight batch PDF's text.
 * Uses pdftotext -layout (poppler), which preserves the two-column header that
 * pdf-parse jams together.
 */
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

// ── CollectEntry adapter (feeds the canonical LTL Select scorer) ─────────────

function toCollectEntry(inv: FreightInvoice): CollectEntry {
    return {
        invoiceId: inv.freightBillNumber,
        proNumber: inv.freightBillNumber,
        bolNumber: inv.bol,
        orderNumber: null,
        referenceNumber: null,
        pickupNumber: null,
        internalTrackingNumber: null,
        originName: inv.shipper,
        originCity: "",
        originState: "",
        originPostalCode: "",
        pickupDate: parseUsDate(inv.shipDate),
        carrier: "FXFE",
        paymentType: "COLLECT",
        direction: "CONSIGNEE",
        quoteAmount: inv.amountDue, // final invoice; no separate quote to compare
        amount: inv.amountDue,
        statusCode: "",
        raw: {} as CollectEntry["raw"],
    };
}

/** Convert a Billtrust CSV inbound invoice into the shared FreightInvoice shape. */
function billtrustToFreightInvoice(bi: BilltrustInvoice): FreightInvoice {
    const poMatch = bi.poNumber.match(/\b(\d{6})\b/);
    return {
        freightBillNumber: bi.invoiceNumber,
        shipDate: bi.shipDate,   // MM/DD/YYYY in the CSV, same as the PDF
        invoiceDate: bi.invoiceDate,
        terms: bi.terms,
        poNumber: poMatch ? poMatch[1] : "",
        bol: bi.bol,
        amountDue: bi.amountDue,
        shipper: bi.shipFromAddress,
        vendor: bi.vendorName,
    };
}

// ── Freight apply (GET → unlock → append/replace → POST → restore) ───────────

/** Persist a RECONCILIATION anchor so the auto-align watcher's 24h dwell is
 *  real for mailbox-applied freight (2026-10-28). Best-effort — never blocks
 *  the apply. */
async function logReconciliationAnchor(poId: string, amount: number, invoiceNumber: string, kind: string): Promise<void> {
    try {
        const db = createClient();
        if (!db) return;
        await db.from("ap_activity_log").insert({
            intent: "RECONCILIATION",
            email_from: "",
            email_subject: "",
            action_taken: "reconciled",
            created_at: new Date().toISOString(),
            metadata: {
                orderId: String(poId),
                poNumber: null,
                kind,
                amount,
                invoiceNumber,
                source: "fedex-mailbox-reconcile",
            },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fedex-mailbox] anchor log failed: ${msg}`);
    }
}

async function applyFreightToPo(
    finale: FinaleWriteSurface,
    poId: string,
    amount: number,
    isMultiDelivery: boolean,
    forceFreshAlloc = false,
): Promise<void> {
    const po = await finale.getOrderDetails(poId);
    const originalStatus = await finale.unlockForEditing(po, poId);

    const adjustments = [...(po.orderAdjustmentList ?? [])];
    const items = await finale.freightAllocLines(po.orderItemList);
    const existingFreight = adjustments.filter((a) => (a.productPromoUrl ?? "").includes("/10007"));
    const existingAlloc = !forceFreshAlloc && !isMultiDelivery && existingFreight.length === 1
        ? existingFreight[0].orderAdjustmentAllocationList
        : undefined;
    const replacement = freightAdjustmentForPo(amount, items, existingAlloc);

    if (!isMultiDelivery) {
        // Single-delivery: strip every real /10007 line, preserve the Uline $1.50
        // house charge (<= $2.50), push the final carrier amount.
        const nonFreight = adjustments.filter((a) => !(a.productPromoUrl ?? "").includes("/10007"));
        const houseCharge = adjustments.filter(
            (a) => (a.productPromoUrl ?? "").includes("/10007") && Number(a.amount) <= 2.5,
        );
        adjustments.length = 0;
        adjustments.push(...nonFreight, ...houseCharge, replacement);
    } else {
        adjustments.push(replacement);
    }

    await finale.post(
        `/${FINALE_ACCOUNT}/api/order/${encodeURIComponent(poId)}`,
        { ...po, orderAdjustmentList: adjustments },
    );
    await finale.restoreOrderStatus(poId, originalStatus);
    // restoreOrderStatus maps ORDER_COMPLETED → ORDER_LOCKED; put it back.
    if (originalStatus === "ORDER_COMPLETED") {
        await finale.completeOrder(poId);
    }
}

function isDropshipOrderId(orderId: string | null | undefined): boolean {
    return !!orderId && /dropship/i.test(orderId);
}

// ── Multi-PO split (one truck, several POs) ──────────────────────────────────

/**
 * Resolve the allocation weight for each PO on a multi-PO truck.
 *
 * A multi-delivery vendor (Rootwise) ships several POs on one FedEx Freight
 * bill. The bill carries no per-PO weight, so the split must come from the
 * per-shipment items: for each PO, walk its shipments, find the one received in
 * the bill's pickup window, and sum (received qty × unit weight). Unit weight is
 * name-derived via resolveUnitWeightLb (the raw weight/weightUomId field is
 * inconsistent — 16× errors on "8oz" SKUs).
 *
 * Returns a map orderId → pounds. POs whose shipments have no items, or whose
 * SKUs have no weight, contribute 0 (and thus $0 from the split).
 */
async function resolveTruckPoWeights(
    finale: FinaleWriteSurface,
    poIds: string[],
    pickupDate: string,
    windowDays: number,
): Promise<Map<string, number>> {
    const weights = new Map<string, number>();
    const pickupMs = new Date(`${String(pickupDate).slice(0, 10)}T12:00:00`).getTime();

    for (const poId of poIds) {
        const po = await finale.getOrderDetails(poId);
        const urls = (po.shipmentUrlList as string[] | undefined) || [];
        let pounds = 0;
        for (const url of urls) {
            const shipment = (await finale.getShipmentDetails(url)) as any;
            const received = getShipmentReceiptDateTime(shipment);
            if (!received) continue;
            const recvMs = new Date(`${String(received).slice(0, 10)}T12:00:00`).getTime();
            if (Number.isNaN(recvMs)) continue;
            const diff = Math.abs((recvMs - pickupMs) / 86400000);
            if (diff > windowDays) continue;
            const items = getShipmentReceiptItems(shipment);
            for (const item of items) {
                const unit = await resolveFinaleUnitWeight(finale, item.productId);
                pounds += unit * item.quantity;
            }
        }
        weights.set(poId, pounds);
    }
    return weights;
}

/** Name-derived unit weight (lb) for a Finale SKU, cached per run. */
const _unitWeightCache = new Map<string, number>();
async function resolveFinaleUnitWeight(finale: FinaleWriteSurface, sku: string): Promise<number> {
    if (_unitWeightCache.has(sku)) return _unitWeightCache.get(sku)!;
    let lb = 0;
    try {
        const product = (await (finale as unknown as { get(endpoint: string): Promise<unknown> }).get(
            `/buildasoilorganics/api/product/${encodeURIComponent(sku)}`,
        )) as any;
        lb = resolveUnitWeightLb({
            name: product?.internalName || product?.name,
            weight: product?.weight,
            weightUomId: product?.weightUomId,
        });
    } catch {
        lb = 0;
    }
    _unitWeightCache.set(sku, lb);
    return lb;
}

// ── Small date helpers ───────────────────────────────────────────────────────

function daysBetween(fromIso: string, toIso: string): number | null {
    const a = new Date(fromIso).getTime();
    const b = new Date(toIso).getTime();
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
}

function parseUsDate(s: string): string {
    const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return "";
    return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("\n╔════════════════════════════════════════════════════╗");
    console.log("║  FedEx Freight Mailbox → Finale PO Reconcile       ║");
    console.log("╚════════════════════════════════════════════════════╝\n");
    console.log(`Mode: ${LIVE ? "LIVE" : "REPORT ONLY"}${CORRECT ? " +CORRECT" : ""}   Vendor: ${VENDOR_FILTER}   Gap: ${GAP_MS}ms\n`);

    // 1. List notices + fetch each PDF.
    const auth = await getAuthenticatedClient("freight");
    const gmail = GmailApi({ version: "v1", auth });
    const list = await gmail.users.messages.list({ userId: "me", q: NOTICE_SENDER, maxResults: 100 });
    const ids = (list.data.messages || []).map((m) => m.id!).filter(Boolean);
    console.log(`Notices: ${ids.length}`);

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
            } catch (err) {
                console.log(`  PDF parse failed ${p.filename}: ${(err as Error).message}`);
                continue;
            }
            invoices.push(...parseFreightInvoicesFromText(text));
        }
    }

    // 1b. Fold in the Billtrust CSV (full history beyond the ~5-week mailbox).
    const csvPath = CSV_PATH_OVERRIDE || findLatestBilltrustCsv();
    if (csvPath && fs.existsSync(csvPath)) {
        try {
            const csvInvoices = dedupInboundInvoices(parseBilltrustCsv(csvPath)).map(billtrustToFreightInvoice);
            invoices.push(...csvInvoices);
            console.log(`Billtrust CSV: ${csvInvoices.length} inbound invoices (${path.basename(csvPath)})`);
        } catch (err) {
            console.log(`  CSV parse failed ${csvPath}: ${(err as Error).message}`);
        }
    }

    // Dedupe by freight bill number (remittance advice repeats each invoice;
    // the CSV and the mailbox may also overlap on the same PRO).
    const seen = new Map<string, FreightInvoice>();
    for (const inv of invoices) {
        if (!seen.has(inv.freightBillNumber)) seen.set(inv.freightBillNumber, inv);
    }
    const all = [...seen.values()].sort((a, b) =>
        (parseUsDate(b.invoiceDate) || "").localeCompare(parseUsDate(a.invoiceDate) || ""),
    );

    // 2. Inbound COLLECT only.
    const inbound = all.filter((i) => i.terms === "COLLECT");
    console.log(`Inbound COLLECT: ${inbound.length} (${all.length} total incl. PREPAID outbound)`);

    // 3. Vendor filter.
    const inScope = VENDOR_FILTER.toLowerCase() === "all"
        ? inbound
        : inbound.filter((i) => (i.vendor || "").toLowerCase() === VENDOR_FILTER.toLowerCase()
            || i.shipper.toLowerCase().includes(VENDOR_FILTER.toLowerCase()));

    if (inScope.length === 0) {
        console.log(`\nNo ${VENDOR_FILTER} COLLECT invoices in the mailbox window.\n`);
        return;
    }

    // 4. Finale POs.
    const finaleClient = new FinaleClient();
    const finale = finaleClient as unknown as FinaleWriteSurface;
    const recentPOs: FullPO[] = await finaleClient.getRecentPurchaseOrders(365);

    // 5. Match + score each bill.
    const results: MailboxResult[] = [];
    for (const inv of inScope) {
        const entry = toCollectEntry(inv);
        const r: MailboxResult = {
            invoice: inv,
            vendor: inv.vendor,
            finalePoId: null,
            matchSource: "unmatched",
            confidence: "low",
            wouldApply: false,
            freightOnPo: null,
            freightAlreadyOnPO: false,
            correctionDelta: null,
            carrierLineCount: null,
            lagDays: daysBetween(parseUsDate(inv.shipDate), parseUsDate(inv.invoiceDate)),
            receiveDiffDays: null,
            reasons: [],
        };

        // Guard 0: excluded vendor.
        if (inv.vendor && isExcludedVendor(inv.vendor)) {
            r.matchSource = "excluded";
            r.reasons.push(`excluded vendor ${inv.vendor}`);
            results.push(r);
            continue;
        }

        // Guard 1: hard 6-digit PO# on the bill (must agree with the PO vendor).
        if (inv.poNumber && !isDropshipOrderId(inv.poNumber)) {
            const found = recentPOs.find((p) => p.orderId === inv.poNumber && !isDropshipOrderId(p.orderId));
            if (found) {
                // Vendor-agreement guard: a transposed PO# on the bill must not
                // attach freight to a different vendor's PO.
                const poVendor = (found.vendorName || "").toLowerCase();
                const billVendor = (inv.vendor || "").toLowerCase();
                const vendorAgrees = !billVendor
                    || !poVendor
                    || poVendor.includes(billVendor.split(" ")[0])
                    || billVendor.includes(poVendor.split(" ")[0]);
                r.finalePoId = found.orderId;
                r.matchSource = "po_ref";
                if (!vendorAgrees) {
                    r.reasons.push(`PO ${inv.poNumber} vendor "${found.vendorName}" != bill shipper "${inv.vendor}"`);
                }
            } else {
                r.reasons.push(`PO ${inv.poNumber} not found in 365d window`);
            }
        } else if (inv.vendor) {
            // Guard 2: vendor + receive-window match.
            if (isMultiDeliveryVendor(inv.vendor)) {
                // Multi-PO-per-truck: one bill can cover several POs. Split by
                // allocation weight when more than one PO received in the window.
                const candidates = pickPosForEntry(entry, recentPOs, inv.vendor);
                if (candidates.length > 1) {
                    const win = receiveWindowDaysForVendor(inv.vendor);
                    const weights = await resolveTruckPoWeights(
                        finale,
                        candidates.map((p) => p.orderId),
                        entry.pickupDate,
                        win.mode === "business" ? win.maxDays + 2 : win.maxDays,
                    );
                    const totalLb = [...weights.values()].reduce((s, w) => s + w, 0);
                    if (totalLb > 0) {
                        const split = splitFreightAcrossPos(
                            inv.amountDue,
                            [...weights.entries()].map(([orderId, pounds]) => ({ orderId, pounds })),
                        );
                        r.split = split;
                        r.matchSource = "vendor_window";
                        r.finalePoId = split.length ? split[0].orderId : null;
                        r.reasons.push(
                            `multi-PO truck: ${split.length} POs, split by weight (${split.map((s) => `${s.orderId} $${s.amount.toFixed(2)}`).join(", ")})`,
                        );
                    } else {
                        r.reasons.push(`multi-PO truck matched ${candidates.length} POs but no weight resolvable`);
                    }
                } else {
                    const pick = candidates[0] || pickPoForEntry(entry, recentPOs, inv.vendor);
                    if (pick) {
                        r.finalePoId = pick.orderId;
                        r.matchSource = "vendor_window";
                    } else {
                        r.reasons.push(`no ${inv.vendor} PO in order window`);
                    }
                }
            } else {
                const pick = pickPoForEntry(entry, recentPOs, inv.vendor);
                if (pick) {
                    r.finalePoId = pick.orderId;
                    r.matchSource = "vendor_window";
                } else {
                    r.reasons.push(`no ${inv.vendor} PO in order window`);
                }
            }
        } else {
            r.reasons.push("unknown shipper");
        }

        // Score with the canonical LTL Select confidence function.
        const win = receiveWindowDaysForVendor(inv.vendor || "");
        const cached = r.finalePoId ? recentPOs.find((p) => p.orderId === r.finalePoId) : undefined;
        const hit = cached ? findBestReception(cached, entry.pickupDate, win) : null;
        r.receiveDiffDays = hit?.diffDays ?? null;

        const score = scoreFreightApplyConfidence({
            entry,
            hardPoRef: inv.poNumber || null,
            matchSource: r.matchSource,
            finalePoId: r.finalePoId,
            vendor: inv.vendor,
            vendorMatchedBy: inv.vendor ? "name" : null,
            freightAlreadyOnPO: false,
            error: r.error,
            receiveDiffDays: r.receiveDiffDays,
            hasScannedAmount: true, // PDF Total Amount Due is the final invoice
        });
        r.confidence = score.confidence;
        r.reasons.push(...score.reasons);
        r.wouldApply = score.mayApply;
        results.push(r);
    }

    // 6. Freight-already + correction detection for matched rows.
    for (const r of results) {
        if (!r.finalePoId || r.matchSource === "unmatched" || r.matchSource === "excluded") continue;
        if (r.split) {
            // Multi-PO split: per-PO correction detection. Each PO's share vs its
            // current freight decides add/correct/already — not the whole bill.
            for (const s of r.split) {
                try {
                    const po = await finale.getOrderDetails(s.orderId);
                    const carrierFreight = (po.orderAdjustmentList ?? []).filter(
                        (a) => (a.productPromoUrl ?? "").includes("/10007") && Number(a.amount) > 2.5,
                    );
                    const carrierTotal = carrierFreight.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
                    const delta = s.amount - carrierTotal;
                    if (Math.abs(delta) < 0.02) {
                        r.reasons.push(`PO ${s.orderId} already at $${s.amount.toFixed(2)}`);
                    } else {
                        r.reasons.push(
                            `PO ${s.orderId} has $${carrierTotal.toFixed(2)}, split $${s.amount.toFixed(2)} (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`,
                        );
                    }
                    await new Promise((res) => setTimeout(res, GAP_MS));
                } catch (err) {
                    r.reasons.push(`PO ${s.orderId} load failed: ${(err as Error).message.slice(0, 60)}`);
                }
            }
            continue;
        }
        try {
            const po = await finale.getOrderDetails(r.finalePoId);
            const freight = (po.orderAdjustmentList ?? []).filter(
                (a) => (a.productPromoUrl ?? "").includes("/10007"),
            );
            const carrierFreight = freight.filter((a) => Number(a.amount) > 2.5);
            const carrierTotal = carrierFreight.reduce((s, a) => s + (Number(a.amount) || 0), 0);

            if (carrierFreight.length === 0) {
                // No real freight yet → eligible to apply (score decides confidence).
            } else if (Math.abs(carrierTotal - r.invoice.amountDue) < 0.02) {
                r.freightAlreadyOnPO = true;
                r.freightOnPo = carrierTotal;
                r.wouldApply = false;
                r.confidence = "low";
                r.reasons.push(`amount already on PO ($${carrierTotal.toFixed(2)})`);
            } else {
                // Different amount on PO → CORRECTION. The match confidence stays
                // honest (a correlated receive + vendor is still a high-confidence
                // MATCH); only the WRITE is gated, because it restates landed cost.
                r.freightOnPo = carrierTotal;
                r.carrierLineCount = carrierFreight.length;
                r.correctionDelta = r.invoice.amountDue - carrierTotal;
                r.wouldApply = false;
                r.reasons.push(
                    `CORRECTION: PO has $${carrierTotal.toFixed(2)}, invoice ${r.invoice.amountDue.toFixed(2)} (Δ ${r.correctionDelta >= 0 ? "+" : ""}${r.correctionDelta.toFixed(2)})`,
                );
                if (r.correctionDelta < 0) {
                    // FedEx re-rated DOWN — savings. Auto-applies under --correct
                    // ONLY when unambiguous: hard PO ref, single carrier line,
                    // single-delivery vendor (2026-10-28, Bill: "no approval
                    // needed that is savings do not ask me if confidence is high").
                    r.reasons.push("negative delta (savings) — auto-applies when unambiguous");
                }
            }
            await new Promise((res) => setTimeout(res, GAP_MS));
        } catch (err) {
            r.error = err instanceof Error ? err.message : String(err);
            r.wouldApply = false;
            r.reasons.push(`PO load failed: ${r.error.slice(0, 80)}`);
        }
    }

    // 7. Report.
    console.log("\n────────────────────────────────────────────────────────────────────────────");
    for (const r of results) {
        const v = r.vendor || r.invoice.shipper || "?";
        const lag = r.lagDays == null ? "—" : `${r.lagDays}d`;
        if (r.split) {
            const totalLb = r.split.reduce((s, x) => s + x.pounds, 0);
            console.log(
                `  ${r.confidence.toUpperCase().padEnd(6)} | $${r.invoice.amountDue.toFixed(2).padStart(8)} | ` +
                `${v.padEnd(22)} | SPLIT → ${r.split.length} POs | ship ${r.invoice.shipDate || "?"} → inv ${r.invoice.invoiceDate || "?"} (${lag})`,
            );
            for (const s of r.split) {
                const pct = totalLb > 0 ? ((s.pounds / totalLb) * 100).toFixed(1) : "0.0";
                console.log(`           ├─ PO ${s.orderId.padEnd(7)} ${s.pounds.toFixed(1).padStart(8)} lb ${pct.padStart(5)}%  →  $${s.amount.toFixed(2)}`);
            }
            if (r.reasons.length) console.log(`           └─ ${r.reasons.join("; ")}`);
            continue;
        }
        const po = r.finalePoId || r.invoice.poNumber || "-";
        const action = r.freightAlreadyOnPO ? "already"
            : r.correctionDelta !== null ? `CORRECT ${r.correctionDelta >= 0 ? "+" : ""}$${r.correctionDelta.toFixed(2)}`
            : r.wouldApply ? (LIVE ? "APPLY" : "WOULD APPLY")
            : r.matchSource === "unmatched" ? "unmatched"
            : r.matchSource === "excluded" ? "excluded" : "hold";
        console.log(
            `  ${r.confidence.toUpperCase().padEnd(6)} | $${r.invoice.amountDue.toFixed(2).padStart(8)} | ` +
            `${v.padEnd(22)} | PO ${po.padEnd(7)} | ship ${r.invoice.shipDate || "?"} → inv ${r.invoice.invoiceDate || "?"} (${lag}) | ${action}`,
        );
        if (r.reasons.length) console.log(`           └─ ${r.reasons.join("; ")}`);
    }
    console.log("────────────────────────────────────────────────────────────────────────────");

    // 8. Apply (HIGH + no freight already on PO only). Split rows are excluded:
    // a multi-PO correction restates landed cost across several POs, which is
    // Bill's call — the split is reported, never auto-applied.
    const toApplyNow = results.filter((r) => r.wouldApply && r.confidence === "high" && !r.freightAlreadyOnPO && r.correctionDelta === null && !r.split);
    if (LIVE && toApplyNow.length > 0) {
        console.log(`\nApplying ${toApplyNow.length} high-confidence NEW freight adjustment(s)\n`);
        for (const r of toApplyNow) {
            if (!r.finalePoId) continue;
            try {
                const isMulti = r.vendor ? isMultiDeliveryVendor(r.vendor) : false;
                await applyFreightToPo(finale, r.finalePoId, r.invoice.amountDue, isMulti);
                await logReconciliationAnchor(r.finalePoId, r.invoice.amountDue, r.invoice.invoiceNumber, "new");
                console.log(`   OK PO ${r.finalePoId}: +$${r.invoice.amountDue.toFixed(2)} (Freight)`);
                await new Promise((res) => setTimeout(res, GAP_MS));
            } catch (err) {
                r.error = err instanceof Error ? err.message : String(err);
                console.log(`   FAIL PO ${r.finalePoId}: ${r.error.slice(0, 120)}`);
            }
        }
    } else if (LIVE) {
        console.log("\nNo high-confidence NEW rows to apply.");
    }

    // 8b. Apply corrections (--correct + --live). Positive deltas append the
    // difference. Negative deltas (savings) auto-apply only when unambiguous:
    // high confidence, hard PO ref, exactly one carrier line, single-delivery
    // vendor — then the carrier line is rewritten to the final amount with a
    // fresh allocation (2026-10-28).
    const toCorrect = results.filter(
        (r) => r.correctionDelta !== null && r.correctionDelta > 0 && r.confidence === "high",
    );
    const toSave = results.filter(
        (r) =>
            r.correctionDelta !== null &&
            r.correctionDelta < 0 &&
            r.confidence === "high" &&
            r.matchSource === "po_ref" &&
            r.carrierLineCount === 1 &&
            r.vendor !== null &&
            !isMultiDeliveryVendor(r.vendor),
    );
    if (CORRECT && LIVE && toCorrect.length > 0) {
        console.log(`\nApplying ${toCorrect.length} positive correction(s) (append delta)\n`);
        for (const r of toCorrect) {
            if (!r.finalePoId) continue;
            try {
                await applyFreightToPo(finale, r.finalePoId, r.correctionDelta as number, true);
                await logReconciliationAnchor(r.finalePoId, r.correctionDelta as number, r.invoice.invoiceNumber, "correction");
                console.log(`   OK PO ${r.finalePoId}: +$${(r.correctionDelta as number).toFixed(2)} (correction)`);
                await new Promise((res) => setTimeout(res, GAP_MS));
            } catch (err) {
                r.error = err instanceof Error ? err.message : String(err);
                console.log(`   FAIL PO ${r.finalePoId}: ${r.error.slice(0, 120)}`);
            }
        }
    } else if (CORRECT && LIVE) {
        console.log("\nNo high-confidence positive corrections to apply.");
    }

    // 8b2. Negative savings corrections: rewrite the single carrier line to the
    // final invoice amount with a fresh allocation. Never appends a negative
    // line (that would be a funky line, and hygiene blocks it downstream).
    if (CORRECT && LIVE && toSave.length > 0) {
        console.log(`\nApplying ${toSave.length} savings correction(s) (rewrite carrier line to final)\n`);
        for (const r of toSave) {
            if (!r.finalePoId) continue;
            try {
                await applyFreightToPo(finale, r.finalePoId, r.invoice.amountDue, false, true);
                await logReconciliationAnchor(r.finalePoId, r.invoice.amountDue, r.invoice.invoiceNumber, "savings");
                console.log(`   OK PO ${r.finalePoId}: carrier line → $${r.invoice.amountDue.toFixed(2)} (saved $${Math.abs(r.correctionDelta as number).toFixed(2)})`);
                await new Promise((res) => setTimeout(res, GAP_MS));
            } catch (err) {
                r.error = err instanceof Error ? err.message : String(err);
                console.log(`   FAIL PO ${r.finalePoId}: ${r.error.slice(0, 120)}`);
            }
        }
    }

    // 8c. Drift report (--drift): booked (LTL Select quote) vs actual (final
    // invoice), joined on PRO. Read-only. Shared with the Friday EOW PDF.
    if (DRIFT) {
        const DRIFT_MIN = args.includes("--drift-min") ? Number(args[args.indexOf("--drift-min") + 1]) || 5 : 5;
        console.log(`\n─── BOOKED vs ACTUAL (final − LTL Select quote, joined on PRO, |drift| ≥ $${DRIFT_MIN.toFixed(2)}) ───`);
        try {
            const rows = await computeFreightDrift(inbound, DRIFT_MIN);
            const bookedPro = new Set(rows.map((r) => r.pro));
            let noBookingRows = 0;
            for (const inv of inbound) {
                if (!bookedPro.has(inv.freightBillNumber)) noBookingRows++;
            }
            for (const r of rows) {
                const sign = r.drift >= 0 ? "+" : "";
                console.log(
                    `  ${(r.vendor || "?").padEnd(22)} | PRO ${r.pro} | ` +
                    `booked $${r.booked.toFixed(2)} (quote $${r.quote.toFixed(2)}) → actual $${r.actual.toFixed(2)} | ` +
                    `drift ${sign}$${r.drift.toFixed(2)}`,
                );
            }
            console.log(`  material drift: ${rows.length}  (${noBookingRows} without LTL Select booking)`);
        } catch (err) {
            console.log(`  drift report failed: ${(err as Error).message}`);
        }
        console.log("────────────────────────────────────────────────────────────────────────────");
    }

    // 9. Summary.
    const toApply = results.filter((r) => r.wouldApply && r.confidence === "high" && !r.freightAlreadyOnPO && r.correctionDelta === null && !r.split);
    const corrections = results.filter((r) => r.correctionDelta !== null);
    const splits = results.filter((r) => r.split && r.split.length > 0);
    const already = results.filter((r) => r.freightAlreadyOnPO);
    const unmatched = results.filter((r) => r.matchSource === "unmatched");
    console.log("\nSUMMARY");
    console.log(`  notices: ${ids.length}`);
    console.log(`  inbound COLLECT: ${inbound.length}  in scope: ${inScope.length}`);
    console.log(`  HIGH (new): ${toApply.length}  $${toApply.reduce((s, r) => s + r.invoice.amountDue, 0).toFixed(2)}`);
    console.log(`  CORRECTIONS: ${corrections.length}  $${corrections.reduce((s, r) => s + (r.correctionDelta || 0), 0).toFixed(2)}`);
    console.log(`  MULTI-PO SPLITS: ${splits.length}  $${splits.reduce((s, r) => s + r.invoice.amountDue, 0).toFixed(2)}`);
    console.log(`  already on PO: ${already.length}`);
    console.log(`  unmatched: ${unmatched.length}\n`);
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
