/**
 * @file    src/lib/purchasing/auto-match-unmatched.ts
 * @purpose Batch auto-match runner for unmatched invoices on the dashboard.
 *          Loads unmatched invoices from the `invoices` table, joins OCR
 *          candidates from `vendor_invoices.raw_data`, and calls the sibling
 *          `findPOCandidates` from invoice-po-matcher. When a single high-
 *          confidence match is found (autoApplyReady), assigns po_number and
 *          transitions status to matched_unreconciled.
 *
 * Flow:
 *   1. loadUnmatchedInvoicesForAutoMatch() — queries invoices with no PO
 *   2. For each: build InvoiceToMatch → call findPOCandidates
 *   3. If autoApplyReady && bestMatch: assign PO + optional vendor_invoices sync
 *   4. Return structured report
 *
 * IDEMPOTENT: invoices already having po_number are skipped.
 * SAFE: never assigns when bestMatch is null or autoApplyReady is false.
 *
 * @author  Hermia
 * @deps    @/lib/db, invoice-po-matcher (findPOCandidates)
 * @created 2026-07-27
 */

import { createClient } from "@/lib/db";
import { findPOCandidates, type InvoiceToMatch, type MatchResult } from "@/lib/purchasing/invoice-po-matcher";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AutoMatchedInvoice {
    invoiceId: string;
    poNumber: string;
    score: number;
    reason: string;
}

export interface AutoMatchResult {
    examined: number;
    autoApplied: AutoMatchedInvoice[];
    skipped: AutoMatchedInvoice[];
    errors: number;
}

export interface AutoMatchSummary {
    result: AutoMatchResult;
    durationMs: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 100;

// ── Load unmatched invoices ────────────────────────────────────────────────

/**
 * Load unmatched invoices from the `invoices` table.
 *
 * "Unmatched" means: no_po_required is not true AND (po_number is null/empty
 * OR the invoice status is 'unmatched').  We also capture OCR PO candidate
 * hints from the corresponding vendor_invoices.raw_data.
 *
 * Returns rows enriched with ocrPoCandidate / ocrOrderCandidate from the
 * vendor_invoices join, ready for findPOCandidates.
 */
export async function loadUnmatchedInvoicesForAutoMatch(
    batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<InvoiceToMatchWithOCR[]> {
    const db = createClient();
    if (!db) return [];

    // Fetch invoices where po_number is missing or empty, and
    // no_po_required is not explicitly true.
    const { data: invoices, error } = await db
        .from("invoices")
        .select("id, invoice_number, vendor_name, total, subtotal, freight, tax, invoice_date, created_at, po_number, no_po_required, status")
        .or("po_number.is.null,po_number.eq.,status.eq.unmatched")
        .or("no_po_required.is.null,no_po_required.eq.false")
        .order("created_at", { ascending: false })
        .limit(batchSize);

    if (error || !invoices || invoices.length === 0) {
        return [];
    }

    const rows = invoices as any[];

    // ── Batch lookup vendor_invoices for OCR candidates ──────────────────
    // Join by vendor_name + invoice_number to get vendor_invoices raw_data
    // which may contain OCR-extracted poNumber / orderNumber hints.
    const vendorNamesInSet = [...new Set(rows.map((r: any) => r.vendor_name).filter(Boolean))] as string[];
    const viMap = new Map<string, Record<string, unknown>>();

    if (vendorNamesInSet.length > 0) {
        const { data: viRows } = await db
            .from("vendor_invoices")
            .select("vendor_name, invoice_number, raw_data")
            .in("vendor_name", vendorNamesInSet);

        for (const vi of (viRows ?? []) as any[]) {
            const key = (vi.vendor_name ?? "") + "|" + (vi.invoice_number ?? "");
            if (!viMap.has(key) && vi.raw_data) {
                viMap.set(key, vi.raw_data as Record<string, unknown>);
            }
        }
    }

    // ── Build enriched invoice objects ───────────────────────────────────
    const enriched: InvoiceToMatchWithOCR[] = [];

    for (const inv of rows) {
        // Skip if already has a PO (belt-and-suspenders idempotency)
        if (inv.po_number && String(inv.po_number).trim().length > 0) continue;
        // Skip no_po_required
        if (inv.no_po_required === true) continue;

        const key = (inv.vendor_name ?? "") + "|" + (inv.invoice_number ?? "");
        const rawData = viMap.get(key);

        // Extract OCR PO candidates from raw_data
        let ocrPoCandidate: string | null = null;
        let ocrOrderCandidate: string | null = null;
        if (rawData) {
            const pn = rawData.poNumber as string | undefined;
            if (pn) ocrPoCandidate = String(pn);
            const on = rawData.orderNumber as string | undefined;
            if (on) ocrOrderCandidate = String(on);
        }

        enriched.push({
            id: String(inv.id),
            invoiceNumber: String(inv.invoice_number ?? ""),
            vendorName: String(inv.vendor_name ?? ""),
            invoiceDate: String(inv.invoice_date ?? ""),
            subtotal: Number(inv.subtotal ?? 0),
            freight: Number(inv.freight ?? 0),
            tax: Number(inv.tax ?? 0),
            total: Number(inv.total ?? 0),
            ocrPoCandidate,
            ocrOrderCandidate,
        });
    }

    return enriched;
}

// ── Extended type ───────────────────────────────────────────────────────────

export interface InvoiceToMatchWithOCR extends InvoiceToMatch {
    ocrPoCandidate?: string | null;
    ocrOrderCandidate?: string | null;
}

// ── Main runner ─────────────────────────────────────────────────────────────

/**
 * Run batch auto-match on unmatched invoices.
 *
 * For each unmatched invoice:
 *   1. Call findPOCandidates (from sibling invoice-po-matcher)
 *   2. If autoApplyReady && bestMatch: assign po_number to invoices table
 *      (and vendor_invoices if a matching row exists), set status to
 *      matched_unreconciled, record the reason.
 *   3. Otherwise: skip with a note.
 *
 * @param batchSize  Max invoices to examine per call (default 100).
 * @returns         AutoMatchResult with examined/autoApplied/skipped counts.
 */
export async function runAutoMatchUnmatched(
    batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<AutoMatchResult> {
    const result: AutoMatchResult = {
        examined: 0,
        autoApplied: [],
        skipped: [],
        errors: 0,
    };

    const invoices = await loadUnmatchedInvoicesForAutoMatch(batchSize);
    result.examined = invoices.length;

    if (invoices.length === 0) return result;

    const db = createClient();
    if (!db) return result;

    for (const invoice of invoices) {
        try {
            // Skip if invoice has missing vendor name or invoice number —
            // can't meaningfully match without these.
            if (!invoice.vendorName || !invoice.invoiceNumber) {
                result.skipped.push({
                    invoiceId: invoice.id,
                    poNumber: "",
                    score: 0,
                    reason: "missing vendor name or invoice number",
                });
                continue;
            }

            // IDEMPOTENCY: double-check po_number hasn't been set since load
            const { data: fresh } = await db
                .from("invoices")
                .select("po_number")
                .eq("id", invoice.id)
                .single();

            if (fresh && (fresh as any).po_number && String((fresh as any).po_number).trim().length > 0) {
                result.skipped.push({
                    invoiceId: invoice.id,
                    poNumber: String((fresh as any).po_number),
                    score: 0,
                    reason: "already has po_number (idempotent skip)",
                });
                continue;
            }

            const matchResult: MatchResult = await findPOCandidates(invoice);
            let poToAssign: string | null = null;
            let reason = "";

            if (matchResult.autoApplyReady && matchResult.bestMatch) {
                poToAssign = matchResult.bestMatch.orderId;
                reason = `auto-match: score=${matchResult.bestMatch.score} (${matchResult.bestMatch.reasons.join(", ")})`;
            } else if (matchResult.candidates.length > 0 && matchResult.bestMatch) {
                // Not auto-apply ready — skip with info
                result.skipped.push({
                    invoiceId: invoice.id,
                    poNumber: matchResult.bestMatch.orderId,
                    score: matchResult.bestMatch.score,
                    reason: `low confidence: score=${matchResult.bestMatch.score} (${matchResult.bestMatch.reasons.join(", ")})`,
                });
                continue;
            } else {
                result.skipped.push({
                    invoiceId: invoice.id,
                    poNumber: "",
                    score: 0,
                    reason: "no PO candidates found",
                });
                continue;
            }

            // Belt-and-suspenders: never write a dropship PO (out of AP purview)
            if (poToAssign && /DropshipPO$/i.test(poToAssign)) {
                result.skipped.push({
                    invoiceId: invoice.id,
                    poNumber: poToAssign,
                    score: matchResult.bestMatch?.score || 0,
                    reason: "blocked: dropship PO out of AP purview",
                });
                continue;
            }

            // ── Apply the match ───────────────────────────────────────────
            // Always assign po_number. `invoices` is now a read-only VIEW over
            // vendor_invoices (20260812_invoice_consolidation) — write the
            // source table directly; the view carries the same id.
            await db
                .from("vendor_invoices")
                .update({
                    po_number: poToAssign,
                    status: "matched_unreconciled",
                })
                .eq("id", invoice.id);

            // Also assign to vendor_invoices if a matching row exists
            try {
                await db
                    .from("vendor_invoices")
                    .update({
                        po_number: poToAssign,
                    })
                    .eq("vendor_name", invoice.vendorName)
                    .eq("invoice_number", invoice.invoiceNumber);
            } catch {
                // Non-blocking — vendor_invoices may not have a row for every invoice
            }

            // Write to activity log so the queue knows this was auto-matched
            try {
                await db.from("ap_activity_log").insert({
                    email_from: invoice.vendorName,
                    email_subject: `Auto-matched: Invoice ${invoice.invoiceNumber} → PO ${poToAssign}`,
                    intent: "RECONCILIATION",
                    action_taken: `Auto-matched to PO ${poToAssign} (score ${matchResult.bestMatch!.score})`,
                    reviewed_at: null,
                    reviewed_action: null,
                    metadata: {
                        invoiceNumber: invoice.invoiceNumber,
                        vendorName: invoice.vendorName,
                        orderId: poToAssign,
                        score: matchResult.bestMatch!.score,
                        reasons: matchResult.bestMatch!.reasons,
                        source: "auto_match_unmatched",
                    },
                });
            } catch {
                // Non-blocking — activity log is best-effort
            }

            result.autoApplied.push({
                invoiceId: invoice.id,
                poNumber: poToAssign,
                score: matchResult.bestMatch!.score,
                reason,
            });
        } catch (err: any) {
            result.errors++;
            console.error(`[auto-match] Error processing invoice ${invoice.id}: ${err.message}`);
            result.skipped.push({
                invoiceId: invoice.id,
                poNumber: "",
                score: 0,
                reason: `error: ${err.message}`,
            });
        }
    }

    return result;
}

/**
 * Validate that a PO number exists in the purchase_orders table.
 * Used by apply_po_candidate to ensure the target PO is real.
 */
export async function validatePOExists(poNumber: string): Promise<boolean> {
    const db = createClient();
    if (!db) return false;
    const { data, error } = await db
        .from("purchase_orders")
        .select("po_number")
        .eq("po_number", poNumber)
        .single();
    return !error && !!data;
}

/**
 * Apply a specific PO candidate to an invoice (one-click from UI chips).
 *
 * Validates:
 *   - PO exists in purchase_orders
 *   - Invoice exists and doesn't already have a PO
 * - Sets po_number, status = 'matched_unreconciled'
 * - Writes confirmed_po_matches upsert (learning)
 * - Writes ap_activity_log stub
 *
 * @returns success boolean + message
 */
export async function applyPOCandidate(
    invoiceId: string,
    poNumber: string,
    markedBy?: string,
): Promise<{ success: boolean; message: string }> {
    const db = createClient();
    if (!db) {
        return { success: false, message: "Database not configured" };
    }

    // Validate PO exists
    const poExists = await validatePOExists(poNumber);
    if (!poExists) {
        return { success: false, message: `PO ${poNumber} not found in purchase_orders` };
    }

    // Fetch the invoice
    const { data: invoice, error: fetchError } = await db
        .from("invoices")
        .select("id, invoice_number, vendor_name, po_number, status")
        .eq("id", invoiceId)
        .single();

    if (fetchError || !invoice) {
        return { success: false, message: "Invoice not found" };
    }

    const inv = invoice as any;

    // Idempotency: if already has this PO, still say success
    if (inv.po_number && String(inv.po_number).trim() === poNumber.trim()) {
        return { success: true, message: `Invoice already matched to PO ${poNumber}` };
    }

    // If already has a DIFFERENT PO, block (don't silently overwrite)
    if (inv.po_number && String(inv.po_number).trim().length > 0) {
        return {
            success: false,
            message: `Invoice already has PO ${inv.po_number}. Use rematch if needed.`,
        };
    }

    const now = new Date().toISOString();

    // Update invoice record — `invoices` is now a read-only VIEW over
    // vendor_invoices (20260812_invoice_consolidation); the view's id IS the
    // vendor_invoices id, so write the source table.
    await db
        .from("vendor_invoices")
        .update({
            po_number: poNumber.trim(),
            status: "matched_unreconciled",
        })
        .eq("id", invoiceId);

    // Sync to vendor_invoices
    try {
        await db
            .from("vendor_invoices")
            .update({ po_number: poNumber.trim() })
            .eq("vendor_name", inv.vendor_name)
            .eq("invoice_number", inv.invoice_number);
    } catch {
        // Non-blocking
    }

    // Write confirmed_po_matches (learning)
    try {
        await db.from("confirmed_po_matches").upsert({
            vendor_name: inv.vendor_name || "Unknown",
            po_number: poNumber.trim(),
            invoice_id: invoiceId,
            invoice_number: inv.invoice_number || "",
            confirmed_by: markedBy || "dashboard",
            confirmed_at: now,
        }, { onConflict: "vendor_name, po_number", ignoreDuplicates: false });
    } catch {
        // Non-blocking
    }

    // Write activity log
    try {
        await db.from("ap_activity_log").insert({
            email_from: inv.vendor_name || "Unknown",
            email_subject: `Apply PO candidate: Invoice ${inv.invoice_number || ''} → PO ${poNumber.trim()}`,
            intent: "RECONCILIATION",
            action_taken: "PO candidate applied by user (dashboard chip)",
            reviewed_at: now,
            reviewed_action: "approved",
            metadata: {
                invoiceNumber: inv.invoice_number || "",
                vendorName: inv.vendor_name || "",
                orderId: poNumber.trim(),
                source: "dashboard_apply_po_candidate",
                markedBy: markedBy || "dashboard",
            },
        });
    } catch {
        // Non-blocking
    }

    return {
        success: true,
        message: `✅ PO ${poNumber.trim()} applied to ${inv.vendor_name || 'vendor'} (invoice ${inv.invoice_number || ''}).`,
    };
}

/**
 * Approve matched_unreconciled invoices whose total is within 2% of PO total.
 *
 * For each matched_unreconciled invoice:
 *   1. Look up purchase_orders.total_amount for the assigned PO
 *   2. If |invoice.total - poTotal| / poTotal <= 0.02, auto-approve
 *   3. Write confirmed_po_matches + ap_activity_log
 *
 * @returns Count of auto-approved + any errors
 */
export async function approveCloseMatchUnreconciled(): Promise<{
    approved: number;
    errors: number;
}> {
    const db = createClient();
    if (!db) return { approved: 0, errors: 0 };

    const { data: matchedUnreconciled, error } = await db
        .from("invoices")
        .select("id, invoice_number, vendor_name, total, po_number")
        .eq("status", "matched_unreconciled")
        .not("po_number", "is", null);

    if (error || !matchedUnreconciled || matchedUnreconciled.length === 0) {
        return { approved: 0, errors: 0 };
    }

    const rows = matchedUnreconciled as any[];
    let approved = 0;
    let errors = 0;

    // Batch fetch all PO totals
    const poNumbers = [...new Set(rows.map((r: any) => r.po_number).filter(Boolean))] as string[];
    const poTotalMap = new Map<string, number>();

    if (poNumbers.length > 0) {
        const { data: pos } = await db
            .from("purchase_orders")
            .select("po_number, total_amount, total")
            .in("po_number", poNumbers);

        for (const po of (pos ?? []) as any[]) {
            const tot = Number(po.total_amount || po.total || 0);
            poTotalMap.set(po.po_number, tot);
        }
    }

    const now = new Date().toISOString();

    for (const inv of rows) {
        try {
            const poTotal = poTotalMap.get(inv.po_number);
            if (poTotal === undefined || poTotal <= 0) {
                errors++;
                continue;
            }

            const invTotal = Number(inv.total || 0);
            const variance = Math.abs(invTotal - poTotal) / poTotal;

            if (variance <= 0.02) {
                // Within 2% — auto-approve
                // (`invoices` is now a read-only VIEW over vendor_invoices)
                await db
                    .from("vendor_invoices")
                    .update({
                        status: "auto_approved",
                    })
                    .eq("id", inv.id);

                // Write confirmed_po_matches
                try {
                    await db.from("confirmed_po_matches").upsert({
                        vendor_name: inv.vendor_name || "Unknown",
                        po_number: inv.po_number,
                        invoice_id: inv.id,
                        invoice_number: inv.invoice_number || "",
                        confirmed_by: "system",
                        confirmed_at: now,
                    }, { onConflict: "vendor_name, po_number", ignoreDuplicates: false });
                } catch {
                    // Non-blocking
                }

                // Write activity log
                try {
                    await db.from("ap_activity_log").insert({
                        email_from: inv.vendor_name || "Unknown",
                        email_subject: `Auto-approved close match: Invoice ${inv.invoice_number || ''} → PO ${inv.po_number}`,
                        intent: "RECONCILIATION",
                        action_taken: `Auto-approved: ${(variance * 100).toFixed(1)}% variance from PO total ($${poTotal})`,
                        reviewed_at: now,
                        reviewed_action: "approved",
                        metadata: {
                            invoiceNumber: inv.invoice_number || "",
                            vendorName: inv.vendor_name || "",
                            orderId: inv.po_number,
                            invoiceTotal: invTotal,
                            poTotal,
                            variance: variance,
                            source: "auto_approve_close_match",
                        },
                    });
                } catch {
                    // Non-blocking
                }

                approved++;
            }
        } catch {
            errors++;
        }
    }

    return { approved, errors };
}
