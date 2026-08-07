/**
 * @file    reconcile-ltlselect.ts
 * @purpose Reconcile LTL Select Invoice Center COLLECT (BAS-paid inbound) freight
 *          against Finale POs — report missing freight and (with --live) apply it
 *          as a FREIGHT adjustment, mirroring reconcile-fedex.ts.
 *
 *          Default mode is DRY-RUN: nothing is written to Finale. --live is the
 *          only flag that applies changes; --report-only skips even the
 *          vendor_invoices archive.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/reconcile-ltlselect.ts
 *   node --env-file=.env.local --import tsx src/cli/reconcile-ltlselect.ts --days 90
 *   node --env-file=.env.local --import tsx src/cli/reconcile-ltlselect.ts --report-only
 *   node --env-file=.env.local --import tsx src/cli/reconcile-ltlselect.ts --include-excluded
 *   node --env-file=.env.local --import tsx src/cli/reconcile-ltlselect.ts --live   # high confidence only
 *   node --env-file=.env.local --import tsx src/cli/reconcile-ltlselect.ts --live --apply-medium
 *
 * Matching priority:
 *   1. 6-digit Finale PO# embedded in the invoice payload
 *   2. Origin vendor map (name → vendor) + recent POs for that vendor within the
 *      ±45d order / ±7d reception window
 *   3. Unmatched → report for manual review
 *
 * FREIGHT apply (live only): GET → unlock → append adjustment → POST → restore,
 *   exactly like reconcile-fedex Phase 2. Multi-delivery vendors (Rootwise,
 *   Granite) get one line per PRO/BOL; a lone $0 freight placeholder is replaced
 *   in place instead of stacking a second line.
 *
 * @author  Hermia
 * @created 2026-08-05
 * @deps    dotenv, ltlselect/client, ltlselect/match, finale/client,
 *          storage/vendor-invoices, reconciliation/run-tracker, db (probe)
 * @env     LTLSELECT_USER, LTLSELECT_PASS, LTLSELECT_AUTH0_DOMAIN,
 *          LTLSELECT_CLIENT_ID, LTLSELECT_AUDIENCE, LTLSELECT_API_BASE,
 *          FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import os from "os";
import path from "path";

import { FinaleClient } from "../lib/finale/client";
import { FINALE_FREIGHT_PROMO_URL } from "../lib/finale/freight-adjustment";
import { ReconciliationRun } from "../lib/reconciliation/run-tracker";
import { probePostgrest } from "../lib/db";
import { upsertVendorInvoice, lookupVendorInvoices } from "../lib/storage/vendor-invoices";
import {
    loadLtlSelectEnv,
    getLtlSelectToken,
    fetchLtlSelectInvoices,
} from "../lib/ltlselect/client";
import {
    parseCollectEntry,
    extractFinalePoNumber,
    extractHardFinalePoNumber,
    matchVendorFromOrigin,
    isExcludedVendor,
    isMultiDeliveryVendor,
    computeVariance,
    findCorrelatedReception,
    findBestReception,
    pickPoForEntry,
    buildFreightLabel,
    receiveWindowDaysForVendor,
    scoreFreightApplyConfidence,
    entryHasScannedAmount,
    type CollectEntry,
    type FreightApplyConfidence,
} from "../lib/ltlselect/match";
import type { FullPO } from "../lib/finale/client";

// ── Config ───────────────────────────────────────────────────────────────────

const FINALE_ACCOUNT = "buildasoilorganics";
const SANDBOX_DIR = path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox");
const REPORT_FALLBACK_DIR = path.join(process.cwd(), ".tmp-ltl");

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const DRY_RUN = !LIVE;
const REPORT_ONLY = args.includes("--report-only");
const INCLUDE_EXCLUDED = args.includes("--include-excluded");
/** Rare override: also apply medium-confidence matches. High remains default. */
const APPLY_MEDIUM = args.includes("--apply-medium");
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx >= 0 ? Math.max(1, Number.parseInt(args[daysIdx + 1] ?? "90", 10) || 90) : 90;

// ── Result types ─────────────────────────────────────────────────────────────

type MatchSource = "po_ref" | "vendor_window" | "excluded" | "unmatched";

interface LtlMatchResult {
    entry: CollectEntry;
    vendor: string | null;
    vendorMatchedBy: "name" | "city_state" | null;
    finalePoId: string | null;
    matchSource: MatchSource;
    freightAlreadyOnPO: boolean;
    wouldAdd: boolean;
    freightAdded: boolean;
    variance: number;
    label: string;
    confidence: FreightApplyConfidence;
    confidenceReasons: string[];
    mayApply: boolean;
    receiveDiffDays: number | null;
    note?: string;
    error?: string;
}

/** PO document shape (getOrderDetails returns the raw Finale JSON). */
interface PoDoc {
    statusId?: string;
    actionUrlEdit?: string;
    orderAdjustmentList?: Array<{
        amount?: number;
        description?: string;
        productPromoUrl?: string;
    }>;
    supplierName?: string;
    orderSourceName?: string;
    [key: string]: unknown;
}

/** Narrow write surface over FinaleClient for the apply phase. */
interface FinaleWriteSurface {
    getOrderDetails(orderId: string): Promise<PoDoc>;
    unlockForEditing(currentPO: PoDoc, orderId: string): Promise<string>;
    restoreOrderStatus(orderId: string, originalStatus: string): Promise<void>;
    post(endpoint: string, body: unknown): Promise<unknown>;
}

// ── Apply (live only) ────────────────────────────────────────────────────────

/**
 * Add one FREIGHT adjustment to a Finale PO (GET → unlock → append/replace → POST →
 * restore), mirroring reconcile-fedex Phase 2.
 *
 * Single-delivery vendors: replace any existing freight (not just $0).
 * Multi-delivery vendors: append — each PRO/BOL gets its own line.
 * A lone $0 placeholder is replaced in place regardless.
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
        // Replace lone $0 placeholder
        adjustments[zeroFreightIdx] = replacement;
    } else if (!isMultiDelivery) {
        // Single-delivery: remove ALL existing freight lines, keep only the new one
        const nonFreight = adjustments.filter(
            (a) => !(a.productPromoUrl ?? "").includes("/10007"),
        );
        adjustments.length = 0;
        adjustments.push(...nonFreight, replacement);
    } else {
        // Multi-delivery: append — each PRO/BOL gets its own line
        adjustments.push(replacement);
    }

    await finale.post(
        `/${FINALE_ACCOUNT}/api/order/${encodeURIComponent(poId)}`,
        { ...po, orderAdjustmentList: adjustments },
    );
    await finale.restoreOrderStatus(poId, originalStatus);
}

// ── Verification shared by po_ref and vendor_window paths ────────────────────

type VerifyOutcome =
    | { status: "already" | "ok"; note?: string }
    | { status: "excluded" }
    | { status: "error"; error: string };

/**
 * Load a PO and decide whether this freight entry is already on it.
 *
 * Dedup: an existing adjustment whose description mentions the PRO or BOL
 * number counts as already applied. For single-delivery vendors matched via
 * the vendor window, any existing freight on the PO disqualifies it.
 */
async function verifyPoForEntry(
    finale: FinaleWriteSurface,
    poId: string,
    entry: CollectEntry,
    opts: { vendor: string; matchSource: "po_ref" | "vendor_window" },
): Promise<VerifyOutcome> {
    let po: PoDoc;
    try {
        po = await finale.getOrderDetails(poId);
    } catch (err) {
        return {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
        };
    }

    const vendorName = po.supplierName || po.orderSourceName || "";
    if (isExcludedVendor(vendorName) && !INCLUDE_EXCLUDED) {
        return { status: "excluded" };
    }

    const adjustments = po.orderAdjustmentList ?? [];
    const hasThisFreight = adjustments.some((a) => {
        const desc = (a.description ?? "").toLowerCase();
        return (
            (entry.proNumber && desc.includes(entry.proNumber.toLowerCase())) ||
            (entry.bolNumber && desc.includes(entry.bolNumber.toLowerCase()))
        );
    });
    if (hasThisFreight) {
        return { status: "already", note: vendorName };
    }

    // Vendor-window matches on single-delivery vendors must not stack onto a
    // PO that already carries freight (that freight belongs to another
    // delivery we can't attribute). Multi-delivery vendors are exempt.
    if (opts.matchSource === "vendor_window" && !isMultiDeliveryVendor(opts.vendor)) {
        const hasAnyFreight = adjustments.some((a) =>
            (a.description ?? "").toLowerCase().includes("freight"),
        );
        if (hasAnyFreight) {
            return { status: "already", note: `${vendorName} (PO already has freight)` };
        }
    }

    return { status: "ok", note: vendorName };
}

// ── Report helpers ───────────────────────────────────────────────────────────

function reportPath(): string {
    if (fs.existsSync(SANDBOX_DIR)) {
        return path.join(SANDBOX_DIR, "ltlselect-reconcile-report.json");
    }
    fs.mkdirSync(REPORT_FALLBACK_DIR, { recursive: true });
    return path.join(REPORT_FALLBACK_DIR, "ltlselect-reconcile-report.json");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    let run: ReconciliationRun | null = null;
    try {
        run = await ReconciliationRun.start("LTL Select", DRY_RUN ? "dry-run" : "live", {
            days: DAYS,
            reportOnly: REPORT_ONLY,
            includeExcluded: INCLUDE_EXCLUDED,
        });

        console.log(`\n╔════════════════════════════════════════════════════╗`);
        console.log(`║   LTL Select COLLECT Freight → Finale PO Reconcile  ║`);
        console.log(`╚════════════════════════════════════════════════════╝\n`);
        console.log(
            `Mode: ${REPORT_ONLY ? "📊 REPORT ONLY" : DRY_RUN ? "🔵 DRY RUN" : "🔴 LIVE UPDATE"} | Days: ${DAYS} | Apply: ${APPLY_MEDIUM ? "high+medium" : "high only"} | Excluded: ${INCLUDE_EXCLUDED ? "INCLUDED" : "skipped"}\n`,
        );

        // ── Step 1: auth + pull invoices ───────────────────────────────────
        const env = loadLtlSelectEnv();
        const token = await getLtlSelectToken(env);
        console.log("✅ LTL Select authenticated (Auth0 password grant)");

        const dateTo = new Date();
        const dateFrom = new Date();
        dateFrom.setDate(dateFrom.getDate() - DAYS);
        const fmt = (d: Date) =>
            d.toLocaleDateString("en-CA", { timeZone: "America/Denver" });

        const { invoices, totalCount } = await fetchLtlSelectInvoices(token, env, {
            dateFrom: fmt(dateFrom),
            dateTo: fmt(dateTo),
        });
        console.log(`📦 Invoice Center rows: ${invoices.length} (totalCount=${totalCount})\n`);

        const entries = invoices
            .map((inv) => parseCollectEntry(inv))
            .filter((e): e is CollectEntry => e !== null);
        for (const _e of entries) run.recordInvoiceFound();

        const collectTotal = entries.reduce((s, e) => s + e.amount, 0);
        console.log(`📊 Breakdown:`);
        console.log(`   COLLECT (BAS pays):  ${entries.length} — $${collectTotal.toFixed(2)}`);
        console.log(`   PREPAID/outbound skipped: ${invoices.length - entries.length}\n`);

        // ── Step 2: recent POs for vendor-window matching ──────────────────
        const finaleClient = new FinaleClient();
        const finale = finaleClient as unknown as FinaleWriteSurface;

        let recentPOs: FullPO[] = [];
        try {
            recentPOs = await finaleClient.getRecentPurchaseOrders(DAYS + 45, 1000);
            console.log(`Fetched ${recentPOs.length} recent POs for correlation.\n`);
        } catch {
            console.log(`⚠️ Failed to fetch recent POs for correlation\n`);
        }

        // ── Step 3: match every COLLECT entry ──────────────────────────────
        const results: LtlMatchResult[] = [];
        const toApply: Array<{ poId: string; entry: CollectEntry; label: string; vendor: string }> = [];

        const scoreAndMaybeQueue = (base: LtlMatchResult, receiveDiffDays: number | null) => {
            base.receiveDiffDays = receiveDiffDays;
            const score = scoreFreightApplyConfidence({
                entry: base.entry,
                hardPoRef: extractHardFinalePoNumber(base.entry),
                matchSource: base.matchSource,
                finalePoId: base.finalePoId,
                vendor: base.vendor,
                vendorMatchedBy: base.vendorMatchedBy,
                freightAlreadyOnPO: base.freightAlreadyOnPO,
                error: base.error,
                receiveDiffDays,
                hasScannedAmount: entryHasScannedAmount(base.entry),
            });
            base.confidence = score.confidence;
            base.confidenceReasons = score.reasons;
            base.mayApply = score.mayApply || (APPLY_MEDIUM && score.confidence === "medium" && !!base.finalePoId && !base.freightAlreadyOnPO && !base.error && base.matchSource !== "excluded" && base.matchSource !== "unmatched");
            if (base.wouldAdd && base.mayApply && base.finalePoId) {
                toApply.push({ poId: base.finalePoId, entry: base.entry, label: base.label, vendor: base.vendor ?? "" });
            }
            results.push(base);
        };

        for (const entry of entries) {
            const label = buildFreightLabel(entry);
            const hardPo = extractHardFinalePoNumber(entry);
            const softPo = extractFinalePoNumber(entry);
            const poRef = hardPo || softPo;
            const vendorMatch = matchVendorFromOrigin(entry);
            const base: LtlMatchResult = {
                entry,
                vendor: vendorMatch?.vendor ?? null,
                vendorMatchedBy: vendorMatch?.matchedBy ?? null,
                finalePoId: null,
                matchSource: "unmatched",
                freightAlreadyOnPO: false,
                wouldAdd: false,
                freightAdded: false,
                variance: computeVariance(entry),
                label,
                confidence: "low",
                confidenceReasons: [],
                mayApply: false,
                receiveDiffDays: null,
            };

            // Priority 1: 6-digit PO# (hard order/ref preferred; soft blob still reported)
            if (poRef) {
                const verdict = await verifyPoForEntry(finale, poRef, entry, {
                    vendor: vendorMatch?.vendor ?? "",
                    matchSource: "po_ref",
                });
                base.finalePoId = poRef;
                base.matchSource = "po_ref";
                if (verdict.status === "excluded") {
                    base.matchSource = "excluded";
                    base.note = "vendor excluded from auto-freight";
                } else if (verdict.status === "already") {
                    base.freightAlreadyOnPO = true;
                    base.note = verdict.note;
                } else if (verdict.status === "error") {
                    base.error = verdict.error;
                } else {
                    base.wouldAdd = true;
                    base.note = verdict.note;
                }
                // Receive distance for scoring when PO is in recent list
                const cached = recentPOs.find((p) => p.orderId === poRef);
                const win = receiveWindowDaysForVendor(vendorMatch?.vendor ?? "");
                const hit = cached
                    ? findBestReception(cached, entry.pickupDate, win)
                    : null;
                scoreAndMaybeQueue(base, hit?.diffDays ?? null);
                continue;
            }

            // Priority 2: origin vendor map + recent PO date window
            if (vendorMatch) {
                if (isExcludedVendor(vendorMatch.vendor) && !INCLUDE_EXCLUDED) {
                    base.matchSource = "excluded";
                    base.note = "vendor excluded from auto-freight";
                    scoreAndMaybeQueue(base, null);
                    continue;
                }
                const pick = pickPoForEntry(entry, recentPOs, vendorMatch.vendor);
                if (pick) {
                    const verdict = await verifyPoForEntry(finale, pick.orderId, entry, {
                        vendor: vendorMatch.vendor,
                        matchSource: "vendor_window",
                    });
                    base.finalePoId = pick.orderId;
                    base.matchSource = "vendor_window";
                    const win = receiveWindowDaysForVendor(vendorMatch.vendor);
                    const hit = findBestReception(pick, entry.pickupDate, win);
                    if (verdict.status === "already") {
                        base.freightAlreadyOnPO = true;
                        base.note = verdict.note;
                    } else if (verdict.status === "error") {
                        base.error = verdict.error;
                    } else {
                        base.wouldAdd = true;
                        base.note =
                            verdict.note ||
                            findCorrelatedReception(pick, entry.pickupDate, win.maxDays, win.mode) ||
                            `PO ${pick.orderId} (order ${pick.orderDate})`;
                    }
                    scoreAndMaybeQueue(base, hit?.diffDays ?? null);
                } else {
                    base.note = `no PO for ${vendorMatch.vendor} with receive in window`;
                    scoreAndMaybeQueue(base, null);
                }
                continue;
            }

            // Priority 3: unmatched
            scoreAndMaybeQueue(base, null);
        }

        // ── Step 4: report / apply ─────────────────────────────────────────
        console.log(`${"═".repeat(60)}`);
        for (const r of results) {
            const amt = `$${r.entry.amount.toFixed(2)}`;
            const variance = r.variance !== 0 ? ` (Δ${r.variance >= 0 ? "+" : ""}${r.variance.toFixed(2)})` : "";
            const origin = r.entry.originName || `${r.entry.originCity}, ${r.entry.originState}`;
            const conf = r.confidence.toUpperCase().padEnd(6);
            if (r.error) {
                console.log(`❌ ${conf} | ${amt} | ${origin} | ${r.entry.proNumber} | Error: ${r.error.slice(0, 80)}`);
            } else if (r.freightAlreadyOnPO) {
                console.log(`✅ ${conf} | ${amt} | PO ${r.finalePoId} | Already has freight | ${origin}`);
            } else if (r.matchSource === "excluded") {
                console.log(`⏭️  ${conf} | ${amt} | ${origin} | ${r.entry.proNumber} | ${r.note ?? ""}`);
            } else if (r.wouldAdd && r.mayApply) {
                console.log(`🟢 ${conf} | ${amt}${variance} | PO ${r.finalePoId} | ${DRY_RUN ? "WOULD APPLY" : "APPLY"} | ${origin} | ${r.note ?? ""}`);
            } else if (r.wouldAdd) {
                console.log(`🟡 ${conf} | ${amt}${variance} | PO ${r.finalePoId} | hold (not high) | ${origin} | ${r.confidenceReasons.join(",")}`);
            } else {
                console.log(`❓ ${conf} | ${amt} | ${origin} | PRO ${r.entry.proNumber} | ${r.note ?? "no PO found"}`);
            }
        }
        console.log(`${"═".repeat(60)}\n`);

        // ── Step 5: archive to vendor_invoices (idempotent; skipped when DB down) ──
        let archived = 0;
        if (!REPORT_ONLY && entries.length > 0) {
            const dbUp = await probePostgrest();
            if (dbUp) {
                for (const entry of entries) {
                    try {
                        const existing = await lookupVendorInvoices({
                            invoice_number: entry.proNumber,
                        });
                        const already = existing.some((row) => row.status !== "void");
                        if (already) continue; // upsert would be a no-op anyway
                        const id = await upsertVendorInvoice({
                            vendor_name: results.find((r) => r.entry === entry)?.vendor ?? (entry.originName || "Unknown"),
                            invoice_number: entry.proNumber || entry.bolNumber || null,
                            invoice_date: entry.pickupDate || null,
                            total: entry.amount,
                            freight: entry.amount,
                            po_number: results.find((r) => r.entry === entry)?.finalePoId ?? null,
                            status: "received",
                            source: "portal_scrape",
                            source_ref: `ltlselect-${entry.invoiceId || entry.proNumber}`,
                            raw_data: entry.raw as unknown as Record<string, unknown>,
                        });
                        if (id) archived++;
                    } catch {
                        /* archive is best-effort */
                    }
                }
                console.log(`🗂  Archived ${archived}/${entries.length} to vendor_invoices\n`);
            } else {
                console.log(`🗂  vendor_invoices archive skipped (PostgREST not reachable)\n`);
            }
        }

        // ── Step 6: apply freight (live only) ──────────────────────────────
        if (LIVE && toApply.length > 0) {
            console.log(`PHASE 2: Applying ${toApply.length} high-confidence freight adjustment(s)\n`);
            for (const { poId, entry, label, vendor } of toApply) {
                try {
                    await applyFreightToPo(finale, poId, entry.amount, label, isMultiDeliveryVendor(vendor));
                    run.recordFreight(Math.round(entry.amount * 100));
                    run.recordPoUpdated(poId);
                    const row = results.find((r) => r.entry === entry);
                    if (row) {
                        row.freightAdded = true;
                        row.wouldAdd = false;
                    }
                    console.log(`   ✅ PO ${poId}: +$${entry.amount.toFixed(2)} (${label})`);
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    run.recordError(`LTL apply failed for PO ${poId}`, error);
                    console.log(`   ❌ PO ${poId}: ${error.message.slice(0, 120)}`);
                }
            }
            console.log();
        } else if (LIVE && toApply.length === 0) {
            console.log(`PHASE 2: nothing high-confidence to apply (use report; optional --apply-medium)\n`);
        }

        // ── Summary ────────────────────────────────────────────────────────
        const matched = results.filter((r) => r.finalePoId);
        const unmatched = results.filter((r) => r.matchSource === "unmatched");
        const excluded = results.filter((r) => r.matchSource === "excluded");
        const alreadyHad = results.filter((r) => r.freightAlreadyOnPO);
        const high = results.filter((r) => r.confidence === "high");
        const medium = results.filter((r) => r.confidence === "medium");
        const low = results.filter((r) => r.confidence === "low");
        const wouldApply = results.filter((r) => r.wouldAdd && r.mayApply);
        const held = results.filter((r) => r.wouldAdd && !r.mayApply);
        const errors = results.filter((r) => r.error);

        console.log(`SUMMARY`);
        console.log(`${"─".repeat(40)}`);
        console.log(`📦 COLLECT entries:       ${entries.length} ($${collectTotal.toFixed(2)})`);
        console.log(`✅ Matched to PO:         ${matched.length} (${results.filter((r) => r.matchSource === "po_ref").length} by PO#, ${results.filter((r) => r.matchSource === "vendor_window").length} by vendor window)`);
        console.log(`   Already has freight:   ${alreadyHad.length}`);
        console.log(`🟢 HIGH (may apply):      ${high.filter((r) => r.mayApply).length} ($${wouldApply.reduce((s, r) => s + r.entry.amount, 0).toFixed(2)})`);
        console.log(`🟡 MEDIUM (hold):         ${medium.length} ($${held.filter((r) => r.confidence === "medium").reduce((s, r) => s + r.entry.amount, 0).toFixed(2)})`);
        console.log(`⬜ LOW:                   ${low.length}`);
        console.log(`⏭️  Excluded vendors:      ${excluded.length}`);
        console.log(`❓ Unmatched:             ${unmatched.length}`);
        if (errors.length > 0) {
            console.log(`❌ Errors:                ${errors.length}`);
        }
        if (LIVE) {
            console.log(`   Applied this run:      ${results.filter((r) => r.freightAdded).length}`);
        }

        if (held.length > 0) {
            console.log(`\n   Held for review (not high):`);
            for (const r of held) {
                console.log(
                    `     ${r.confidence} | $${r.entry.amount.toFixed(2)} | PO ${r.finalePoId ?? "—"} | PRO ${r.entry.proNumber} | ${r.confidenceReasons.join(",")}`,
                );
            }
        }

        if (unmatched.length > 0) {
            console.log(`\n   Unmatched (manual review):`);
            for (const r of unmatched) {
                console.log(
                    `     ${r.entry.pickupDate || "?"} | $${r.entry.amount.toFixed(2)} | PRO ${r.entry.proNumber || "?"} | ${r.entry.originName || `${r.entry.originCity}, ${r.entry.originState}`}`,
                );
            }
        }

        // ── Report file ────────────────────────────────────────────────────
        const filePath = reportPath();
        const report = {
            runDate: new Date().toISOString(),
            source: "ltlselect_api",
            mode: REPORT_ONLY ? "report" : DRY_RUN ? "dry-run" : "live",
            days: DAYS,
            applyPolicy: APPLY_MEDIUM ? "high+medium" : "high_only",
            summary: {
                totalInvoices: invoices.length,
                collectEntries: entries.length,
                collectTotal,
                matched: matched.length,
                matchedByPoRef: results.filter((r) => r.matchSource === "po_ref").length,
                matchedByVendorWindow: results.filter((r) => r.matchSource === "vendor_window").length,
                excluded: excluded.length,
                unmatched: unmatched.length,
                freightAlreadyOnPO: alreadyHad.length,
                confidenceHigh: high.length,
                confidenceMedium: medium.length,
                confidenceLow: low.length,
                wouldApply: wouldApply.length,
                wouldApplyTotal: wouldApply.reduce((s, r) => s + r.entry.amount, 0),
                held: held.length,
                freightAdded: results.filter((r) => r.freightAdded).length,
                freightAddedTotal: results.filter((r) => r.freightAdded).reduce((s, r) => s + r.entry.amount, 0),
                errors: errors.length,
            },
            results: results.map((r) => ({
                proNumber: r.entry.proNumber,
                bolNumber: r.entry.bolNumber,
                pickupDate: r.entry.pickupDate,
                originName: r.entry.originName,
                originCity: r.entry.originCity,
                originState: r.entry.originState,
                carrier: r.entry.carrier,
                amount: r.entry.amount,
                quoteAmount: r.entry.quoteAmount,
                variance: r.variance,
                vendor: r.vendor,
                vendorMatchedBy: r.vendorMatchedBy,
                finalePoId: r.finalePoId,
                matchSource: r.matchSource,
                confidence: r.confidence,
                confidenceReasons: r.confidenceReasons,
                mayApply: r.mayApply,
                receiveDiffDays: r.receiveDiffDays,
                freightAlreadyOnPO: r.freightAlreadyOnPO,
                wouldAdd: r.wouldAdd,
                freightAdded: r.freightAdded,
                label: r.label,
                note: r.note,
                error: r.error,
            })),
        };
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
        console.log(`\n📄 Report saved: ${filePath}`);

        await run.complete("LTL Select reconciliation complete.");
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (run) {
            await run.fail("LTL Select reconciliation failed", error);
        } else {
            console.error("[LTL Select] Fatal error before run could be created:", error.message);
        }
        throw err;
    }
}

main().catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : err);
    process.exit(1);
});
