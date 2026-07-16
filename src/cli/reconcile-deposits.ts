/**
 * @file    reconcile-deposits.ts
 * @purpose CLI tool to match a bank deposit from Bank of Colorado against the
 *          Daily Cash Report sheet and Finaloop Draft Orders. Supports both
 *          local CSV files and Google Sheets API lookup.
 * @author  Hermia
 * @created 2026-07-16
 * @deps    finaloop-reconciler, google-sheets
 *
 * Usage:
 *   # Match a specific deposit amount against sheet + Draft Orders:
 *   node --import tsx src/cli/reconcile-deposits.ts --deposit 1343.14 --sheet ./sheet.csv --finaloop ./orders.csv
 *
 *   # Auto-detect deposits from Transactions CSV + cross-reference:
 *   node --import tsx src/cli/reconcile-deposits.ts --transactions ./tx.csv --sheet ./sheet.csv --finaloop ./orders.csv
 *
 *   # Read sheet from Google Drive API:
 *   node --import tsx src/cli/reconcile-deposits.ts --deposit 1343.14 --finaloop ./orders.csv
 *
 *   # Just parse and display CSV stats:
 *   node --import tsx src/cli/reconcile-deposits.ts --sheet ./sheet.csv --finaloop ./orders.csv
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import {
  reconcileDeposit,
  reconcileMultipleDeposits,
  parseCashReportCSV,
  parseFinaloopCSV,
  parseTransactionsCSV,
  detectPendingDeposits,
} from '../lib/intelligence/finaloop-reconciler';

/* ─────────────────────── Arg Parser ─────────────────────── */

interface CliArgs {
  deposit?: number;
  sheetPath?: string;
  finaloopPath?: string;
  transactionsPath?: string;
  sheetId?: string;
  listSheets?: boolean;
  interactive?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--deposit':
      case '-d':
        args.deposit = parseFloat(argv[++i]);
        break;
      case '--sheet':
      case '-s':
        args.sheetPath = argv[++i];
        break;
      case '--finaloop':
      case '-f':
        args.finaloopPath = argv[++i];
        break;
      case '--transactions':
      case '-t':
        args.transactionsPath = argv[++i];
        break;
      case '--sheet-id':
        args.sheetId = argv[++i];
        break;
      case '--list-sheets':
        args.listSheets = true;
        break;
      case '--interactive':
      case '-i':
        args.interactive = true;
        break;
      default:
        // Could be a standalone deposit amount
        if (!args.deposit && !isNaN(parseFloat(argv[i]))) {
          args.deposit = parseFloat(argv[i]);
        }
    }
  }

  return args;
}

/* ─────────────────────── Output Formatter ─────────────────────── */

function formatResult(result: ReturnType<typeof reconcileDeposit>): string {
  const lines: string[] = [];
  const divider = '─'.repeat(48);

  lines.push('');
  lines.push(`📋 ${result.sheetLabel}`);
  lines.push(divider);
  lines.push(`  Total orders in sheet: ${result.totalSheetOrders}`);
  lines.push(`  Sheet total:           $${result.sheetTotal.toFixed(2)}`);
  lines.push('');

  // Unpaid orders (need matching)
  if (result.unpaidOrders.length > 0) {
    lines.push(`⬜ UNPAID — ${result.unpaidOrders.length} orders / $${result.unpaidTotal.toFixed(2)}`);
    lines.push(divider);
    for (const o of result.unpaidOrders) {
      const date = o.placedDate;
      lines.push(`  ☐ ${o.orderName.padEnd(10)} $${o.unpaidBalance.toFixed(2).padStart(8)}  ${o.customer.padEnd(20)} ${o.status}`);
    }
    lines.push('');
  } else {
    lines.push('✅ All sheet orders are already matched in Finaloop.');
    lines.push('');
  }

  // Already paid
  if (result.paidOrders.length > 0) {
    lines.push(`✅ ALREADY PAID — ${result.paidOrders.length} orders / $${result.paidTotal.toFixed(2)}`);
    lines.push(divider);
    for (const o of result.paidOrders) {
      lines.push(`  ✓ ${o.orderName.padEnd(10)} $${o.sheetAmount.toFixed(2).padStart(8)}  ${o.customer.padEnd(20)}`);
    }
    lines.push('');
  }

  // Not found in Finaloop
  if (result.notFoundInFinaloop.length > 0) {
    lines.push(`ℹ️ NOT IN DRAFT ORDERS (likely paid via processor) — ${result.notFoundInFinaloop.length} / $${result.notFoundTotal.toFixed(2)}`);
    lines.push(divider);
    for (const o of result.notFoundInFinaloop) {
      lines.push(`     ${o.orderName.padEnd(10)} $${o.amount.toFixed(2).padStart(8)}`);
    }
    lines.push('');
  }

  // Deposit match
  if (result.depositAmount > 0) {
    lines.push('💰 DEPOSIT MATCH');
    lines.push(divider);

    if (result.depositMatchesUnpaid) {
      lines.push(`  ✅ Deposit $${result.depositAmount.toFixed(2)} = Unpaid total $${result.unpaidTotal.toFixed(2)}`);
      lines.push(`  → Go to Finaloop, select these ${result.unpaidOrders.length} orders,`);
      lines.push(`    click Bulk Actions → Link payment, and find the deposit.`);
    } else {
      lines.push(`  Deposit:       $${result.depositAmount.toFixed(2)}`);
      lines.push(`  Unpaid total:  $${result.unpaidTotal.toFixed(2)}`);
      lines.push(`  Variance:      $${result.depositVariance.toFixed(2)}`);
      lines.push('');
      lines.push(`  ℹ️ Deposit amount doesn't match unpaid total exactly.`);

      // Show computed subset
      const { computeDepositCoverage } = require('../lib/intelligence/finaloop-reconciler');
      const coverage = computeDepositCoverage(result.depositAmount, result.unpaidOrders);
      if (coverage.matchedOrders.length > 0) {
        lines.push('');
        lines.push(`  Best match: ${coverage.matchedOrders.length} orders / $${coverage.matchedTotal.toFixed(2)}`);
        for (const o of coverage.matchedOrders) {
          lines.push(`    → ${o.orderName.padEnd(10)} $${o.unpaidBalance.toFixed(2).padStart(8)}  ${o.customer}`);
        }
        if (!coverage.isExactMatch) {
          lines.push(`    Remaining: $${coverage.remainingDeposit.toFixed(2)}`);
        }
      }
    }

    lines.push('');
  }

  lines.push(result.recommendation);
  lines.push('');

  return lines.join('\n');
}

/* ─────────────────────── Main ─────────────────────── */

async function main() {
  const args = parseArgs();

  if (!args.finaloopPath) {
    console.log('');
    console.log('📋 Deposit Reconciliation Tool');
    console.log('');
    console.log('Usage:');
    console.log('  node --import tsx src/cli/reconcile-deposits.ts \\');
    console.log('    --deposit 1343.14 \\');
    console.log('    --sheet ./daily-cash-report.csv \\');
    console.log('    --finaloop ./finaloop-orders.csv');
    console.log('');
    console.log('  # Or auto-detect deposits from Transactions CSV:');
    console.log('  node --import tsx src/cli/reconcile-deposits.ts \\');
    console.log('    --transactions ./transactions.csv \\');
    console.log('    --sheet ./daily-cash-report.csv \\');
    console.log('    --finaloop ./finaloop-orders.csv');
    console.log('');
    console.log('Or to list available sheets from Drive:');
    console.log('  node --import tsx src/cli/reconcile-deposits.ts --list-sheets');
    console.log('');
    process.exit(0);
  }

  // Read Finaloop CSV
  if (!fs.existsSync(args.finaloopPath)) {
    console.error(`❌ Finaloop CSV not found: ${args.finaloopPath}`);
    process.exit(1);
  }
  const finaloopCsv = fs.readFileSync(args.finaloopPath, 'utf-8');

  // Read Sheet CSV
  let sheetCsv: string;
  let sheetLabel = 'Daily Cash Report';

  if (args.sheetPath) {
    if (!fs.existsSync(args.sheetPath)) {
      console.error(`❌ Sheet CSV not found: ${args.sheetPath}`);
      process.exit(1);
    }
    sheetCsv = fs.readFileSync(args.sheetPath, 'utf-8');
    sheetLabel = path.basename(args.sheetPath, path.extname(args.sheetPath));
  } else if (args.sheetId) {
    const { getSheetsAuthClient, readSheetAsCSV } = await import('../lib/integrations/google-sheets');
    const auth = await getSheetsAuthClient();
    sheetCsv = await readSheetAsCSV(auth, args.sheetId);
    sheetLabel = `Sheet ID: ${args.sheetId}`;
    console.log(`📄 Read sheet from Google Drive`);
  } else {
    try {
      const { getLatestCashReportCSV } = await import('../lib/integrations/google-sheets');
      const result = await getLatestCashReportCSV();
      sheetCsv = result.csv;
      sheetLabel = result.sheetName;
      console.log(`📄 Fetched latest: ${result.sheetName}`);
    } catch (err: any) {
      console.error(`❌ Could not fetch from Drive: ${err.message}`);
      console.error('   Pass --sheet <path> with a downloaded CSV instead.');
      process.exit(1);
    }
  }

  // Show CSV stats
  const parsedSheet = parseCashReportCSV(sheetCsv);
  const parsedFinaloop = parseFinaloopCSV(finaloopCsv);
  const draftOrders = parsedFinaloop.filter(
    (o) =>
      o.salesChannel.toLowerCase().includes('draft') ||
      o.salesChannel.toLowerCase().includes('manual'),
  );

  console.log(`📊 Sheet: ${parsedSheet.length} orders`);
  console.log(`📊 Finaloop: ${parsedFinaloop.length} total, ${draftOrders.length} Draft Orders`);

  // ── Transactions-based auto-detect mode ──
  if (args.transactionsPath) {
    if (!fs.existsSync(args.transactionsPath)) {
      console.error(`❌ Transactions CSV not found: ${args.transactionsPath}`);
      process.exit(1);
    }

    const txCsv = fs.readFileSync(args.transactionsPath, 'utf-8');
    const txs = parseTransactionsCSV(txCsv);
    const deposits = detectPendingDeposits(txs);
    console.log(`📊 Transactions: ${txs.length} total, ${deposits.length} pending deposit(s)`);

    if (deposits.length === 0) {
      console.log('\n⚠️  No pending Bank of Colorado deposits found in Transactions export.');
      process.exit(0);
    }

    // If a specific deposit amount was given, match just that one
    if (args.deposit) {
      const matchingDeposit = deposits.find(
        (d) => Math.abs(d.amount - args.deposit!) < 0.02
      );
      if (matchingDeposit) {
        console.log(`💰 Selected deposit: $${matchingDeposit.amount.toFixed(2)} from ${matchingDeposit.date}`);
      } else {
        console.log(`💰 Deposit $${args.deposit.toFixed(2)} not found in transactions — running match anyway`);
      }
      const result = reconcileDeposit(sheetCsv, finaloopCsv, args.deposit, sheetLabel);
      process.stdout.write(formatResult(result));
    } else {
      // Show all deposits and their matches
      console.log(`\n📋 Multiple deposit mode — ${deposits.length} deposit(s) found:\n`);
      deposits.forEach((d, i) => {
        console.log(`  ${i + 1}. $${d.amount.toFixed(2)} — ${d.date}`);
      });
      console.log('');

      const multiResult = reconcileMultipleDeposits(sheetCsv, finaloopCsv, txCsv, sheetLabel);

      for (let i = 0; i < multiResult.matches.length; i++) {
        const m = multiResult.matches[i];
        const confidenceIcon =
          m.confidence === "high" ? "✅" : m.confidence === "medium" ? "🟡" : "⚪";

        console.log(`${'─'.repeat(50)}`);
        console.log(
          `${confidenceIcon} Deposit ${i + 1}: $${m.deposit.amount.toFixed(2)} on ${m.deposit.date}`
        );
        console.log(`   Window: ${m.dateWindow} · ${m.windowOrders.length} unpaid orders / $${m.windowTotal.toFixed(2)}`);

        if (m.matchedOrders.length > 0) {
          console.log(`   Matched: ${m.matchedOrders.length} orders / $${m.matchedTotal.toFixed(2)}`);
          if (m.isExactMatch) {
            console.log(`   ✅ Exact match — likely corresponds to this deposit`);
          } else if (m.remainingFromDeposit > 0) {
            console.log(`   Remaining: $${m.remainingFromDeposit.toFixed(2)} (may be fees + later orders)`);
          }
          for (const o of m.matchedOrders) {
            console.log(`     → ${o.orderName}  $${o.unpaidBalance.toFixed(2)}  ${o.customer}  [${o.placedDate}]`);
          }
        } else {
          console.log(`   ⚪ No matching orders in this date window`);
          console.log(`     (deposit likely corresponds to a different period)`);
        }
        console.log('');
      }

      console.log(`${'─'.repeat(50)}`);
      console.log(multiResult.summary);
    }
    process.exit(0);
  }

  // ── Standard deposit match mode ──
  if (args.deposit) {
    console.log(`💰 Deposit: $${args.deposit.toFixed(2)}`);
  }

  const result = reconcileDeposit(
    sheetCsv,
    finaloopCsv,
    args.deposit || 0,
    sheetLabel,
  );

  process.stdout.write(formatResult(result));

  if (result.unpaidOrders.length > 0) {
    const unpaid = result.unpaidOrders.map((o) => o.orderName).join(', ');
    console.log(`🔗 Orders to match in Finaloop: ${unpaid}`);
  }
}

main().catch((err) => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
