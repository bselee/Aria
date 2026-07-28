/**
 * @file    warm-purchasing-cache-cron.mts
 * @purpose One-shot purchasing intelligence cache warmer for weekday morning cron.
 * @author  Hermia (cron)
 */
import clientMod from '../src/lib/finale/client.ts';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

async function main() {
  const FinaleClient = (clientMod as any).FinaleClient || (clientMod as any).default?.FinaleClient;
  if (!FinaleClient) {
    console.error('[warm] FinaleClient export missing. keys=', Object.keys(clientMod as any));
    process.exit(1);
  }

  const cacheDir = join(process.cwd(), '.aria-cache', 'purchasing');
  mkdirSync(cacheDir, { recursive: true });
  const outFile = join(cacheDir, 'purchasing-resale.json');

  console.log('[warm] Starting scan at', new Date().toISOString());
  console.log('[warm] FINALE_API_KEY=', process.env.FINALE_API_KEY ? 'set' : 'MISSING');
  console.log('[warm] FINALE_ACCOUNT_PATH=', process.env.FINALE_ACCOUNT_PATH ? 'set' : 'MISSING');

  const client = new FinaleClient();
  const groups = await client.getPurchasingIntelligence(365);
  const totalItems = groups.reduce((s: number, g: { items: unknown[] }) => s + g.items.length, 0);
  console.log('[warm] Complete: ' + groups.length + ' groups, ' + totalItems + ' items');

  writeFileSync(outFile, JSON.stringify({ at: Date.now(), value: groups }));
  console.log('[warm] Cache saved to', outFile);
  console.log('[warm] File bytes:', readFileSync(outFile).length);
  console.log('[warm] Done at', new Date().toISOString());
}

main().catch((err) => {
  console.error('[warm] FAILED:', err?.stack || err?.message || err);
  process.exit(1);
});
