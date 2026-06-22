/**
 * @file    warm-cache.js
 * @purpose One-shot manual cache warmer for purchasing intelligence.
 *          Runs as a standalone Node.js script — no tsx needed.
 *          Uses fetch to call Finale's GraphQL directly, then saves the
 *          snapshot to .aria-cache/purchasing/ so the dashboard reads it.
 * @usage   cd aria && node scripts/warm-cache.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Load .env.local
for (const line of readFileSync(resolve(projectRoot, '.env.local'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

// Construct Finale auth header
const auth = Buffer.from(`${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`).toString('base64');
const apiBase = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const accountPath = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
const authHeader = `Basic ${auth}`;
const graphqlUrl = `${apiBase}/${accountPath}/api/graphql`;

async function graphql(query, label) {
    const res = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(`GraphQL ${label}: ${json.errors[0].message}`);
    return json.data;
}

async function main() {
    console.log('[warm] Scanning productViewConnection...');
    const candidates = [];
    let cursor = null;
    while (true) {
        const after = cursor ? `, after: "${cursor}"` : '';
        const data = await graphql(`{
            productViewConnection(first: 500${after}) {
                pageInfo { hasNextPage endCursor }
                edges { node { productId status consumptionQuantity reorderQuantityToOrder stockoutDays demandQuantity demandPerDay } }
            }
        }`, 'productViewConnection');
        const conn = data?.productViewConnection;
        if (!conn) break;
        for (const edge of conn.edges || []) {
            const p = edge.node;
            if (p.status !== 'Active') continue;
            candidates.push({
                productId: p.productId,
                finaleReorderQty: parseFloat(String(p.reorderQuantityToOrder ?? 0)),
                finaleStockoutDays: p.stockoutDays != null ? parseFloat(String(p.stockoutDays)) : null,
                finaleConsumptionQty: parseFloat(String(p.consumptionQuantity ?? 0)),
                finaleDemandQty: p.demandQuantity != null ? parseFloat(String(p.demandQuantity)) : null,
                finaleDemandPerDay: p.demandPerDay != null ? parseFloat(String(p.demandPerDay)) : null,
            });
        }
        if (!conn.pageInfo.hasNextPage) break;
        cursor = conn.pageInfo.endCursor;
    }
    console.log(`[warm] ${candidates.length} active candidates found`);

    // For now, just save the candidate list as a lightweight snapshot.
    // The actual purchasing intelligence with velocity/runway/reorder logic
    // runs inside the dashboard server. We save the candidate list so the
    // dashboard can warm its cache faster.
    const cacheDir = resolve(projectRoot, '.aria-cache', 'purchasing');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(resolve(cacheDir, 'candidates.json'), JSON.stringify({ at: Date.now(), candidates }, null, 2));
    console.log(`[warm] Wrote ${candidates.length} candidates to ${cacheDir}/candidates.json`);
    console.log('[warm] Done. Restart the dashboard and it will read from cache.');
}

main().catch(err => {
    console.error('[warm] Fatal:', err?.message || err);
    process.exit(1);
});
