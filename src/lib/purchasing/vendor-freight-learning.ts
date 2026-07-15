/**
 * @file    vendor-freight-learning.ts
 * @purpose Learning layer on top of vendor-freight-pattern.ts. Tracks every
 *          completed PO's freight handling, auto-classifies vendors once
 *          enough data accumulates, and supports manual marking from the
 *          dashboard. Feeds po-auto-complete eligibility.
 *
 *          Flow:
 *            1. PO is completed (manual or auto) → recordFreightEvidence()
 *            2. After enough samples → classifyFreightPatternFromHistory()
 *            3. Dashboard can also markFreightPattern() directly
 *            4. po-auto-complete reads vendor_profiles.freight_pattern
 *
 * @author  Hermia
 * @created 2026-07-14
 */

import { createClient } from "../db";
import {
    classifyVendorFreightPattern,
    VENDOR_PATTERN_OVERRIDES,
    type PatternEvidence,
    type VendorFreightPatternResult,
    type FreightPattern,
} from "./vendor-freight-pattern";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FreightEvidenceRecord {
    orderId: string;
    vendorName: string;
    hadFreightOnPO: boolean;
    invoiceFreight: number;
    freightMatched: boolean;
    completedBy: 'manual' | 'auto' | 'dashboard';
}

export interface FreightLearningResult {
    pattern: FreightPattern;
    confidence: 'high' | 'medium' | 'low';
    sampleCount: number;
    source: 'override' | 'learned' | 'manual' | 'insufficient';
    /** True when the system has enough confidence to auto-complete this vendor's POs. */
    autonomousReady: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Minimum samples before the classifier will auto-classify. */
const MIN_SAMPLES_FOR_CLASSIFICATION = 5;
/** Samples needed for high confidence. */
const HIGH_CONFIDENCE_SAMPLES = 12;
/** Dominance threshold for a clear pattern. */
const DOMINANCE_THRESHOLD = 0.75;

// ── Record evidence ────────────────────────────────────────────────────────

/**
 * Record freight evidence when a PO is completed. Idempotent per orderId.
 * After recording, checks if the vendor now has enough samples to auto-classify.
 */
export async function recordFreightEvidence(record: FreightEvidenceRecord): Promise<void> {
    const sb = createClient();
    if (!sb) return;

    // Upsert — one row per orderId
    await sb
        .from('po_freight_evidence')
        .upsert({
            order_id: record.orderId,
            vendor_name: record.vendorName,
            had_freight_on_po: record.hadFreightOnPO,
            invoice_freight: record.invoiceFreight,
            freight_matched: record.freightMatched,
            completed_by: record.completedBy,
        }, { onConflict: 'order_id' });

    // Check if we should re-classify
    await maybeReclassifyVendor(record.vendorName);
}

// ── Load evidence for a vendor ─────────────────────────────────────────────

async function loadEvidenceForVendor(vendorName: string): Promise<PatternEvidence[]> {
    const sb = createClient();
    if (!sb) return [];

    const { data } = await sb
        .from('po_freight_evidence')
        .select('order_id, had_freight_on_po, invoice_freight, freight_matched')
        .eq('vendor_name', vendorName)
        .order('completed_at', { ascending: false })
        .limit(50);

    return (data || []).map((row: any) => ({
        poId: row.order_id,
        hadFreightOnPO: row.had_freight_on_po,
        invoiceFreight: Number(row.invoice_freight || 0),
        matched: row.freight_matched,
    }));
}

// ── Auto-classify from history ─────────────────────────────────────────────

/**
 * Check if a vendor has enough evidence to auto-classify, and if so,
 * write the classification to vendor_profiles.
 */
async function maybeReclassifyVendor(vendorName: string): Promise<void> {
    const sb = createClient();
    if (!sb) return;

    // Don't override explicit manual markings
    const { data: profile } = await sb
        .from('vendor_profiles')
        .select('freight_pattern_source, freight_sample_count')
        .eq('vendor_name', vendorName)
        .maybeSingle();

    if (profile?.freight_pattern_source === 'manual' || profile?.freight_pattern_source === 'override') {
        return; // Manual/override takes priority — don't overwrite
    }

    const evidence = await loadEvidenceForVendor(vendorName);
    if (evidence.length < MIN_SAMPLES_FOR_CLASSIFICATION) return;

    const result = classifyVendorFreightPattern(vendorName, evidence);

    // Only write if we got a non-override result with enough confidence
    if (result.source === 'override') return; // Override already in overrides list

    const confidence: 'high' | 'medium' | 'low' =
        evidence.length >= HIGH_CONFIDENCE_SAMPLES && result.dominance >= DOMINANCE_THRESHOLD
            ? 'high'
            : evidence.length >= 8
                ? 'medium'
                : 'low';

    await sb
        .from('vendor_profiles')
        .upsert({
            vendor_name: vendorName,
            freight_pattern: result.pattern,
            freight_pattern_confidence: confidence,
            freight_pattern_source: 'learned',
            freight_sample_count: evidence.length,
            freight_learned_at: new Date().toISOString(),
        }, { onConflict: 'vendor_name' });
}

// ── Manual marking ─────────────────────────────────────────────────────────

/**
 * Dashboard marks a vendor's freight pattern explicitly. Overrides any
 * learned classification. Use this when you know a vendor's pattern.
 */
export async function markVendorFreightPattern(
    vendorName: string,
    pattern: FreightPattern,
): Promise<void> {
    const sb = createClient();
    if (!sb) return;

    await sb
        .from('vendor_profiles')
        .upsert({
            vendor_name: vendorName,
            freight_pattern: pattern,
            freight_pattern_confidence: 'high',
            freight_pattern_source: 'manual',
            freight_learned_at: new Date().toISOString(),
        }, { onConflict: 'vendor_name' });

    console.log(`[freight-learning] ${vendorName} manually marked as ${pattern}`);
}

// ── Read current classification ────────────────────────────────────────────

/**
 * Get the current freight classification for a vendor. Checks in order:
 *   1. Hardcoded override (vendor-freight-pattern.ts)
 *   2. Manual marking from vendor_profiles
 *   3. Learned classification from vendor_profiles
 *   4. Falls back to classify from evidence (if any) or 'insufficient_data'
 */
export async function getVendorFreightClassification(
    vendorName: string,
): Promise<FreightLearningResult> {
    // 1. Check hardcoded overrides
    const override = VENDOR_PATTERN_OVERRIDES.find(o =>
        vendorName.toLowerCase().includes(o.match),
    );
    if (override) {
        return {
            pattern: override.pattern,
            confidence: 'high',
            sampleCount: 0,
            source: 'override',
            autonomousReady: true,
        };
    }

    // 2. Check vendor_profiles
    const sb = createClient();
    if (sb) {
        const { data } = await sb
            .from('vendor_profiles')
            .select('freight_pattern, freight_pattern_confidence, freight_pattern_source, freight_sample_count')
            .eq('vendor_name', vendorName)
            .maybeSingle();

        if (data?.freight_pattern && data.freight_pattern_source !== 'insufficient') {
            return {
                pattern: data.freight_pattern as FreightPattern,
                confidence: (data.freight_pattern_confidence as 'high' | 'medium' | 'low') || 'medium',
                sampleCount: data.freight_sample_count || 0,
                source: (data.freight_pattern_source as 'learned' | 'manual') || 'learned',
                autonomousReady:
                    data.freight_pattern === 'no_freight' &&
                    data.freight_pattern_confidence === 'high',
            };
        }
    }

    // 3. Try to classify from evidence
    const evidence = await loadEvidenceForVendor(vendorName);
    if (evidence.length >= MIN_SAMPLES_FOR_CLASSIFICATION) {
        const result = classifyVendorFreightPattern(vendorName, evidence);
        return {
            pattern: result.pattern,
            confidence: result.confidence,
            sampleCount: evidence.length,
            source: 'learned',
            autonomousReady: result.pattern === 'no_freight' && result.confidence === 'high',
        };
    }

    // 4. Insufficient data
    return {
        pattern: 'insufficient_data',
        confidence: 'low',
        sampleCount: evidence.length,
        source: 'insufficient',
        autonomousReady: false,
    };
}
