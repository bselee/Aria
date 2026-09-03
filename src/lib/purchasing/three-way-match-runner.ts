/**
 * @file    three-way-match-runner.ts
 * @purpose The AUTOMATED CALLER for the canonical 3-way match. three-way-match.ts
 *          is a pure function with no I/O; before this module existed nothing
 *          on a schedule loaded PO + receipt + invoice together and wrote a
 *          verdict back. This runner closes that gap:
 *
 *            1. Loads every matched invoice (vendor_invoices.po_number set).
 *            2. Loads the PO lines (purchase_orders) + receipt leg
 *               (po_receipt_data) + invoice lines.
 *            3. Runs the canonical 3-way match (via completion-gate's shared
 *               runThreeWayMatch, so the gate and this runner read IDENTICAL
 *               output).
 *            4. Writes the verdict to reconciliation_outcomes — mapping
 *               matched/variance/exception/incomplete to distinct
 *               three_way_* outcomes so "missing receipt" is NEVER recorded as
 *               match_failed.
 *            5. Records clean matches in confirmed_po_matches so the
 *               invoice-po-matcher's fine-tuning loop learns them (confirmed
 *               vendor→PO pairs get a 95-point boost on future invoices).
 *
 *          Idempotent: an invoice already carrying a three_way_* outcome is
 *          skipped, so the every-30m cron drains the backlog once and only
 *          re-runs new matches.
 *
 * @author  Aria Coder
 * @created 2026-08-12
 * @deps    ./completion-gate, ./three-way-match, ./pack-size-registry,
 *          @/lib/db, @/lib/runtime/observability/reconciliation-outcomes
 * @env     PGRST_URL (via @/lib/db)
 */

import { createClient } from "@/lib/db";
import {
    writeReconciliationOutcome,
    type ReconciliationOutcome,
} from "@/lib/runtime/observability/reconciliation-outcomes";
import {
    extractInvoiceLines,
    runThreeWayMatch,
    type CompletionGateInput,
    type GatePoLine,
    type InvoiceLine,
} from "./completion-gate";
import { getPackSizes } from "./pack-size-registry";
import type { ThreeWayVerdict } from "./three-way-match";

/** Total-level tolerance for invoices whose OCR yielded no itemized lines. */
const TOTAL_TOLERANCE_PCT = 0.02;

/** The four three-way verdicts mapped to their reconciliation_outcomes value. */
const VERDICT_TO_OUTCOME: Record<ThreeWayVerdict, ReconciliationOutcome> = {
    matched: "three_way_matched",
    variance: "three_way_variance",
    exception: "three_way_exception",
    incomplete: "three_way_incomplete",
};

/** Vendor-name garbage patterns — OCR noise that must never seed the matcher. */
const GARBAGE_VENDOR_RE =
    /^(info|invoice|receipts?|payment|statement|reminder|notice|balance|unknown|none|n\/a|na|misc|account|acct|order|po|from|re:|fwd:)[\s+\/]?/i;

/**
 * True when a vendor name is OCR garbage and must not be recorded as a
 * confirmed match (it would poison the matcher's fine-tuning loop).
 *
 * @param vendor The raw vendor_name string.
 * @returns true when the name is empty, too short, or matches a noise pattern.
 */
export function isGarbageVendorName(vendor: string | null | undefined): boolean {
    const v = String(vendor ?? "").trim();
    if (!v || v.length < 3) return true;
    if (GARBAGE_VENDOR_RE.test(v)) return true;
    if (/^receipts?\s*[+\/]?\s*acct/i.test(v)) return true;
    return false;
}

/**
 * Map a canonical 3-way verdict to the reconciliation_outcomes outcome string.
 * Pure — exported for the golden-fixture test.
 *
 * @param verdict The canonical ThreeWayVerdict.
 * @returns The corresponding ReconciliationOutcome.
 */
export function mapVerdictToOutcome(verdict: ThreeWayVerdict): ReconciliationOutcome {
    return VERDICT_TO_OUTCOME[verdict];
}

/**
 * Total-level verdict for invoices whose OCR produced no itemized lines.
 * Mirrors receivings-enrichment: feeding empty invoice lines into the line gate
 * produced a false 100% price variance on every PO line, so when there are no
 * invoice lines we compare totals only.
 */
export function totalLevelVerdict(
    invoiceTotal: number,
    poTotal: number,
): { verdict: "matched" | "variance" | "incomplete"; summary: string } {
    if (invoiceTotal <= 0 || poTotal <= 0) {
        return { verdict: "incomplete", summary: "Cannot compare totals — missing amount on one side." };
    }
    const pct = Math.abs(invoiceTotal - poTotal) / poTotal;
    if (pct <= TOTAL_TOLERANCE_PCT) {
        return {
            verdict: "matched",
            summary: `Totals agree within ±2% ($${invoiceTotal.toFixed(2)} vs $${poTotal.toFixed(2)}) — no itemized invoice lines.`,
        };
    }
    return {
        verdict: "variance",
        summary: `Invoice total $${invoiceTotal.toFixed(2)} vs PO $${poTotal.toFixed(2)} (${(pct * 100).toFixed(1)}%) — no itemized lines to attribute.`,
    };
}

/** Normalized result of a single invoice's three-way evaluation. */
export interface InvoiceThreeWayEvaluation {
    verdict: ThreeWayVerdict;
    summary: string;
    missingLegs: string[];
    totalDollarImpact: number;
}

/**
 * Evaluate one invoice against its PO + receipt. Pure — no I/O, no DB.
 *
 * Guards against the two false-exception classes found in production:
 *   - No itemized invoice lines → total-level comparison (not a line gate).
 *   - Missing receipt leg → "incomplete" (not a blocking exception), so the
 *     caller records three_way_incomplete instead of three_way_exception.
 *
 * @param args Normalized PO/invoice/receipt figures.
 * @returns The authoritative verdict + summary.
 */
export function evaluateInvoiceThreeWay(args: {
    orderId: string;
    poLines: GatePoLine[];
    invoiceLines: InvoiceLine[];
    hasReceipt: boolean;
    hasInvoice: boolean;
    receivedQtys: Record<string, number>;
    packMultipliers: Record<string, number>;
    invoiceTotal: number;
    poTotal: number;
}): InvoiceThreeWayEvaluation {
    const invoiceHasLines =
        args.invoiceLines.length > 0 && args.invoiceLines.some((l) => l.qty > 0);

    // Total-only comparison when the invoice has no extracted lines.
    if (args.hasReceipt && args.hasInvoice && !invoiceHasLines) {
        const t = totalLevelVerdict(args.invoiceTotal, args.poTotal);
        return { verdict: t.verdict, summary: t.summary, missingLegs: [], totalDollarImpact: 0 };
    }

    const input: CompletionGateInput = {
        orderId: args.orderId,
        hasReceipt: args.hasReceipt,
        hasInvoice: args.hasInvoice,
        poLines: args.poLines,
        invoiceLines: args.invoiceLines,
        receivedQtys: args.receivedQtys,
        packMultipliers: args.packMultipliers,
    };
    const match = runThreeWayMatch(input);
    return {
        verdict: match.verdict,
        summary: match.summary,
        missingLegs: match.missingLegs,
        totalDollarImpact: match.totalDollarImpact,
    };
}

/** Structured result of one automation pass. */
export interface ThreeWayRunResult {
    processed: number;
    matched: number;
    variance: number;
    exception: number;
    incomplete: number;
    /** Newly-upserted confirmed_po_matches rows (clean matches). */
    confirmed: number;
    /** Invoices skipped because they already carry a three_way_* outcome. */
    skippedExisting: number;
    errors: number;
    details: string[];
}

/**
 * Run one automation pass over matched invoices. Never throws.
 *
 * Bounded by `limit` (default 50) so the every-30m cron drains the backlog
 * without running long. Idempotent via a three_way_* outcome existence check.
 *
 * @param opts Optional bounds (limit).
 * @returns Counts per verdict + per-invoice detail lines for logging.
 */
export async function runThreeWayMatchAutomation(opts?: {
    limit?: number;
    /** When true, evaluate + report but write nothing (CLI dry-run). */
    dryRun?: boolean;
}): Promise<ThreeWayRunResult> {
    const result: ThreeWayRunResult = {
        processed: 0,
        matched: 0,
        variance: 0,
        exception: 0,
        incomplete: 0,
        confirmed: 0,
        skippedExisting: 0,
        errors: 0,
        details: [],
    };

    const db = createClient();
    if (!db) {
        result.details.push("no DB client");
        return result;
    }
    const limit = opts?.limit ?? 50;
    const dryRun = opts?.dryRun === true;

    // Load every matched invoice (bounded by a generous ceiling — the matched
    // set is a few hundred rows). We filter UNPROCESSED below rather than
    // limiting here, so the every-30m cron drains the whole backlog oldest or
    // newest first instead of re-reading the same newest window forever.
    const { data: invoices, error: loadErr } = await db
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, po_number, total, line_items, raw_data, created_at")
        .not("po_number", "is", null)
        .order("created_at", { ascending: false })
        .limit(2000);

    if (loadErr) {
        result.errors++;
        result.details.push(`load invoices: ${loadErr.message}`);
        return result;
    }

    const FOUR_OUTCOMES = [
        "three_way_matched",
        "three_way_variance",
        "three_way_exception",
        "three_way_incomplete",
    ];

    // Idempotency set: invoice_ids that already carry a three_way_* outcome.
    // Loaded once (not per-invoice) so the backlog drains instead of stalling.
    const processedSet = new Set<string>();
    if (!dryRun) {
        const { data: processed } = await db
            .from("reconciliation_outcomes")
            .select("invoice_id")
            .in("outcome", FOUR_OUTCOMES)
            .not("invoice_id", "is", null)
            .limit(5000);
        for (const r of (processed ?? []) as any[]) {
            if (r.invoice_id) processedSet.add(String(r.invoice_id));
        }
    }

    const toProcess = ((invoices ?? []) as any[]).filter((inv) => {
        if (!String(inv.po_number ?? "").trim()) return false;
        if (!dryRun && processedSet.has(String(inv.id))) {
            result.skippedExisting++;
            return false;
        }
        return true;
    }).slice(0, limit);

    for (const inv of toProcess) {
        const orderId = String(inv.po_number ?? "").trim();

        try {
            const [poRes, receiptRes] = await Promise.all([
                db
                    .from("purchase_orders")
                    .select("line_items, total")
                    .eq("po_number", orderId)
                    .maybeSingle(),
                db
                    .from("po_receipt_data")
                    .select("total_received, fully_received, line_items")
                    .eq("po_number", orderId)
                    .maybeSingle(),
            ]);

            const poData = (poRes as any)?.data;
            const receiptData = (receiptRes as any)?.data;

            const poLines: GatePoLine[] = ((poData?.line_items ?? []) as any[]).map(
                (pi: any) => ({
                    productId: pi.productId ?? pi.sku ?? pi.description ?? "UNKNOWN",
                    description: pi.description,
                    quantity: Number(pi.quantity ?? 0),
                    unitPrice: Number(pi.unitPrice ?? 0),
                    receivedQty: pi.receivedQty ?? null,
                }),
            );

            const invoiceLines = extractInvoiceLines(inv);

            // Per-SKU received quantities from the receipt leg line_items.
            const receivedQtys: Record<string, number> = {};
            for (const rl of ((receiptData?.line_items ?? []) as any[])) {
                if (rl.sku != null) receivedQtys[String(rl.sku)] = Number(rl.received ?? 0);
            }

            // Concrete receipt evidence — only a past receipt with qty counts.
            const hasReceipt =
                !!receiptData &&
                (Number(receiptData.total_received) > 0 || receiptData.fully_received === true);

            // Pack multipliers for UOM normalization (case → each).
            const allSkus = [
                ...new Set([
                    ...poLines.map((l) => l.productId),
                    ...invoiceLines.map((l) => l.sku),
                ]),
            ].filter(Boolean) as string[];
            const packMultipliers: Record<string, number> = {};
            if (allSkus.length > 0) {
                try {
                    const sizes = await getPackSizes(allSkus);
                    for (const [sku, rec] of sizes) {
                        if (rec.unitsPerPack > 1) packMultipliers[sku] = rec.unitsPerPack;
                    }
                } catch {
                    // pack sizes are optional — proceed without them
                }
            }

            const ev = evaluateInvoiceThreeWay({
                orderId,
                poLines,
                invoiceLines,
                hasReceipt,
                hasInvoice: true,
                receivedQtys,
                packMultipliers,
                invoiceTotal: Number(inv.total ?? 0),
                poTotal: Number(poData?.total ?? 0),
            });

            result.processed++;
            if (ev.verdict === "matched") result.matched++;
            else if (ev.verdict === "variance") result.variance++;
            else if (ev.verdict === "exception") result.exception++;
            else result.incomplete++;

            const outcome = mapVerdictToOutcome(ev.verdict);
            if (!dryRun) {
                await writeReconciliationOutcome({
                    runId: crypto.randomUUID(),
                    outcome,
                    invoiceId: inv.id,
                    poId: orderId,
                    vendorName: inv.vendor_name,
                    outcomeMeta: {
                        verdict: ev.verdict,
                        missing_legs: ev.missingLegs,
                        total_dollar_impact: ev.totalDollarImpact,
                        summary: ev.summary,
                        invoice_number: inv.invoice_number,
                        source: "three-way-match-runner",
                    },
                    resolvedAt: new Date(),
                });
            }

            // Clean matches become confirmed vendor→PO mappings the matcher
            // learns from. Unique constraint makes this idempotent. Garbage
            // vendor names are excluded so OCR noise can't seed the loop.
            if (!dryRun && ev.verdict === "matched" && !isGarbageVendorName(inv.vendor_name)) {
                const { error: cErr } = await db.from("confirmed_po_matches").upsert(
                    {
                        vendor_name: inv.vendor_name,
                        po_number: orderId,
                        invoice_id: inv.id,
                        invoice_number: inv.invoice_number,
                        confirmed_by: "three-way-match",
                    },
                    { onConflict: "vendor_name,po_number" },
                );
                if (cErr && !/duplicate|unique/i.test(cErr.message ?? "")) {
                    result.details.push(`${orderId}: confirmed write err ${cErr.message}`);
                } else if (!cErr) {
                    result.confirmed++;
                }
            }

            result.details.push(`${orderId}: ${ev.verdict} — ${ev.summary}`);
        } catch (err: unknown) {
            result.errors++;
            const msg = err instanceof Error ? err.message : String(err);
            result.details.push(`${orderId}: error ${msg}`);
        }
    }

    return result;
}
