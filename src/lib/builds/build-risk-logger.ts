import { createClient } from '../supabase';
import type { BuildRiskReport } from './build-risk';

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
  } catch {
    // Never block the analysis result due to logging failure
  }
}
