/**
 * @file    reconcile-billtrust-freight.ts
 * @purpose Reconcile FedEx Freight Billtrust CSV exports against Finale POs.
 *          Reads the CSV from Billtrust Invoice Gateway, deduplicates multi-row
 *          invoices, identifies inbound COLLECT (vendor → BuildASoil), maps
 *          vendors from SHIP_FROM_ADDRESS, matches to Finale POs, and applies
 *          freight adjustments.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/reconcile-billtrust-freight.ts
 *   node --env-file=.env.local --import tsx src/cli/reconcile-billtrust-freight.ts --csv path/to/FEDEX_*.csv
 *   node --env-file=.env.local --import tsx src/cli/reconcile-billtrust-freight.ts --live
 *   node --env-file=.env.local --import tsx src/cli/reconcile-billtrust-freight.ts --report-only
 *
 * @author  Hermia
 * @created 2026-08-06
 * @deps    dotenv, finale/client, ltlselect/match, storage/vendor-invoices
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import os from "os";
import path from "path";
import { FinaleClient } from "../lib/finale/client";
import { FINALE_FREIGHT_PROMO_URL } from "../lib/finale/freight-adjustment";
import { upsertVendorInvoice } from "../lib/storage/vendor-invoices";
import {
    isMultiDeliveryVendor,
} from "../lib/ltlselect/match";
import type { FullPO } from "../lib/finale/client";
import { pathToFileURL } from "url";

// ── Config ───────────────────────────────────────────────────────────────────

const FINALE_ACCOUNT = "buildasoilorganics";
const SANDBOX_DIR = path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox");

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const DRY_RUN = !LIVE;
const REPORT_ONLY = args.includes("--report-only");
const csvIdx = args.indexOf("--csv");
const CSV_PATH_OVERRIDE = csvIdx >= 0 ? args[csvIdx + 1] : null;

/** Narrow write surface over FinaleClient for the apply phase (same as LTL Select). */
interface PoDoc {
    statusId?: string;
    orderAdjustmentList?: Array<{
        amount?: number;
        description?: string;
        productPromoUrl?: string;
    }>;
    [key: string]: unknown;
}

interface FinaleWriteSurface {
    getOrderDetails(orderId: string): Promise<PoDoc>;
    unlockForEditing(currentPO: PoDoc, orderId: string): Promise<string>;
    restoreOrderStatus(orderId: string, originalStatus: string): Promise<void>;
    post(endpoint: string, body: unknown): Promise<unknown>;
}

/**
 * Add one FREIGHT adjustment (GET → unlock → append/replace → POST → restore).
 * Mirrors reconcile-ltlselect.applyFreightToPo.
 */
async function applyFreightToPo(
    finale: FinaleWriteSurface,
    poId: string,
    amount: number,
    label: string,
    isMultiDelivery: boolean,
): Promise<void> {
    const po = await finale.getOrderDetails(poId);
    const originalStatus = await finale.unlockForEditing(po, poId);

    const adjustments = [...(po.orderAdjustmentList ?? [])];
    const zeroFreightIdx = adjustments.findIndex(
        (a) => (a.productPromoUrl ?? "").includes("/10007") && Number(a.amount) === 0,
    );
    const replacement = { amount, description: label, productPromoUrl: FINALE_FREIGHT_PROMO_URL };

    if (zeroFreightIdx >= 0 && adjustments.length === 1) {
        adjustments[zeroFreightIdx] = replacement;
    } else if (!isMultiDelivery) {
        const nonFreight = adjustments.filter(
            (a) => !(a.productPromoUrl ?? "").includes("/10007"),
        );
        adjustments.length = 0;
        adjustments.push(...nonFreight, replacement);
    } else {
        adjustments.push(replacement);
    }

    await finale.post(
        `/${FINALE_ACCOUNT}/api/order/${encodeURIComponent(poId)}`,
        { ...po, orderAdjustmentList: adjustments },
    );
    await finale.restoreOrderStatus(poId, originalStatus);
}

function isDropshipOrderId(orderId: string | null | undefined): boolean {
    return !!orderId && /dropship/i.test(orderId);
}

/** True if PO already has freight for this BOL/invoice or any freight on single-delivery. */
function freightAlreadyPresent(
    po: PoDoc,
    opts: { bol?: string; invoiceNumber?: string; isMulti: boolean },
): boolean {
    const adjustments = po.orderAdjustmentList ?? [];
    const freight = adjustments.filter((a) =>
        (a.productPromoUrl ?? "").includes("/10007"),
    );
    if (freight.length === 0) return false;
    const needles = [opts.bol, opts.invoiceNumber].filter(Boolean).map((s) => String(s).toLowerCase());
    if (needles.length > 0) {
        const hit = freight.some((a) => {
            const d = (a.description ?? "").toLowerCase();
            return needles.some((n) => n && d.includes(n));
        });
        if (hit) return true;
    }
    // Single-delivery: any non-zero freight blocks a second auto-apply
    if (!opts.isMulti) {
        return freight.some((a) => Number(a.amount) !== 0);
    }
    return false;
}

// ── CSV types ────────────────────────────────────────────────────────────────

interface BilltrustRow {
    TEMPLATE_TYPE: string;
    SHIP_DATE: string;
    TERMS: string;
    BILL_LADING: string;
    PO_NUMBER: string;
    REF_NUM: string;
    AMT_DUE: string;
    INVOICE_DATE: string;
    INVOICE_NUMBER: string;
    SHIP_FROM_ADDRESS: string;
    SHIPPING_ADDRESS: string;
    SCA_CODE: string;
    DOC_TYPE: string;
}

interface BilltrustInvoice {
    invoiceNumber: string;
    invoiceDate: string;
    shipDate: string;
    terms: string;
    amountDue: number;
    bol: string;
    poNumber: string;
    refNum: string;
    shipFromAddress: string;
    shippingAddress: string;
    vendorName: string | null;
    vendorMatchedBy: "address" | "name_map" | null;
}

interface FreightApplyResult {
    invoiceNumber: string;
    vendor: string | null;
    amount: number;
    bol: string;
    poNumber: string;
    finalePoId: string | null;
    matchSource: "po_ref" | "vendor_window" | "invoice_number" | "ltlselect_xref" | "unmatched";
    wouldApply: boolean;
    applied: boolean;
    freightAlreadyOnPO: boolean;
    confidence: "high" | "medium" | "low";
    confidenceReasons: string[];
    label: string;
    error?: string;
}

// ── Vendor mapping from SHIP_FROM_ADDRESS ────────────────────────────────────

const VENDOR_ADDRESS_MAP: Array<{ pattern: RegExp; vendor: string }> = [
    { pattern: /rootwise/i, vendor: "Rootwise Soil Dynamics" },
    { pattern: /grokashi/i, vendor: "Grokashi" },
    { pattern: /granite\s*mill/i, vendor: "Granite Mill Farms" },
    { pattern: /spusa|advantage\s*wh|surepack\s*usa/i, vendor: "Surepack USA" },
    { pattern: /seaforth/i, vendor: "Seaforth Mineral" },
    { pattern: /concentrates/i, vendor: "Concentrates, Inc" },
    { pattern: /diamond\s*k/i, vendor: "Diamond K" },
    { pattern: /farm\s*fuel/i, vendor: "Farm Fuel" },
    { pattern: /ams\s*logistics/i, vendor: "AMS Logistics" },
    { pattern: /molasses/i, vendor: "International Molasses" },
    { pattern: /uline/i, vendor: "Uline" },
    { pattern: /thorvin/i, vendor: "Thorvin" },
    { pattern: /riceland/i, vendor: "Riceland" },
];

function mapVendorFromAddress(address: string): { vendor: string; matchedBy: "address" } | null {
    for (const { pattern, vendor } of VENDOR_ADDRESS_MAP) {
        if (pattern.test(address)) {
            return { vendor, matchedBy: "address" };
        }
    }
    return null;
}

// ── CSV parser ───────────────────────────────────────────────────────────────

function findLatestBilltrustCsv(): string | null {
    const candidates: string[] = [];
    const dirs = [
        path.join(os.homedir(), "Downloads"),
        SANDBOX_DIR,
        path.join(os.homedir(), "Documents", "Projects", "aria", ".hermes", "desktop-attachments"),
    ];
    for (const dir of dirs) {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (/^FEDEX_\d+.*\.csv$/i.test(f)) {
                    candidates.push(path.join(dir, f));
                }
            }
        } catch {}
    }
    // Sort by mtime descending
    candidates.sort((a, b) => {
        try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
            return 0;
        }
    });
    return candidates[0] || null;
}

function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ",") {
                result.push(current.trim());
                current = "";
            } else {
                current += ch;
            }
        }
    }
    result.push(current.trim());
    return result;
}

function parseBilltrustCsv(csvPath: string): BilltrustRow[] {
    const text = fs.readFileSync(csvPath, "utf-8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return [];

    const header = parseCsvLine(lines[0]);
    const rows: BilltrustRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        if (cols.length < header.length) continue;
        const row: Record<string, string> = {};
        for (let j = 0; j < header.length; j++) {
            row[header[j]] = cols[j] || "";
        }
        if (row.TEMPLATE_TYPE !== "INVHDR") continue; // skip detail lines
        rows.push(row as unknown as BilltrustRow);
    }
    return rows;
}

// ── Dedup & filter inbound ───────────────────────────────────────────────────

function dedupInboundInvoices(rows: BilltrustRow[]): BilltrustInvoice[] {
    const seen = new Map<string, BilltrustInvoice>();

    for (const r of rows) {
        const invNum = r.INVOICE_NUMBER.trim();
        if (!invNum) continue;

        // Only COLLECT with BUILDASOIL as shipping destination
        const terms = r.TERMS.trim().toUpperCase();
        if (terms !== "COLLECT") continue;
        const shipTo = (r.SHIPPING_ADDRESS || "").toUpperCase();
        if (!shipTo.includes("BUILDASOIL")) continue;

        if (seen.has(invNum)) continue; // already captured (first row is header)

        const amount = parseFloat((r.AMT_DUE || "0").replace(/,/g, "")) || 0;
        const vendorMatch = mapVendorFromAddress(r.SHIP_FROM_ADDRESS || "");

        seen.set(invNum, {
            invoiceNumber: invNum,
            invoiceDate: r.INVOICE_DATE || "",
            shipDate: r.SHIP_DATE || "",
            terms: r.TERMS.trim(),
            amountDue: amount,
            bol: r.BILL_LADING || "",
            poNumber: r.PO_NUMBER || "",
            refNum: r.REF_NUM || "",
            shipFromAddress: r.SHIP_FROM_ADDRESS || "",
            shippingAddress: r.SHIPPING_ADDRESS || "",
            vendorName: vendorMatch?.vendor || null,
            vendorMatchedBy: vendorMatch?.matchedBy || null,
        });
    }

    return [...seen.values()].sort(
        (a, b) => (b.invoiceDate || "").localeCompare(a.invoiceDate || ""),
    );
}

function extractFinalePoFromRef(poNumberStr: string): string | null {
    // Try 6-digit PO first
    const sixDigit = poNumberStr.match(/\b(\d{6})\b/);
    if (sixDigit) return sixDigit[1];
    // PO field sometimes has invoice-accountnumber; try extracting just 6 digits anywhere
    const anySix = poNumberStr.match(/(\d{6})/);
    if (anySix) return anySix[1];
    return null;
}

// ── Match to Finale POs ──────────────────────────────────────────────────────

async function matchToFinalePOs(
    invoices: BilltrustInvoice[],
    recentPOs: FullPO[],
): Promise<FreightApplyResult[]> {
    const results: FreightApplyResult[] = [];

    for (const inv of invoices) {
        const base: FreightApplyResult = {
            invoiceNumber: inv.invoiceNumber,
            vendor: inv.vendorName,
            amount: inv.amountDue,
            bol: inv.bol,
            poNumber: inv.poNumber,
            finalePoId: null,
            matchSource: "unmatched",
            wouldApply: false,
            applied: false,
            freightAlreadyOnPO: false,
            confidence: "low",
            confidenceReasons: [],
            label: inv.bol ? `Freight BOL ${inv.bol}` : `Freight ${inv.invoiceNumber}`,
        };

        // 1. Direct PO# match (never Dropship / non-numeric junk)
        const poFromRef = extractFinalePoFromRef(inv.poNumber);
        if (poFromRef && !isDropshipOrderId(poFromRef)) {
            const found = recentPOs.find(
                (p) => p.orderId === poFromRef && !isDropshipOrderId(p.orderId),
            );
            if (found) {
                base.finalePoId = found.orderId;
                base.matchSource = "po_ref";
                base.confidence = "high";
                base.confidenceReasons.push(`PO# ${poFromRef} matched in Finale`);
                base.wouldApply = true;
                results.push(base);
                continue;
            }
        }

        // 2. Cross-reference with LTL Select report (invoice number = LTL Select PRO)
        // The Billtrust invoice numbers are the same as LTL Select PRO numbers.
        // If we have a prior LTL Select match, use it directly.
        const ltlReportPath = (() => {
            const candidates = [
                path.join(SANDBOX_DIR, "processed", "ltlselect-reconcile-report.json"),
                path.join(SANDBOX_DIR, "ltlselect-reconcile-report.json"),
            ];
            // Also try glob for latest ltlselect report in processed/
            try {
                const dir = path.join(SANDBOX_DIR, "processed");
                if (fs.existsSync(dir)) {
                    for (const f of fs.readdirSync(dir).sort().reverse()) {
                        if (f.startsWith("ltlselect-reconcile-report") && f.endsWith(".json")) {
                            candidates.push(path.join(dir, f));
                            break;
                        }
                    }
                }
            } catch {}
            for (const p of candidates) {
                if (fs.existsSync(p)) return p;
            }
            return null;
        })();
        if (ltlReportPath && inv.invoiceNumber) {
            try {
                const ltlReport = JSON.parse(fs.readFileSync(ltlReportPath, "utf8"));
                const ltlResults = (ltlReport.results || ltlReport) as any[];
                let ltlMatched = false;
                for (const lr of ltlResults) {
                    const pro = lr?.proNumber || lr?.entry?.proNumber || "";
                    if (pro === inv.invoiceNumber && lr?.finalePoId && !isDropshipOrderId(lr.finalePoId)) {
                        base.finalePoId = lr.finalePoId;
                        base.matchSource = "ltlselect_xref";
                        base.confidence = lr?.confidence === "medium" ? "medium" : "high";
                        base.confidenceReasons.push(
                            `Invoice ${inv.invoiceNumber} → LTL Select matched PO ${lr.finalePoId}`,
                        );
                        base.wouldApply = base.confidence === "high";
                        ltlMatched = true;
                        break;
                    }
                }
                if (ltlMatched) {
                    results.push(base);
                    continue;
                }
            } catch {}
        }

        // 3. Vendor + date window match (issueDate often empty; fall back to orderDate)
        if (inv.vendorName) {
            const vendorKey = inv.vendorName.split(" ")[0].toLowerCase();
            const vendorPOs = recentPOs.filter((p) => {
                const name = (p.vendorName || "").toLowerCase();
                // Skip DropshipPO / order IDs that aren't real Finale numbers
                if (/\bDropshipPO\b/i.test(p.orderId)) return false;
                return name.includes(vendorKey);
            });

            if (vendorPOs.length > 0) {
                // Sort by date proximity if dates available
                const withDates = vendorPOs.filter(
                    (p) => ((p as any).issueDate || (p as any).orderDate || "").length >= 8,
                );
                const withoutDates = vendorPOs.filter(
                    (p) => !((p as any).issueDate || (p as any).orderDate || "").length,
                );

                // Prefer dated POs close to ship date
                if (withDates.length > 0 && inv.shipDate) {
                    withDates.sort((a, b) => {
                        const aDate = ((a as any).issueDate || (a as any).orderDate || "").slice(0, 10);
                        const bDate = ((b as any).issueDate || (b as any).orderDate || "").slice(0, 10);
                        const aDist = Math.abs(new Date(aDate).getTime() - new Date(inv.shipDate).getTime());
                        const bDist = Math.abs(new Date(bDate).getTime() - new Date(inv.shipDate).getTime());
                        return aDist - bDist;
                    });
                    const closest = withDates[0];
                    const closestDate = ((closest as any).issueDate || (closest as any).orderDate || "").slice(0, 10);
                    const distDays = Math.abs(
                        (new Date(inv.shipDate).getTime() - new Date(closestDate).getTime()) / 86400000,
                    );
                    if (!Number.isNaN(distDays) && distDays <= 90) {
                        base.finalePoId = closest.orderId;
                        base.matchSource = "vendor_window";
                        base.confidence = distDays <= 30 ? "high" : "medium";
                        base.confidenceReasons.push(
                            `Vendor ${inv.vendorName} PO ${closest.orderId} (Δ${Math.round(distDays)}d)`,
                        );
                        base.wouldApply = base.confidence === "high";
                        results.push(base);
                        continue;
                    }
                }

                // Fallback: match by vendor name alone (no dates available)
                // Use most recent PO number (highest 6-digit)
                const numericPOs = vendorPOs.filter((p) => /^\d{6}$/.test(p.orderId));
                if (numericPOs.length > 0) {
                    numericPOs.sort((a, b) => parseInt(b.orderId) - parseInt(a.orderId));
                    base.finalePoId = numericPOs[0].orderId;
                    base.matchSource = "vendor_window";
                    base.confidence = "medium";
                    base.confidenceReasons.push(
                        `Vendor ${inv.vendorName} — matched most recent PO ${base.finalePoId} (no dates on PO)`,
                    );
                    base.wouldApply = false; // hold for review
                    results.push(base);
                    continue;
                }
            }
        }

        // 3. No match — report
        base.confidenceReasons.push(
            inv.vendorName
                ? `No PO found for ${inv.vendorName} within window`
                : "Unknown vendor — cannot match",
        );
        results.push(base);
    }

    return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log("\n╔════════════════════════════════════════════════════╗");
    console.log("║  Billtrust FedEx Freight → Finale PO Reconcile    ║");
    console.log("╚════════════════════════════════════════════════════╝\n");

    const mode = LIVE ? "🔴 LIVE UPDATE" : "📊 REPORT ONLY";
    console.log(`Mode: ${mode}\n`);

    // Find CSV
    const csvPath = CSV_PATH_OVERRIDE || findLatestBilltrustCsv();
    if (!csvPath || !fs.existsSync(csvPath)) {
        console.error("No Billtrust CSV found. Drop FEDEX_*.csv in Downloads or Sandbox, or use --csv.");
        console.error("  Download from: https://secure2.billtrust.com/fedex/ig/open");
        process.exit(1);
    }
    console.log(`CSV: ${csvPath}\n`);

    // Parse
    const rows = parseBilltrustCsv(csvPath);
    console.log(`Parsed: ${rows.length} INVHDR rows\n`);

    // Dedup inbound
    const invoices = dedupInboundInvoices(rows);
    console.log(`Inbound COLLECT (vendor → BuildASoil): ${invoices.length}`);
    for (const inv of invoices) {
        console.log(
            `  $${inv.amountDue.toFixed(2)} | ${inv.vendorName || "?"} | BOL ${inv.bol || "-"} | PO ${inv.poNumber} | ${inv.shipDate}`,
        );
    }
    console.log(
        `  TOTAL: $${invoices.reduce((s, i) => s + i.amountDue, 0).toFixed(2)}\n`,
    );

    // Finale POs — default ctor only (credentials from env inside client)
    console.log("Fetching Finale POs...");
    const finaleClient = new FinaleClient();
    const finale = finaleClient as unknown as FinaleWriteSurface;
    const recentPOs = await finaleClient.getRecentPurchaseOrders(365);
    console.log(`POs: ${recentPOs.length} (365d)\n`);

    // Match
    const results = await matchToFinalePOs(invoices, recentPOs);

    // Pre-apply freight-already gate for HIGH candidates (read-only GET)
    for (const r of results) {
        if (!r.wouldApply || !r.finalePoId || isDropshipOrderId(r.finalePoId)) {
            if (isDropshipOrderId(r.finalePoId)) {
                r.wouldApply = false;
                r.confidenceReasons.push("blocked: DropshipPO");
            }
            continue;
        }
        try {
            const po = await finale.getOrderDetails(r.finalePoId);
            const isMulti = r.vendor ? isMultiDeliveryVendor(r.vendor) : false;
            if (freightAlreadyPresent(po, {
                bol: r.bol,
                invoiceNumber: r.invoiceNumber,
                isMulti,
            })) {
                r.freightAlreadyOnPO = true;
                r.wouldApply = false;
                r.confidenceReasons.push("freight already on PO");
            }
        } catch (err) {
            r.error = err instanceof Error ? err.message : String(err);
            r.wouldApply = false;
            r.confidenceReasons.push(`PO load failed: ${r.error.slice(0, 80)}`);
        }
    }

    console.log("════════════════════════════════════════════════════════════");
    for (const r of results) {
        const icon =
            r.matchSource === "unmatched"
                ? "❓"
                : r.freightAlreadyOnPO
                  ? "⏭"
                  : r.confidence === "high"
                    ? "🟢"
                    : "🟡";
        const action = r.freightAlreadyOnPO
            ? "already"
            : r.wouldApply
              ? (DRY_RUN ? "WOULD APPLY" : "APPLIED")
              : r.matchSource === "unmatched"
                ? "unmatched"
                : "hold";
        console.log(
            `${icon} ${r.confidence.toUpperCase().padEnd(6)} | $${r.amount.toFixed(2)} | ${r.vendor || "?"} | ${action} | ${r.confidenceReasons.join("; ")}`,
        );
    }
    console.log("════════════════════════════════════════════════════════════\n");

    // Summary
    const byConfidence = {
        high: results.filter((r) => r.confidence === "high" && r.wouldApply),
        medium: results.filter((r) => r.confidence === "medium" && r.wouldApply),
        already: results.filter((r) => r.freightAlreadyOnPO),
        unmatched: results.filter((r) => r.matchSource === "unmatched"),
    };

    console.log("SUMMARY");
    console.log("────────────────────────────────────────");
    console.log(`📦 Inbound invoices:       ${invoices.length}`);
    console.log(`🟢 HIGH (would apply):     ${byConfidence.high.length} ($${byConfidence.high.reduce((s, r) => s + r.amount, 0).toFixed(2)})`);
    console.log(`🟡 MEDIUM (hold):          ${byConfidence.medium.length}`);
    console.log(`⏭  Already on PO:          ${byConfidence.already.length}`);
    console.log(`❓ Unmatched:              ${byConfidence.unmatched.length}`);

    // ── Apply freight (live) — public write surface via LTL-style helper ──
    if (LIVE && byConfidence.high.length > 0) {
        console.log(`\nPHASE 2: Applying ${byConfidence.high.length} high-confidence freight adjustment(s)\n`);

        for (const r of byConfidence.high) {
            if (!r.finalePoId || isDropshipOrderId(r.finalePoId)) continue;
            try {
                const isMulti = r.vendor ? isMultiDeliveryVendor(r.vendor) : false;
                await applyFreightToPo(finale, r.finalePoId, r.amount, r.label, isMulti);
                r.applied = true;
                console.log(`   ✅ PO ${r.finalePoId}: +$${r.amount.toFixed(2)} (${r.label})`);
            } catch (err) {
                r.error = err instanceof Error ? err.message : String(err);
                console.log(`   ❌ PO ${r.finalePoId}: ${r.error.slice(0, 120)}`);
            }
        }
    }

    // Archive
    if (!REPORT_ONLY) {
        try {
            for (const inv of invoices) {
                await upsertVendorInvoice({
                    vendor: inv.vendorName || "FedEx Freight (unknown)",
                    invoice_number: inv.invoiceNumber,
                    invoice_date: inv.invoiceDate,
                    total: inv.amountDue,
                    po_number: inv.poNumber || null,
                    bol_number: inv.bol || null,
                    source: "billtrust_csv",
                    source_ref: path.basename(csvPath),
                }).catch(() => {});
            }
            console.log(`\n🗂  Archived ${invoices.length} to vendor_invoices`);
        } catch {}
    }

    // Save report
    const reportPath = path.join(
        SANDBOX_DIR,
        `billtrust-reconcile-report-${Date.now()}.json`,
    );
    try {
        fs.writeFileSync(
            reportPath,
            JSON.stringify({ invoices, results, summary: { total: invoices.length, high: byConfidence.high.length, medium: byConfidence.medium.length, unmatched: byConfidence.unmatched.length } }, null, 2),
        );
        console.log(`\n📄 Report: ${reportPath}`);
    } catch {}

    console.log();
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
