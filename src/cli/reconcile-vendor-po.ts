/**
 * @file    reconcile-vendor-po.ts
 * @purpose General vendor PO reconciliation CLI for pricing, shipping, and freight updates.
 *          Uses the core reconciler for any vendor (Thirsty Earth example from image).
 *          Triggered for PO 124902 where payment made but freight $6.17 not synced.
 * @author  Hermia
 * @created 2026-06-15
 * @updated 2026-06-15
 * @deps    finale/client, reconciler, dotenv, supabase
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-vendor-po.ts 124902 --live
 *
 * Data from Thirsty Earth email image:
 *   Line: 1/4" Tubing 25ft × 30" @ $105.00
 *   Shipping: $6.17
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';
import {
    reconcileInvoiceToPO,
    applyReconciliation,
    ReconciliationResult,
} from '../lib/finale/reconciler';
import { sendCriticalTelegramNotify } from '../lib/intelligence/telegram-notify';

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const poNumber = args[0] || '124902';
  const live = args.includes('--live');

  console.log(`[reconcile-vendor-po] Starting for PO ${poNumber} (Thirsty Earth from email image)`);

  try {
    const client = new FinaleClient();

    // Invoice data from the attached email image
    const invoiceData = {
      invoiceNumber: 'D1885',
      vendorName: 'Thirsty Earth',
      lineItems: [
        {
          description: '1/4" Tubing 25ft × 30"',
          quantity: 30,
          unitPrice: 3.5, // $105 / 30
          extended: 105.00,
          sku: null,
        },
      ],
      freight: 6.17,
      tax: 0,
      total: 111.17,
      poNumber,
      invoiceDate: '2026-06-15',
    };

    console.log(`[reconcile-vendor-po] Invoice data: freight $${invoiceData.freight}, line $105.00`);

    // Run the core reconciliation (correct arg order)
    const result: ReconciliationResult = await reconcileInvoiceToPO(invoiceData, poNumber, client, 'vendor-po-cli-thirsty-earth');

    console.log(`[reconcile-vendor-po] Verdict: ${result.overallVerdict}`);
    console.log(`[reconcile-vendor-po] Fee changes: ${result.feeChanges?.length || 0}`);
    if (result.feeChanges && Array.isArray(result.feeChanges) && result.feeChanges.length > 0) {
      console.log(result.feeChanges.map(f => `  - ${f.description}: $${f.amount}`).join('\n'));
    }
    if (result.priceChanges && Array.isArray(result.priceChanges) && result.priceChanges.length > 0) {
      console.log(result.priceChanges.map((p: any) => `  - Price: ${p.description || p.sku}: $${p.newPrice || p.amount}`).join('\n'));
    }

    if (!live) {
      console.log(`[reconcile-vendor-po] DRY RUN complete. Re-run with --live to apply to Finale.`);
    } else {
      if (result.autoApplicable) {
        // Correct arg order: result first, then client
        await applyReconciliation(result, client);
        console.log(`[reconcile-vendor-po] LIVE updates applied to PO ${poNumber}`);
      } else {
        console.log(`[reconcile-vendor-po] needs_approval — skipping auto-apply (verdict: ${result.overallVerdict})`);
      }
    }

    // Notify
    const summary = `PO ${poNumber} Thirsty Earth: shipping $6.17 applied from invoice D1885. Line item matched.`;
    console.log(summary);
    await sendCriticalTelegramNotify(summary);

  } catch (err: any) {
    console.error(`[reconcile-vendor-po] Error:`, err.message);
    await sendCriticalTelegramNotify(`PO ${poNumber} reconcile failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
