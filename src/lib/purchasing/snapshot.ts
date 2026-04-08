/**
 * @file    snapshot.ts
 * @purpose Persist purchasing assessment snapshots to Supabase and retrieve previous snapshots for diffing.
 * @author  Aria / Will
 * @created 2026-04-07
 */

import { createClient } from '@/lib/supabase';
import type { AssessedItem } from '@/cli/assess-purchases';

export interface SnapshotRecord {
  id: string;
  generated_at: string;
  source: 'cron' | 'manual';
  triggered_by?: string;
  raw_purchases: any;
  raw_requests: any;
  assessed_items: AssessedItem[];
  high_need_count: number;
  medium_count: number;
  low_count: number;
  noise_count: number;
  new_high_need_skus: string[];
  new_pending_requests: any[];
  duration_ms?: number;
  items_processed: number;
  requests_processed: number;
}

/**
 * Save a snapshot of the purchasing assessment run.
 */
export async function saveSnapshot(params: {
  source: 'cron' | 'manual';
  triggered_by?: string;
  rawPurchases: any;
  rawRequests: any;
  assessedItems: AssessedItem[];
  newHighNeedSkus: string[];
  newPendingRequests: any[];
  durationMs: number;
}): Promise<void> {
  const supabase = createClient();
  if (!supabase) {
    console.warn('⚠️ Supabase not available — snapshot not saved');
    return;
  }

  const assessedItems = params.assessedItems;
  const highNeedCount = assessedItems.filter(i => i.necessity === 'HIGH_NEED').length;
  const mediumCount = assessedItems.filter(i => i.necessity === 'MEDIUM').length;
  const lowCount = assessedItems.filter(i => i.necessity === 'LOW').length;
  const noiseCount = assessedItems.filter(i => i.necessity === 'NOISE').length;

  const { error } = await supabase
    .from('purchasing_snapshots')
    .insert({
      source: params.source,
      triggered_by: params.triggered_by,
      raw_purchases: params.rawPurchases,
      raw_requests: params.rawRequests,
      assessed_items: assessedItems,
      high_need_count: highNeedCount,
      medium_count: mediumCount,
      low_count: lowCount,
      noise_count: noiseCount,
      new_high_need_skus: params.newHighNeedSkus,
      new_pending_requests: params.newPendingRequests,
      duration_ms: params.durationMs,
      items_processed: assessedItems.length,
      requests_processed: params.newPendingRequests.length,
    });

  if (error) {
    console.error('❌ Failed to save snapshot:', error);
    throw error;
  }

  console.log(`✅ Snapshot saved: ${highNeedCount} high_need, ${mediumCount} medium, ${lowCount} low, ${noiseCount} noise`);
}

/**
 * Get the most recent snapshot before a given date.
 */
export async function getPreviousSnapshot(date: string): Promise<SnapshotRecord | null> {
  const supabase = createClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from('purchasing_snapshots')
    .select('*')
    .lt('generated_at', date)
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();

  return data as SnapshotRecord | null;
}

/**
 * Get the latest snapshot (regardless of date).
 */
export async function getLatestSnapshot(): Promise<SnapshotRecord | null> {
  const supabase = createClient();
  if (!supabase) return null;

  const { data } = await supabase
    .from('purchasing_snapshots')
    .select('*')
    .order('generated_at', { ascending: false })
    .limit(1)
    .single();

  return data as SnapshotRecord | null;
}
