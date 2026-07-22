/**
 * @file    src/cli/backfill-freight-v2.ts
 * @purpose Filtered freight backfill: recent POs (124xxx/234xxxxx), no Uline,
 *          confirmed separate-freight vendors only. DestiNATION included
 *          (legitimate truck freight for Gary's Worm, Malibu pickups).
 *          Marion Ag, Farm Fuel, SEACOAST excluded (freight baked into items).
 * @author  Hermia
 * @created 2026-07-22
 *
 * Usage:   node --env-file=.env.local --import tsx src/cli/backfill-freight-v2.ts
 */

import { FinaleClient } from '@/lib/finale/client';

const FINALE_RATE_LIMIT_MS = 1500;
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Filtered from dry-run per Bill's rules:
// - NO Uline/ULINE
// - NO 123xxx or below (past 60 days)
// - NO Marion Ag, Farm Fuel, SEACOAST (freight baked into line items)
// - DestiNATION INCLUDED (separate truck freight — Gary's Worm, Malibu pickups)
const PUSHES: Array<{ orderId: string; freight: number; vendor: string }> = [
  { orderId: "124842", freight: 15.68, vendor: "Axiom Print" },
  { orderId: "23440057", freight: 74.50, vendor: "Evergreen Growers Supply" },
  { orderId: "124514", freight: 26.99, vendor: "Axiom Print" },
  { orderId: "23420427", freight: 18.00, vendor: "AutoPot USA" },
  { orderId: "124509", freight: 17.05, vendor: "Axiom Print" },
  { orderId: "124800", freight: 112.32, vendor: "Jabb of the Carolinas" },
  { orderId: "124510", freight: 18.70, vendor: "Axiom Print" },
  { orderId: "124878", freight: 215.33, vendor: "American Extracts" },
  { orderId: "23417787", freight: 78.54, vendor: "Evergreen Growers Supply" },
  { orderId: "23430347", freight: 71.95, vendor: "Evergreen Growers Supply" },
  { orderId: "124404", freight: 604.18, vendor: "FedEx" },
  { orderId: "124545", freight: 39.21, vendor: "Axiom Print" },
  { orderId: "124508", freight: 90.98, vendor: "Axiom Print" },
  { orderId: "124833", freight: 120.18, vendor: "Grassroots Fabric Pots" },
  { orderId: "23451837", freight: 20.00, vendor: "AutoPot Watering Systems USA" },
  { orderId: "124629", freight: 40.65, vendor: "Grassroots Fabric Pots" },
  { orderId: "124372", freight: 899.50, vendor: "FedEx" },
  { orderId: "124824", freight: 2200.00, vendor: "DestiNATION TRANSPORT" },
  { orderId: "23407897", freight: 62.60, vendor: "Evergreen Growers Supply" },
  { orderId: "124693", freight: 288.84, vendor: "NOVELTY" },
  { orderId: "23443837", freight: 20.00, vendor: "AutoPot Watering Systems USA" },
  { orderId: "23428337", freight: 81.40, vendor: "Evergreen Growers Supply" },
  { orderId: "124507", freight: 33.20, vendor: "Axiom Print" },
  { orderId: "23407827", freight: 51.00, vendor: "AutoPot USA" },
  { orderId: "124394", freight: 303.25, vendor: "FedEx" },
  { orderId: "23432607", freight: 64.44, vendor: "Evergreen Growers Supply" },
  { orderId: "124661", freight: 4300.00, vendor: "DestiNATION Transport" },
  { orderId: "23447217", freight: 65.43, vendor: "Evergreen Growers Supply" },
  { orderId: "23443837", freight: 20.00, vendor: "AutoPot USA" },
  { orderId: "23433107", freight: 23.00, vendor: "AutoPot USA" },
  { orderId: "124544", freight: 20.47, vendor: "Axiom Print" },
  { orderId: "124600", freight: 1625.00, vendor: "DestiNATION TRANSPORT" },
  { orderId: "124543", freight: 10.08, vendor: "Axiom Print" },
  { orderId: "23409737", freight: 63.72, vendor: "Evergreen Growers Supply" },
  { orderId: "124515", freight: 7.24, vendor: "Axiom Print" },
  { orderId: "23410087", freight: 71.04, vendor: "Evergreen Growers Supply" },
  { orderId: "23443737", freight: 71.98, vendor: "Evergreen Growers Supply" },
  { orderId: "23452597", freight: 32.00, vendor: "AutoPot Watering Systems USA" },
  { orderId: "23404457", freight: 52.00, vendor: "AutoPot USA" },
  { orderId: "124869", freight: 110.00, vendor: "Grassroots Fabric Pots" },
  { orderId: "23424177", freight: 64.00, vendor: "Evergreen Growers Supply" },
  { orderId: "124681", freight: 132.46, vendor: "Axiom Print" },
  { orderId: "23444357", freight: 67.43, vendor: "Evergreen Growers Supply" },
  { orderId: "124467", freight: 45.78, vendor: "Coats Agri Aloe, Inc." },
  { orderId: "124694", freight: 375.00, vendor: "Faust Bio-Agricultural Services, Inc" },
  { orderId: "124816", freight: 89.88, vendor: "Coats Agri Aloe, Inc." },
];

async function main() {
  const finale = new FinaleClient();
  let pushed = 0;
  let failed = 0;

  console.log(`[backfill-freight-v2] EXECUTE — ${PUSHES.length} POs (filtered)`);
  console.log(`[backfill-freight-v2] Rate-limit delay: ${FINALE_RATE_LIMIT_MS}ms`);
  console.log('');

  for (let i = 0; i < PUSHES.length; i++) {
    const p = PUSHES[i];
    const note = `Freight from invoice (backfill) — ${p.vendor}`;
    try {
      await finale.updateOrderAdjustmentAmount(p.orderId, 'FREIGHT', p.freight, note);
      console.log(`  ✅ [${i + 1}/${PUSHES.length}] PO ${p.orderId}: $${p.freight.toFixed(2)} — ${p.vendor}`);
      pushed++;
    } catch (err: any) {
      console.log(`  ❌ [${i + 1}/${PUSHES.length}] PO ${p.orderId}: $${p.freight.toFixed(2)} — ${p.vendor} — ${err.message}`);
      failed++;
    }
    if (i < PUSHES.length - 1) await sleep(FINALE_RATE_LIMIT_MS);
  }

  console.log('');
  console.log('[backfill-freight-v2] Complete:');
  console.log(`  Pushed: ${pushed}`);
  console.log(`  Failed: ${failed}`);
}

main().catch((err) => {
  console.error('[backfill-freight-v2] Fatal:', err);
  process.exit(1);
});
