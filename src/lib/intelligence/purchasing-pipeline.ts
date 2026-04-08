/**
 * @file    purchasing-pipeline.ts
 * @purpose Orchestrates the full purchasing intelligence pipeline:
 *          scrape → assess → snapshot → diff → Telegram alerts.
 * @usage   Called by OpsManager cron (9 AM Mon-Fri) or manual /purchases command.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '../supabase';

const execAsync = promisify(exec);

export interface PurchasingIntelligenceResult {
  success: boolean;
  message: string;
  telegramMessage: string;
  snapshotId?: string;
  newHighNeedCount: number;
  newRequestsCount: number;
  durationMs: number;
}

export interface VendorAssessment {
  vendor: string;
  items: Array<{
    sku: string;
    description: string;
    necessity: string;
    source?: string;
    fuzzyMatchScore?: number;
  }>;
  highNeedCount: number;
  mediumCount: number;
  noiseCount: number;
}

async function runCommand(command: string, timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await execAsync(command, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.cwd(),
    env: { ...process.env, DOTENV_QUIET: '1' },
  });
  if (stderr && !stderr.includes('Debugger attached')) {
    console.warn(`[${command}] stderr:`, stderr);
  }
  return stdout;
}

export async function runPurchasingIntelligence(options: {
  source: 'cron' | 'manual';
  triggeredBy?: string;
}): Promise<PurchasingIntelligenceResult> {
  const startTime = Date.now();
  const timeoutMs = 5 * 60 * 1000; // 5 min per phase

  try {
    // Phase 1: Scrape
    console.log('[purchasing] Starting scrape...');
    await runCommand('node --import tsx src/cli/scrape-purchases.ts', timeoutMs);

    // Phase 2: Assess (JSON output)
    console.log('[purchasing] Starting assessment...');
    const assessStdout = await runCommand('node --import tsx src/cli/assess-purchases.ts --json', timeoutMs);
    // Extract JSON from output (skip any preceding logs, e.g., dotenv banner)
    const lines = assessStdout.split(/\r?\n/);
    let jsonStartIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // Skip known non-JSON prefix lines like dotenv banner
      if (trimmed.startsWith('[dotenv@')) continue;
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        jsonStartIdx = i;
        break;
      }
    }
    if (jsonStartIdx === -1) {
      throw new Error('No JSON found in assess-purchases output');
    }
    const jsonStr = lines.slice(jsonStartIdx).join('\n');
    const assessedVendorAssessments: VendorAssessment[] = JSON.parse(jsonStr);

    // Load raw data for snapshot
    const purchasesPath = path.resolve(process.cwd(), 'purchases-data.json');
    const requestsPath = path.resolve(process.cwd(), 'purchase-requests.json');

    let raw_purchases: any = {};
    let pendingRequests: any[] = [];

    if (fs.existsSync(purchasesPath)) {
      raw_purchases = JSON.parse(fs.readFileSync(purchasesPath, 'utf-8'));
    }
    if (fs.existsSync(requestsPath)) {
      const rawRequestsData = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
      pendingRequests = (rawRequestsData.requests || []).filter((r: any) => r.status === 'Pending');
    }

    // Compute current counts
    let highNeedCount = 0, mediumCount = 0, lowCount = 0, noiseCount = 0;
    for (const va of assessedVendorAssessments) {
      highNeedCount += va.items.filter(i => i.necessity === 'HIGH_NEED').length;
      mediumCount += va.items.filter(i => i.necessity === 'MEDIUM').length;
      lowCount += va.items.filter(i => i.necessity === 'LOW').length;
      noiseCount += va.items.filter(i => i.necessity === 'NOISE').length;
    }
    const itemsProcessed = assessedVendorAssessments.reduce((sum, va) => sum + va.items.length, 0);
    const requestsProcessed = pendingRequests.length;

    // Load previous snapshot for diff
    const supabase = createClient();
    if (!supabase) {
      throw new Error('Supabase client not available');
    }

    const { data: previous } = await supabase
      .from('purchasing_snapshots')
      .select('assessed_items, raw_requests')
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Diff: New HIGH_NEED SKUs
    const currentHighNeedSkus = new Set<string>();
    for (const va of assessedVendorAssessments) {
      for (const item of va.items) {
        if (item.necessity === 'HIGH_NEED') {
          currentHighNeedSkus.add(item.sku.toLowerCase());
        }
      }
    }

    const previousHighNeedSkus = new Set<string>();
    if (previous?.assessed_items) {
      for (const va of previous.assessed_items as VendorAssessment[]) {
        for (const item of va.items) {
          if (item.necessity === 'HIGH_NEED') {
            previousHighNeedSkus.add(item.sku.toLowerCase());
          }
        }
      }
    }

    const newHighNeedSkus = Array.from(currentHighNeedSkus).filter(sku => !previousHighNeedSkus.has(sku));

    // Diff: New pending requests (by details+quantity key)
    const previousRequestKeys = new Set<string>();
    if (previous?.raw_requests) {
      for (const r of previous.raw_requests as any[]) {
        previousRequestKeys.add(`${r.details}|${r.quantity}`);
      }
    }

    const newPendingRequests = pendingRequests.filter(r => !previousRequestKeys.has(`${r.details}|${r.quantity}`));

    // Persist snapshot
    const durationMs = Date.now() - startTime;
    const snapshotPayload = {
      generated_at: new Date().toISOString(),
      source: options.source,
      triggered_by: options.triggeredBy || null,
      raw_purchases: raw_purchases,
      raw_requests: pendingRequests,
      assessed_items: assessedVendorAssessments,
      high_need_count: highNeedCount,
      medium_count: mediumCount,
      low_count: lowCount,
      noise_count: noiseCount,
      new_high_need_skus: newHighNeedSkus,
      new_pending_requests: newPendingRequests,
      duration_ms: durationMs,
      items_processed: itemsProcessed,
      requests_processed: requestsProcessed,
    };

    const { data: inserted, error: insertError } = await supabase
      .from('purchasing_snapshots')
      .insert(snapshotPayload)
      .select('id')
      .single();

    if (insertError) {
      console.error('[purchasing] Snapshot save failed:', insertError);
      throw insertError;
    }

    // Build Telegram message
    const dateStr = new Date().toLocaleString('en-US', { timeZone: 'America/Denver' });
    let telegramMessage = `🛒 <b>Purchasing Intelligence Report</b>\n\n`;
    telegramMessage += `📅 ${dateStr}\n`;
    telegramMessage += `⏱ Duration: ${(durationMs / 1000).toFixed(1)}s\n\n`;
    telegramMessage += `📊 <b>Snapshot:</b> ${itemsProcessed} items (${highNeedCount} HIGH, ${mediumCount} MED, ${lowCount} LOW, ${noiseCount} NOISE)\n`;
    telegramMessage += `📋 Pending Requests: ${requestsProcessed}\n\n`;

    if (newHighNeedSkus.length > 0) {
      telegramMessage += `<b>🔴 NEW HIGH NEED ITEMS (${newHighNeedSkus.length}):</b>\n`;
      for ( const sku of newHighNeedSkus) {
        let item: any = null;
        let vendor = '';
        for (const va of assessedVendorAssessments) {
          const found = va.items.find(i => i.sku.toLowerCase() === sku);
          if (found) {
            item = found;
            vendor = va.vendor;
            break;
          }
        }
        if (item) {
          telegramMessage += `• <b>${item.sku}</b> — ${item.description}\n`;
          telegramMessage += `  ${item.explanation}\n`;
        }
      }
      telegramMessage += `\n`;
    } else {
      telegramMessage += `✅ No new HIGH_NEED items since last run.\n\n`;
    }

    if (newPendingRequests.length > 0) {
      telegramMessage += `<b>📋 NEW PENDING REQUESTS (${newPendingRequests.length}):</b>\n`;
      for (const req of newPendingRequests) {
        telegramMessage += `• [${req.department}] ${req.details} (×${req.quantity})\n`;
      }
    } else {
      telegramMessage += `✅ No new pending requests.\n`;
    }

    // Also send Telegram if there are new alerts
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId && (newHighNeedSkus.length > 0 || newPendingRequests.length > 0)) {
      const { Telegraf } = await import('telegraf');
      const bot = new Telegraf(botToken);
      await bot.telegram.sendMessage(chatId, telegramMessage, { parse_mode: 'HTML' });
    }

    return {
      success: true,
      message: 'Purchasing intelligence run complete',
      telegramMessage,
      snapshotId: inserted?.id,
      newHighNeedCount: newHighNeedSkus.length,
      newRequestsCount: newPendingRequests.length,
      durationMs,
    };
  } catch (err: any) {
    console.error('[purchasing] Run failed:', err);
    // Notify Telegram on failure
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      try {
        const { Telegraf } = await import('telegraf');
        const bot = new Telegraf(botToken);
        await bot.telegram.sendMessage(
          chatId,
          `❌ <b>Purchasing Intelligence Failed</b>\n\n<pre>${err.message}</pre>`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
    }
    throw err;
  }
}
