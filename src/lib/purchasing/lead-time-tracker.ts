/**
 * @file    lead-time-tracker.ts
 * @purpose Nightly vendor lead-time tracking pipeline (4 layers).
 *          Layer 1: Persist observed P50/P90/on-time-rate to vendor_lead_time_stats
 *          Layer 2: Detect drift between observed and override, send TG alert
 *          Layer 3: Auto-update override when guardrails pass (opt-in per vendor)
 *          Layer 4: Cross-validate BAS Auto declared vs Finale observed lead times
 * @author  Hermia
 * @created 2026-06-10
 * @deps    finale/purchasing, supabase, telegram-notify
 * @env     TELEGRAM_CHAT_ID
 *
 * DESIGN: Zero extra Finale API calls. Reads from the cache populated by
 * getVendorLeadTimeHistory() which already runs in the reorder pipeline.
 * One nightly cron tick touches: 1 Finale call (already cached), 1 Supabase
 * upsert, 1 Supabase read, 0-x HTTP (BAS snapshot is local disk).
 */

import { createClient } from '../supabase';
import { finaleClient } from '../finale/client';
import { sendTelegramNotify } from '../intelligence/telegram-notify';
import * as fs from 'fs';
import * as path from 'path';

// ── Layer 1 Types ────────────────────────────────────────────────
export interface VendorLeadStat {
    vendor_party_id: string;
    vendor_name: string;
    sample_count: number;
    p50_days: number | null;
    p90_days: number | null;
    on_time_rate: number | null;
    spread_days: number | null;
    first_po_date: string | null;
    last_po_date: string | null;
}

// ── Layer 2 Types ────────────────────────────────────────────────
export interface DriftAlert {
    vendorName: string;
    vendorPartyId: string;
    observedP90: number;
    currentOverride: number | null;
    driftPct: number;
    sampleCount: number;
}

// ── Layer 3 Types ────────────────────────────────────────────────
export interface AutoUpdateResult {
    vendorName: string;
    vendorPartyId: string;
    oldOverride: number;
    newOverride: number;
    observedP90: number;
    reason: string;
}

// ── Layer 4 Types ────────────────────────────────────────────────
export interface BASCrossValidation {
    vendorName: string;
    basDeclaredDays: number;
    finaleObservedP50: number;
    finaleObservedP90: number;
    sampleCount: number;
    driftPct: number;
}

// ── Aggregate result ─────────────────────────────────────────────
export interface LeadTimeTrackerResult {
    statsPersisted: number;
    driftAlerts: DriftAlert[];
    autoUpdates: AutoUpdateResult[];
    basCrossValidations: BASCrossValidation[];
    errors: string[];
}

// ── Guardrail constants (Layer 3) ────────────────────────────────
const MIN_AUTO_UPDATE_SAMPLES = 15;
const MIN_AUTO_UPDATE_SPREAD_DAYS = 90;
const MAX_OVERRIDE_CHANGE_DAYS = 15;
const MAX_OVERRIDE_CHANGE_PCT = 0.20;
const ABSOLUTE_MIN_OVERRIDE = 7;
const ABSOLUTE_MAX_OVERRIDE = 90;
const MIN_DAYS_BETWEEN_UPDATES = 30;

// Layer 2 alert thresholds
const DRIFT_ALERT_PCT = 0.20;
const MIN_ALERT_SAMPLES = 10;

// Layer 4 thresholds
const BAS_DRIFT_ALERT_PCT = 0.50;
const MIN_BAS_SAMPLES = 5;

// ── Layer 1: Persist stats ───────────────────────────────────────
async function persistLeadTimeStats(
    db: ReturnType<typeof createClient>,
    log: (msg: string) => void,
): Promise<VendorLeadStat[]> {
    const distribution = finaleClient.getVendorLeadTimeDistribution();
    const rawArrays = finaleClient.getRawLeadTimeArrays();
    const onTimeRates = finaleClient.getVendorOnTimeRates();
    const partyIds = finaleClient.getVendorPartyIdMap();

    const stats: VendorLeadStat[] = [];

    for (const [vendorName, dist] of Array.from(distribution.entries())) {
        const partyId = partyIds.get(vendorName);
        if (!partyId) continue; // Can't persist without canonical party ID

        const rawDays = rawArrays.get(vendorName) || [];
        const sorted = rawDays.length >= 2 ? [...rawDays].sort((a, b) => a - b) : null;
        const onTimeRate = onTimeRates.get(vendorName) ?? null;
        const median: number | null = dist.p50 ?? null; // p50 = median from distribution

        // Compute dates from sorted array — we don't have actual dates, but
        // spread_days captures the temporal range. We approximate dates from
        // the PO query window (365d back from today).
        const now = new Date();
        const lastPoDate = now.toISOString().split('T')[0];
        const spreadDays = sorted && sorted.length >= 2 ? sorted[sorted.length - 1] - sorted[0] : null;
        const firstPoDate = spreadDays != null
            ? new Date(now.getTime() - spreadDays * 86_400_000).toISOString().split('T')[0]
            : null;

        stats.push({
            vendor_party_id: partyId,
            vendor_name: vendorName,
            sample_count: dist.sampleCount,
            p50_days: median,
            p90_days: dist.p90,
            on_time_rate: onTimeRate,
            spread_days: spreadDays,
            first_po_date: firstPoDate,
            last_po_date: lastPoDate,
        });
    }

    if (stats.length === 0) {
        log('[L1] No vendor lead-time data to persist (cache cold?)');
        return stats;
    }

    // Upsert in batch
    const { error } = await db.from('vendor_lead_time_stats').upsert(
        stats.map(s => ({
            vendor_party_id: s.vendor_party_id,
            vendor_name: s.vendor_name,
            sample_count: s.sample_count,
            p50_days: s.p50_days,
            p90_days: s.p90_days,
            on_time_rate: s.on_time_rate,
            spread_days: s.spread_days,
            first_po_date: s.first_po_date,
            last_po_date: s.last_po_date,
            updated_at: new Date().toISOString(),
        })),
        { onConflict: 'vendor_party_id' },
    );

    if (error) {
        log(`[L1] Upsert failed: ${error.message}`);
        return [];
    }

    log(`[L1] Persisted ${stats.length} vendor lead-time stats`);
    return stats;
}

// ── Layer 2: Drift detection ─────────────────────────────────────
async function detectDrift(
    db: ReturnType<typeof createClient>,
    log: (msg: string) => void,
): Promise<DriftAlert[]> {
    const { data: stats } = await db.from('vendor_lead_time_stats').select('*') as { data: any[] | null; error: any };
    const { data: policies } = await db.from('vendor_reorder_policies').select('*') as { data: any[] | null; error: any };

    if (!stats || !policies) {
        log('[L2] Missing stats or policies data');
        return [];
    }

    const policyMap = new Map(policies.map(p => [p.vendor_party_id, p]));
    const alerts: DriftAlert[] = [];

    for (const stat of stats) {
        if (!stat.p90_days || stat.sample_count < MIN_ALERT_SAMPLES) continue;

        const policy = policyMap.get(stat.vendor_party_id);
        // Only alert when there's a lead_time_override_days set (manual override to drift against)
        const currentOverride = policy?.lead_time_override_days ?? null;
        if (currentOverride == null) continue;

        const drift = Math.abs(stat.p90_days - currentOverride);
        const driftPct = drift / currentOverride;

        if (driftPct >= DRIFT_ALERT_PCT) {
            alerts.push({
                vendorName: stat.vendor_name || stat.vendor_party_id,
                vendorPartyId: stat.vendor_party_id,
                observedP90: stat.p90_days,
                currentOverride,
                driftPct: Math.round(driftPct * 100),
                sampleCount: stat.sample_count,
            });
        }
    }

    log(`[L2] Found ${alerts.length} drift alert(s)`);
    return alerts;
}

// ── Layer 3: Auto-update with guardrails ─────────────────────────
async function autoUpdateOverrides(
    db: ReturnType<typeof createClient>,
    log: (msg: string) => void,
): Promise<AutoUpdateResult[]> {
    const { data: stats } = await db.from('vendor_lead_time_stats').select('*') as { data: any[] | null; error: any };
    const { data: policies } = await db.from('vendor_reorder_policies').select('*') as { data: any[] | null; error: any };

    if (!stats || !policies) return [];

    const policyMap = new Map(policies.map(p => [p.vendor_party_id, p]));
    const updates: AutoUpdateResult[] = [];

    for (const stat of stats) {
        if (!stat.p90_days) continue;

        const policy = policyMap.get(stat.vendor_party_id);
        if (!policy) continue;

        // Gate 1: Must be opted in
        if (!policy.auto_update_override) continue;

        // Gate 2: Current override must exist
        const currentOverride = policy.lead_time_override_days;
        if (currentOverride == null) continue;

        // Gate 3: Sufficient sample size and spread
        if (stat.sample_count < MIN_AUTO_UPDATE_SAMPLES) continue;
        if ((stat.spread_days ?? 0) < MIN_AUTO_UPDATE_SPREAD_DAYS) continue;

        // Gate 4: Rate limit — no more than one update per 30 days
        if (policy.override_last_updated_at) {
            const lastUpdate = new Date(policy.override_last_updated_at);
            const daysSinceUpdate = (Date.now() - lastUpdate.getTime()) / 86_400_000;
            if (daysSinceUpdate < MIN_DAYS_BETWEEN_UPDATES) continue;
        }

        // Gate 5: Compute candidate new override with bounds
        const drift = stat.p90_days - currentOverride;
        const driftPct = Math.abs(drift / currentOverride);

        // Only update if drift exceeds 20%
        if (driftPct < MAX_OVERRIDE_CHANGE_PCT) continue;

        // Cap the change at ±15 days AND ±20%
        const maxAbsChange = Math.min(MAX_OVERRIDE_CHANGE_DAYS, currentOverride * MAX_OVERRIDE_CHANGE_PCT);
        const clampedDrift = Math.sign(drift) * Math.min(Math.abs(drift), maxAbsChange);
        const candidateOverride = Math.round(currentOverride + clampedDrift);

        // Gate 6: Absolute bounds
        if (candidateOverride < ABSOLUTE_MIN_OVERRIDE || candidateOverride > ABSOLUTE_MAX_OVERRIDE) continue;

        // Gate 7: No trivial updates (less than 2 days change isn't worth the noise)
        if (Math.abs(candidateOverride - currentOverride) < 2) continue;

        // All gates passed — apply the update
        const { error } = await db
            .from('vendor_reorder_policies')
            .update({
                lead_time_override_days: candidateOverride,
                override_last_updated_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('vendor_party_id', stat.vendor_party_id);

        if (error) {
            log(`[L3] Update failed for ${stat.vendor_name}: ${error.message}`);
            continue;
        }

        updates.push({
            vendorName: stat.vendor_name || stat.vendor_party_id,
            vendorPartyId: stat.vendor_party_id,
            oldOverride: currentOverride,
            newOverride: candidateOverride,
            observedP90: stat.p90_days,
            reason: `P90=${stat.p90_days}d over ${stat.sample_count} POs (${stat.spread_days}d spread)`,
        });

        log(`[L3] Auto-updated ${stat.vendor_name}: ${currentOverride}d → ${candidateOverride}d`);
    }

    return updates;
}

// ── Layer 4: BAS Auto cross-validation ───────────────────────────
async function crossValidateBAS(
    stats: VendorLeadStat[],
    log: (msg: string) => void,
): Promise<BASCrossValidation[]> {
    const snapshotPath = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        'AppData', 'Local', 'hermes', 'cache', 'basauto', 'latest-snapshot.json',
    );

    if (!fs.existsSync(snapshotPath)) {
        log('[L4] No BAS snapshot found');
        return [];
    }

    try {
        const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
        const purchaseOrders = raw.purchase_orders?.purchases || raw.purchase_orders || [];

        // Build vendor → declared lead time map from BAS snapshot
        const basLeadTimes = new Map<string, number>();
        for (const entry of purchaseOrders) {
            const supplier: string = entry.supplier || '';
            const products: any[] = entry.products || [];
            for (const prod of products) {
                if (prod.supplierLeadDays != null && prod.supplierLeadDays > 0) {
                    // Use the first non-zero value per supplier (they're all the same for a vendor)
                    if (!basLeadTimes.has(supplier)) {
                        basLeadTimes.set(supplier, prod.supplierLeadDays);
                    }
                }
            }
        }

        if (basLeadTimes.size === 0) {
            log('[L4] No lead times in BAS snapshot');
            return [];
        }

        const validations: BASCrossValidation[] = [];
        const statByName = new Map(stats.map(s => [(s.vendor_name || '').toLowerCase(), s]));

        for (const [basVendor, basDays] of basLeadTimes) {
            const stat = statByName.get(basVendor.toLowerCase());
            if (!stat || !stat.p50_days || !stat.p90_days) continue;
            if (stat.sample_count < MIN_BAS_SAMPLES) continue;

            const driftPct = Math.abs(basDays - stat.p50_days) / Math.max(basDays, 1);

            if (driftPct >= BAS_DRIFT_ALERT_PCT) {
                validations.push({
                    vendorName: basVendor,
                    basDeclaredDays: basDays,
                    finaleObservedP50: stat.p50_days,
                    finaleObservedP90: stat.p90_days,
                    sampleCount: stat.sample_count,
                    driftPct: Math.round(driftPct * 100),
                });
            }
        }

        log(`[L4] Found ${validations.length} BAS cross-validation mismatch(es)`);
        return validations;

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[L4] Error reading BAS snapshot: ${msg}`);
        return [];
    }
}

// ── Telegram formatting ──────────────────────────────────────────
function formatTelegramReport(result: LeadTimeTrackerResult): string | null {
    const lines: string[] = [];

    if (result.autoUpdates.length > 0) {
        lines.push('🔄 Lead Time Auto-Updates');
        for (const u of result.autoUpdates) {
            lines.push(`  ${u.vendorName}: ${u.oldOverride}d → ${u.newOverride}d (observed P90: ${u.observedP90}d, ${u.reason})`);
        }
    }

    if (result.driftAlerts.length > 0) {
        lines.push(result.autoUpdates.length > 0 ? '' : '');
        lines.push('⚠️ Lead Time Drift Alerts');
        for (const d of result.driftAlerts) {
            const direction = d.observedP90 > (d.currentOverride ?? 0) ? '↑ slower' : '↓ faster';
            lines.push(`  ${d.vendorName}: override=${d.currentOverride}d, observed P90=${d.observedP90}d (${d.driftPct}% ${direction}, n=${d.sampleCount})`);
        }
    }

    if (result.basCrossValidations.length > 0) {
        lines.push('');
        lines.push('📊 BAS vs Finale Lead Time Mismatches');
        for (const v of result.basCrossValidations) {
            lines.push(`  ${v.vendorName}: BAS declares ${v.basDeclaredDays}d, Finale observed P50=${v.finaleObservedP50}d/P90=${v.finaleObservedP90}d (${v.driftPct}% drift, n=${v.sampleCount})`);
        }
    }

    if (lines.length === 0) return null; // No news is good news
    return lines.join('\n');
}

// ── Main orchestrator ────────────────────────────────────────────
export async function runLeadTimeTracker(
    log: (msg: string) => void = console.log,
): Promise<LeadTimeTrackerResult> {
    const result: LeadTimeTrackerResult = {
        statsPersisted: 0,
        driftAlerts: [],
        autoUpdates: [],
        basCrossValidations: [],
        errors: [],
    };

    const db = createClient();
    if (!db) {
        result.errors.push('Supabase client unavailable');
        return result;
    }

    // Warm the Finale cache (one GraphQL call, cached for 4h)
    try {
        await finaleClient.getVendorLeadTimeHistory(365);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Finale cache warm failed: ${msg}`);
        log(`[tracker] Cache warm failed: ${msg}`);
    }

    // Layer 1: Persist stats
    try {
        const stats = await persistLeadTimeStats(db, log);
        result.statsPersisted = stats.length;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`L1 persist failed: ${msg}`);
        log(`[tracker] L1 failed: ${msg}`);
    }

    // Layer 2: Drift detection
    try {
        result.driftAlerts = await detectDrift(db, log);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`L2 drift detection failed: ${msg}`);
        log(`[tracker] L2 failed: ${msg}`);
    }

    // Layer 3: Auto-update (runs after drift detection)
    try {
        result.autoUpdates = await autoUpdateOverrides(db, log);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`L3 auto-update failed: ${msg}`);
        log(`[tracker] L3 failed: ${msg}`);
    }

    // Layer 4: BAS cross-validation (reads persisted stats + local file)
    try {
        const { data: allStats } = await db.from('vendor_lead_time_stats').select('*') as { data: any[] | null; error: any };
        if (allStats) {
            result.basCrossValidations = await crossValidateBAS(allStats, log);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`L4 BAS cross-validation failed: ${msg}`);
        log(`[tracker] L4 failed: ${msg}`);
    }

    // Send consolidated TG report (only if there's something to say)
    const report = formatTelegramReport(result);
    if (report) {
        try {
            await sendTelegramNotify(report);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`TG report send failed: ${msg}`);
        }
    }

    return result;
}
