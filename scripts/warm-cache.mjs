// Quick cache warm script — run with: node scripts/warm-cache.mjs
import { FinaleClient } from '../src/lib/finale/client.ts';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const cacheDir = join(process.cwd(), '.aria-cache', 'purchasing');
mkdirSync(cacheDir, { recursive: true });

console.log('[warm] Starting purchasing intelligence scan...');
const client = new FinaleClient();
const start = Date.now();
try {
  const groups = await client.getPurchasingIntelligence(365);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const totalItems = groups.reduce((s, g) => s + g.items.length, 0);
  console.log(`[warm] Scan complete: ${groups.length} groups, ${totalItems} items (${elapsed}s)`);
  const snapshot = { at: Date.now(), value: groups };
  const file = join(cacheDir, 'purchasing-resale.json');
  writeFileSync(file, JSON.stringify(snapshot));
  console.log(`[warm] Snapshot saved to ${file}`);
} catch (err) {
  console.error('[warm] Scan failed:', err?.message || err);
  process.exit(1);
}
