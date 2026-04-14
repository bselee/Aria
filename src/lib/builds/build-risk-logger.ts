import { createClient } from '../supabase';
import type { BuildRiskReport, ComponentDemand } from './build-risk';

/**
 * Fetch the most recent saved snapshot's component risk levels from Supabase.
 * Used by the morning risk run to detect components that have flipped
 * from CRITICAL/WARNING → OK (restock event).
 *
 * Returns a map of SKU → { riskLevel } or null if no prior snapshot exists.
 */
export async function getLastSnapshot(): Promise<Record<string, { riskLevel: ComponentDemand['riskLevel'] }> | null> {
    try {
        const db = createClient();
        if (!db) return null;

        const { data, error } = await db
            .from('build_risk_snapshots')
            .select('components')
            .order('generated_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data?.components) return null;

        // components is stored as Record<string, ComponentDemand> (Sets serialized as arrays)
        const raw = data.components as Record<string, any>;
        return Object.fromEntries(
            Object.entries(raw).map(([sku, c]) => [sku, { riskLevel: c.riskLevel as ComponentDemand['riskLevel'] }])
        );
    } catch {
        return null;
    }
}

export async function saveBuildRiskSnapshot(report: BuildRiskReport): Promise<void> {
  try {
    const db = createClient();
    if (!db) return;

    // Serialize Map<string, ComponentDemand> — Sets must become arrays for JSONB
    const components: Record<string, any> = {};
    report.components.forEach((demand, sku) => {
      components[sku] = {
        ...demand,
        usedIn: Array.from(demand.usedIn),
        designations: Array.from(demand.designations),
      };
    });

    await db.from('build_risk_snapshots').insert({
      days_out: report.daysOut,
      critical_count: report.criticalCount,
      warning_count: report.warningCount,
      watch_count: report.watchCount,
      ok_count: report.okCount,
      total_components: report.totalComponents,
      builds: report.builds,
      components,
      unrecognized_skus: report.unrecognizedSkus,
    });
  } catch (err: any) {
    console.error('❌ saveBuildRiskSnapshot failed:', err.message);
  }
}
