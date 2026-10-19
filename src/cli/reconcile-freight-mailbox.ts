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
 *          amount is a CORRECTION and is reported, never auto-applied (landed-cost
 *          restatement is Bill's call).
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
import { freightAdjustmentForPo } from "../lib/finale/freight-adjustment";
import {
    VENDOR_ORIGIN_MAP,
    pickPoForEntry,
    findBestReception,
    receiveWindowDaysForVendor,
    isMultiDeliveryVendor,
    isExcludedVendor,
    scoreFreightApplyConfidence,
    parseCollectEntry,
    type CollectEntry,
} from "../lib/ltlselect/match";
import {
    loadLtlSelectEnv,
    getLtlSelectToken,
    fetchLtlSelectInvoices,
} from "../lib/ltlselect/client";
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

async function applyFreightToPo(
    finale: FinaleWriteSurface,
    poId: string,
    amount: number,
    isMultiDelivery: boolean,
): Promise<void> {
    const po = await finale.getOrderDetails(poId);
    const originalStatus = await finale.unlockForEditing(po, poId);

    const adjustments = [...(po.orderAdjustmentList ?? [])];
    const items = await finale.freightAllocLines(po.orderItemList);
    const existingFreight = adjustments.filter((a) => (a.productPromoUrl ?? "").includes("/10007"));
    const existingAlloc = !isMultiDelivery && existingFreight.length === 1
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
            const pick = pickPoForEntry(entry, recentPOs, inv.vendor);
            if (pick) {
                r.finalePoId = pick.orderId;
                r.matchSource = "vendor_window";
            } else {
                r.reasons.push(`no ${inv.vendor} PO in order window`);
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
                r.correctionDelta = r.invoice.amountDue - carrierTotal;
                r.wouldApply = false;
                r.reasons.push(
                    `CORRECTION: PO has $${carrierTotal.toFixed(2)}, invoice $${r.invoice.amountDue.toFixed(2)} (Δ $${r.correctionDelta >= 0 ? "+" : ""}${r.correctionDelta.toFixed(2)})`,
                );
                if (r.correctionDelta < 0) {
                    // FedEx re-rated DOWN: reducing freight/COGS is a manual call.
                    r.confidence = "low";
                    r.reasons.push("negative delta → manual review (reduces landed cost)");
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

    // 8. Apply (HIGH + no freight already on PO only).
    const toApplyNow = results.filter((r) => r.wouldApply && r.confidence === "high" && !r.freightAlreadyOnPO && r.correctionDelta === null);
    if (LIVE && toApplyNow.length > 0) {
        console.log(`\nApplying ${toApplyNow.length} high-confidence NEW freight adjustment(s)\n`);
        for (const r of toApplyNow) {
            if (!r.finalePoId) continue;
            try {
                const isMulti = r.vendor ? isMultiDeliveryVendor(r.vendor) : false;
                await applyFreightToPo(finale, r.finalePoId, r.invoice.amountDue, isMulti);
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

    // 8b. Apply positive corrections (--correct + --live): append the delta so the
    // PO lands on the final invoice amount. Negative deltas never auto-apply.
    const toCorrect = results.filter(
        (r) => r.correctionDelta !== null && r.correctionDelta > 0 && r.confidence === "high",
    );
    if (CORRECT && LIVE && toCorrect.length > 0) {
        console.log(`\nApplying ${toCorrect.length} positive correction(s) (append delta)\n`);
        for (const r of toCorrect) {
            if (!r.finalePoId) continue;
            try {
                await applyFreightToPo(finale, r.finalePoId, r.correctionDelta as number, true);
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

    // 8c. Drift report (--drift): booked (LTL Select quote) vs actual (final
    // invoice), joined on PRO. Read-only. Surfaces only non-trivial drift so an
    // unapplied PO does not read "0 → final" and flood the review.
    if (DRIFT) {
        console.log("\n─── BOOKED vs ACTUAL (final − LTL Select quote, joined on PRO) ─────────────");
        try {
            const env = loadLtlSelectEnv();
            const token = await getLtlSelectToken(env);
            const dateTo = new Date();
            const dateFrom = new Date(dateTo.getTime() - 90 * 86_400_000);
            const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
            const { invoices: ltlInvoices } = await fetchLtlSelectInvoices(token, env, {
                dateFrom: fmt(dateFrom),
                dateTo: fmt(dateTo),
            });
            // PRO → booked (scanned invoice total, quote fallback) + quote
            const bookedByPro = new Map<string, { amount: number; quote: number; vendor: string | null }>();
            for (const li of ltlInvoices) {
                const e = parseCollectEntry(li);
                if (!e || !e.proNumber) continue;
                bookedByPro.set(e.proNumber, { amount: e.amount, quote: e.quoteAmount, vendor: e.originName || null });
            }
            let driftRows = 0;
            for (const inv of inbound) {
                const booked = bookedByPro.get(inv.freightBillNumber);
                if (!booked) {
                    console.log(`  ${(inv.vendor || inv.shipper || "?").padEnd(22)} | PRO ${inv.freightBillNumber} | final $${inv.amountDue.toFixed(2)} | no LTL Select booking`);
                    driftRows++;
                    continue;
                }
                const drift = inv.amountDue - booked.amount;
                if (Math.abs(drift) < 0.02) continue; // clean match → silent
                const sign = drift >= 0 ? "+" : "";
                console.log(
                    `  ${(inv.vendor || inv.shipper || "?").padEnd(22)} | PRO ${inv.freightBillNumber} | ` +
                    `booked $${booked.amount.toFixed(2)} (quote $${booked.quote.toFixed(2)}) → actual $${inv.amountDue.toFixed(2)} | ` +
                    `drift ${sign}$${drift.toFixed(2)}`,
                );
                driftRows++;
            }
            if (driftRows === 0) console.log("  no drift");
        } catch (err) {
            console.log(`  drift report failed: ${(err as Error).message}`);
        }
        console.log("────────────────────────────────────────────────────────────────────────────");
    }

    // 9. Summary.
    const toApply = results.filter((r) => r.wouldApply && r.confidence === "high" && !r.freightAlreadyOnPO && r.correctionDelta === null);
    const corrections = results.filter((r) => r.correctionDelta !== null);
    const already = results.filter((r) => r.freightAlreadyOnPO);
    const unmatched = results.filter((r) => r.matchSource === "unmatched");
    console.log("\nSUMMARY");
    console.log(`  notices: ${ids.length}`);
    console.log(`  inbound COLLECT: ${inbound.length}  in scope: ${inScope.length}`);
    console.log(`  HIGH (new): ${toApply.length}  $${toApply.reduce((s, r) => s + r.invoice.amountDue, 0).toFixed(2)}`);
    console.log(`  CORRECTIONS: ${corrections.length}  $${corrections.reduce((s, r) => s + (r.correctionDelta || 0), 0).toFixed(2)}`);
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
