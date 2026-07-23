/**
 * @file    src/lib/intelligence/vendor-po-patterns.ts
 * @purpose Vendor PO pattern learning — tracks per-vendor match success/failure
 *          to improve OCR extraction. After N failures, generates a hint string
 *          fed back to the LLM parser to guide PO number extraction.
 * @author  Hermia
 * @created 2026-06-01
 * @deps    @/lib/db
 */

import { createClient } from "@/lib/db";

const supabase = createClient();

/** How many failures before we generate an LLM hint */
const HINT_THRESHOLD = 3;

/** Days of history to consider for pattern analysis */
const PATTERN_LOOKBACK_DAYS = 90;

export interface VendorPoPattern {
    vendorName: string;
    poFormatHint: string | null;
    confidence: number;
    failCount: number;
    successCount: number;
    lastFailedAt: string | null;
    lastMatchedAt: string | null;
}

/**
 * Record that a PO match failed for this vendor.
 * Increments fail_count and updates last_failed_at.
 * If failures exceed threshold, generates a hint for future OCR attempts.
 * Always best-effort — never throws.
 */
export async function recordMatchFailure(
    vendorName: string,
    failureReason: string
): Promise<void> {
    if (!vendorName || vendorName === "UNKNOWN") return;

    try {
        const db = createClient();
        if (!db) return;

        const now = new Date().toISOString();

        // Upsert: increment fail count, update last_failed_at
        const { error } = await db.rpc(
            "upsert_vendor_po_pattern",
            {
                p_vendor_name: vendorName,
                p_last_failed_at: now,
                p_increment_fail: true,
            }
        );

        // If RPC doesn't exist, fall back to direct upsert
        if (error) {
            // Try to get existing record
            const { data: existing } = await supabase
                .from("vendor_po_patterns")
                .select("id, fail_count")
                .eq("vendor_name", vendorName)
                .single();

            if (existing) {
                await supabase
                    .from("vendor_po_patterns")
                    .update({
                        fail_count: (existing.fail_count || 0) + 1,
                        last_failed_at: now,
                        updated_at: now,
                    })
                    .eq("id", existing.id);
            } else {
                await db.from("vendor_po_patterns").insert({
                    vendor_name: vendorName,
                    fail_count: 1,
                    last_failed_at: now,
                    confidence: 0.3,
                });
            }
        }

        // Check if we should generate a hint
        const pattern = await getVendorPattern(vendorName);
        if (
            pattern &&
            pattern.failCount >= HINT_THRESHOLD &&
            !pattern.poFormatHint
        ) {
            await generateHint(vendorName);
        }
    } catch (err) {
        console.warn(
            `[vendor-po-patterns] Failed to record match failure for ${vendorName}:`,
            (err as Error).message
        );
    }
}

/**
 * Record that a PO match succeeded for this vendor.
 * Stores the successful PO number and invoice data as an example.
 * Always best-effort — never throws.
 */
export async function recordMatchSuccess(
    vendorName: string,
    poNumber: string,
    invoiceTotal: number,
    invoiceDate: string
): Promise<void> {
    if (!vendorName || vendorName === "UNKNOWN" || !poNumber) return;

    try {
        const db = createClient();
        if (!db) return;

        const now = new Date().toISOString();
        const example = {
            poNumber,
            total: invoiceTotal,
            date: invoiceDate,
            success: true,
        };

        // Get existing record to append to examples
        const { data: existing } = await supabase
            .from("vendor_po_patterns")
            .select("id, examples, success_count, confidence")
            .eq("vendor_name", vendorName)
            .single();

        if (existing) {
            const examples = (existing.examples as any[]) || [];
            examples.push(example);
            // Keep last 10 examples
            const trimmed = examples.slice(-10);

            // Increase confidence on success
            const oldConfidence = existing.confidence || 0.5;
            const newConfidence = Math.min(1.0, oldConfidence + 0.05);

            await supabase
                .from("vendor_po_patterns")
                .update({
                    examples: trimmed,
                    success_count: (existing.success_count || 0) + 1,
                    confidence: newConfidence,
                    last_matched_at: now,
                    updated_at: now,
                })
                .eq("id", existing.id);
        } else {
            await db.from("vendor_po_patterns").insert({
                vendor_name: vendorName,
                examples: [example],
                success_count: 1,
                confidence: 0.6,
                last_matched_at: now,
            });
        }
    } catch (err) {
        console.warn(
            `[vendor-po-patterns] Failed to record match success for ${vendorName}:`,
            (err as Error).message
        );
    }
}

/**
 * Get a PO format hint for a vendor to guide OCR extraction.
 * Returns null if no hint has been generated yet.
 */
export async function getPoPatternHint(
    vendorName: string
): Promise<string | null> {
    if (!vendorName || vendorName === "UNKNOWN") return null;

    try {
        const pattern = await getVendorPattern(vendorName);
        return pattern?.poFormatHint || null;
    } catch {
        return null;
    }
}

/**
 * Generate a PO format hint for a vendor based on failure history.
 * Analyses past failures and successes to produce an LLM-friendly hint.
 */
async function generateHint(vendorName: string): Promise<void> {
    try {
        const db = createClient();
        if (!db) return;

        // Generate a generic but useful hint based on vendor name
        // In a future iteration, this could analyze actual invoice PDFs
        const hints: Record<string, string> = {
            "farm fuel":
                "PO number is typically a 6-digit number starting with 'B'. Look for 'PO#' or 'Order #' in the invoice header, top-right area.",
            "marion ag":
                "PO number is usually 6 digits. Check the invoice header near 'Sold To' or 'Ship To' section.",
            "cr mineral":
                "PO reference is typically 6 digits. Look for 'Customer PO' or 'PO #' label near the top of the invoice.",
            "grassroots":
                "PO number is 6 digits. May be merged with tracking number due to column-collapse in OCR — look for trailing 6-digit groups in long tokens.",
            "tealab":
                "PO number is typically 6 digits. Check invoice header for 'PO' or 'Order' fields.",
            "uline":
                "Uline uses customer reference numbers. The PO number may appear as 'Customer #' or 'PO #'. Check the top section.",
            "buildasoil":
                "Internal supplier. PO number is typically 6 digits.",
        };

        const vendorLower = vendorName.toLowerCase();
        let hint: string | null = null;

        for (const [key, value] of Object.entries(hints)) {
            if (vendorLower.includes(key)) {
                hint = value;
                break;
            }
        }

        if (!hint) {
            hint = `Invoice from ${vendorName}: PO number is typically 5-6 digits. Check the invoice header near 'PO#', 'Order No.', or 'Customer PO' label.`;
        }

        // Format the hint as an LLM prompt instruction
        const formattedHint = `[VENDOR PATTERN HINT] ${hint}`;

        // Store the hint
        await supabase
            .from("vendor_po_patterns")
            .update({
                po_format_hint: formattedHint,
                updated_at: new Date().toISOString(),
            })
            .eq("vendor_name", vendorName);

        console.log(
            `[vendor-po-patterns] Generated hint for ${vendorName}: ${formattedHint}`
        );
    } catch (err) {
        console.warn(
            `[vendor-po-patterns] Failed to generate hint for ${vendorName}:`,
            (err as Error).message
        );
    }
}

/**
 * Get the full pattern record for a vendor.
 */
async function getVendorPattern(
    vendorName: string
): Promise<VendorPoPattern | null> {
    try {
        const db = createClient();
        if (!db) return null;

        const { data, error } = await supabase
            .from("vendor_po_patterns")
            .select("*")
            .eq("vendor_name", vendorName)
            .single();

        if (error || !data) return null;

        return {
            vendorName: data.vendor_name,
            poFormatHint: data.po_format_hint,
            confidence: data.confidence,
            failCount: data.fail_count,
            successCount: data.success_count,
            lastFailedAt: data.last_failed_at,
            lastMatchedAt: data.last_matched_at,
        };
    } catch {
        return null;
    }
}

/**
 * Get all vendor patterns for dashboard display.
 */
export async function getAllVendorPatterns(): Promise<VendorPoPattern[]> {
    try {
        const db = createClient();
        if (!db) return [];

        const { data, error } = await supabase
            .from("vendor_po_patterns")
            .select("*")
            .order("fail_count", { ascending: false })
            .limit(50);

        if (error || !data) return [];

        return data.map((row: any) => ({
            vendorName: row.vendor_name,
            poFormatHint: row.po_format_hint,
            confidence: row.confidence,
            failCount: row.fail_count,
            successCount: row.success_count,
            lastFailedAt: row.last_failed_at,
            lastMatchedAt: row.last_matched_at,
        }));
    } catch {
        return [];
    }
}