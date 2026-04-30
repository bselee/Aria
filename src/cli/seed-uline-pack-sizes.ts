/**
 * @file    seed-uline-pack-sizes.ts
 * @purpose Read ULINE MyOrderHistory.xlsx export and emit a SQL migration
 *          seeding sku_pack_sizes for every unique SKU we've ordered.
 *
 *          Pack count is parsed from the line description (e.g.
 *          "Poly Bag (case of 500)") via a few common ULINE phrasings.
 *          SKUs that don't match a pattern are emitted with a TODO marker
 *          so Will can fill them in manually.
 *
 * @usage
 *   node --import tsx src/cli/seed-uline-pack-sizes.ts [path]
 *
 *   Default path: C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx
 *   Output: supabase/migrations/<timestamp>_seed_uline_pack_sizes_bulk.sql
 */

import XLSX from 'xlsx';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_PATH = 'C:/Users/BuildASoil/OneDrive/Desktop/Sandbox/ULINE/MyOrderHistory.xlsx';

type Row = {
    date: Date;
    orderNo: string;
    sku: string;
    description: string;
    qty: number;
    extPrice: number;
};

interface PackParse {
    units: number | null;
    packUnit: string;
    confidence: 'parsed' | 'guessed' | 'unknown';
    reason: string;
}

// Number with optional comma thousands (5,000 / 1,000 / 500)
const NUM = `(\\d{1,3}(?:,\\d{3})*|\\d{1,5})`;

function intFromMatch(s: string): number {
    return parseInt(s.replace(/,/g, ''), 10);
}

const PATTERNS: Array<{ re: RegExp; unitFn: (m: RegExpMatchArray) => string }> = [
    // "case of 500" / "carton of 500" / "box of 100" / etc.
    { re: new RegExp(`\\bcase\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'case' },
    { re: new RegExp(`\\bcarton\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'carton' },
    { re: new RegExp(`\\bbox\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'box' },
    { re: new RegExp(`\\bpack\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'pack' },
    { re: new RegExp(`\\bbundle\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'bundle' },
    { re: new RegExp(`\\bpail\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'pail' },
    { re: new RegExp(`\\bdrum\\s+of\\s+${NUM}\\b`, 'i'), unitFn: () => 'drum' },
    // "500/case" / "500/carton" / "500 / case"
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*case\\b`, 'i'), unitFn: () => 'case' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*carton\\b`, 'i'), unitFn: () => 'carton' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*box\\b`, 'i'), unitFn: () => 'box' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*pack\\b`, 'i'), unitFn: () => 'pack' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*bundle\\b`, 'i'), unitFn: () => 'bundle' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*ctn\\b`, 'i'), unitFn: () => 'carton' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*pail\\b`, 'i'), unitFn: () => 'pail' },
    { re: new RegExp(`\\b${NUM}\\s*\\/\\s*drum\\b`, 'i'), unitFn: () => 'drum' },
    // "5,000 bags/pail" / "100 bags per case" — items inside a container
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s*\\/\\s*pail\\b`, 'i'), unitFn: () => 'pail' },
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s*\\/\\s*case\\b`, 'i'), unitFn: () => 'case' },
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s*\\/\\s*carton\\b`, 'i'), unitFn: () => 'carton' },
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s*\\/\\s*drum\\b`, 'i'), unitFn: () => 'drum' },
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s+per\\s+case\\b`, 'i'), unitFn: () => 'case' },
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s+per\\s+carton\\b`, 'i'), unitFn: () => 'carton' },
    { re: new RegExp(`\\b${NUM}\\s+\\w+s?\\s+per\\s+pail\\b`, 'i'), unitFn: () => 'pail' },
    // "500 per case"
    { re: new RegExp(`\\b${NUM}\\s+per\\s+case\\b`, 'i'), unitFn: () => 'case' },
    { re: new RegExp(`\\b${NUM}\\s+per\\s+carton\\b`, 'i'), unitFn: () => 'carton' },
    // "500-pack" / "500 pack" — keep last to avoid eating other matches
    { re: new RegExp(`\\b${NUM}[-\\s]pack\\b`, 'i'), unitFn: () => 'pack' },
];

function parsePack(description: string): PackParse {
    for (const { re, unitFn } of PATTERNS) {
        const m = description.match(re);
        if (m) {
            const units = intFromMatch(m[1]);
            if (!isNaN(units) && units > 0 && units < 1000000) {
                return {
                    units,
                    packUnit: unitFn(m),
                    confidence: 'parsed',
                    reason: `regex matched "${m[0]}"`,
                };
            }
        }
    }
    return { units: null, packUnit: 'each', confidence: 'unknown', reason: 'no pack phrase found' };
}

interface SkuAggregate {
    sku: string;
    description: string;
    totalQty: number;
    totalSpend: number;
    orderCount: number;
    lastOrder: Date;
    pack: PackParse;
    avgUnitPrice: number;       // extPrice / qty (per ordered unit, not per each)
    avgEaPriceIfParsed: number | null;
}

function escapeSql(s: string): string {
    return s.replace(/'/g, "''");
}

async function main() {
    const args = process.argv.slice(2);
    const filePath = args.find(a => !a.startsWith('--')) || DEFAULT_PATH;

    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        console.error(`   Drop your ULINE MyOrderHistory.xlsx export at:`);
        console.error(`   ${DEFAULT_PATH}`);
        console.error(`   Or pass the path as the first arg.`);
        process.exit(1);
    }

    console.log(`\n📦 ULINE Pack-Size Seed Generator`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Source: ${path.basename(filePath)}\n`);

    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

    const rows: Row[] = [];
    for (let i = 5; i < raw.length; i++) {
        const r = raw[i] as (string | number | null)[];
        if (!r || !r[0] || !r[3]) continue;
        const dateStr = String(r[0]);
        const [mm, dd, yyyy] = dateStr.split('/');
        const d = new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10)));
        if (isNaN(d.getTime())) continue;
        rows.push({
            date: d,
            orderNo: String(r[1] ?? ''),
            sku: String(r[3] ?? '').trim(),
            description: String(r[4] ?? '').replace(/&reg;|&trade;/g, '').trim(),
            qty: Number(r[5]) || 0,
            extPrice: Number(r[6]) || 0,
        });
    }

    if (rows.length === 0) {
        console.error('No order rows parsed — file layout may have changed.');
        process.exit(1);
    }

    // Aggregate by SKU; keep the most recent description (in case desc changed over time)
    const byS = new Map<string, SkuAggregate>();
    for (const r of rows) {
        const existing = byS.get(r.sku);
        if (!existing) {
            byS.set(r.sku, {
                sku: r.sku,
                description: r.description,
                totalQty: r.qty,
                totalSpend: r.extPrice,
                orderCount: 1,
                lastOrder: r.date,
                pack: parsePack(r.description),
                avgUnitPrice: 0,
                avgEaPriceIfParsed: null,
            });
        } else {
            existing.totalQty += r.qty;
            existing.totalSpend += r.extPrice;
            existing.orderCount += 1;
            if (r.date > existing.lastOrder) {
                existing.lastOrder = r.date;
                existing.description = r.description;
                existing.pack = parsePack(r.description);
            }
        }
    }

    const aggs = [...byS.values()];
    for (const a of aggs) {
        a.avgUnitPrice = a.totalQty > 0 ? a.totalSpend / a.totalQty : 0;
        a.avgEaPriceIfParsed = a.pack.units != null && a.pack.units > 0
            ? a.avgUnitPrice / a.pack.units
            : null;
    }

    aggs.sort((a, b) => b.totalSpend - a.totalSpend);

    const parsed = aggs.filter(a => a.pack.confidence === 'parsed');
    const unknown = aggs.filter(a => a.pack.confidence === 'unknown');

    console.log(`Unique SKUs: ${aggs.length}`);
    console.log(`Parsed pack size: ${parsed.length}  (${(parsed.length / aggs.length * 100).toFixed(0)}%)`);
    console.log(`Unknown:          ${unknown.length}  (need manual fill)\n`);

    if (parsed.length > 0) {
        console.log(`Top 10 by spend (auto-parsed):`);
        parsed.slice(0, 10).forEach(a => {
            console.log(`  ${a.sku.padEnd(10)}  ${String(a.pack.units).padStart(5)} ${a.pack.packUnit.padEnd(7)}  ` +
                `$${a.avgEaPriceIfParsed?.toFixed(3) ?? 'n/a'}/ea  ($${a.avgUnitPrice.toFixed(2)}/${a.pack.packUnit})  ${a.description.slice(0, 50)}`);
        });
        console.log();
    }

    if (unknown.length > 0) {
        console.log(`Top 10 by spend (UNKNOWN — need manual fill):`);
        unknown.slice(0, 10).forEach(a => {
            console.log(`  ${a.sku.padEnd(10)}  $${a.avgUnitPrice.toFixed(2)}/unit  ${a.description.slice(0, 70)}`);
        });
        console.log();
    }

    // Build migration file
    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const outPath = `supabase/migrations/${ts}_seed_uline_pack_sizes_bulk.sql`;

    const lines: string[] = [
        `-- ULINE pack-size bulk seed (auto-generated from MyOrderHistory.xlsx)`,
        `-- Run: node _run_migration.js ${outPath}`,
        `-- Generated: ${new Date().toISOString()}`,
        `-- Source: ${path.basename(filePath)}`,
        ``,
    ];

    if (parsed.length > 0) {
        lines.push(`-- ${parsed.length} SKUs with pack size parsed from description.`);
        lines.push(`-- Upsert (ON CONFLICT) so re-running is safe and existing seeds get refreshed.`);
        lines.push(`INSERT INTO sku_pack_sizes (sku, units_per_pack, pack_unit, ea_unit_price, source, notes) VALUES`);
        const valueLines = parsed.map((a, i) => {
            const trail = i === parsed.length - 1 ? '' : ',';
            const eaPrice = a.avgEaPriceIfParsed != null
                ? a.avgEaPriceIfParsed.toFixed(4)
                : 'NULL';
            return `    ('${escapeSql(a.sku)}', ${a.pack.units}, '${escapeSql(a.pack.packUnit)}', ${eaPrice}, 'uline_history', '${escapeSql(a.description.slice(0, 100))}')${trail}`;
        });
        lines.push(...valueLines);
        lines.push(`ON CONFLICT (sku) DO UPDATE SET`);
        lines.push(`    units_per_pack = EXCLUDED.units_per_pack,`);
        lines.push(`    pack_unit      = EXCLUDED.pack_unit,`);
        lines.push(`    ea_unit_price  = EXCLUDED.ea_unit_price,`);
        lines.push(`    source         = EXCLUDED.source,`);
        lines.push(`    notes          = EXCLUDED.notes,`);
        lines.push(`    updated_at     = NOW();`);
        lines.push(``);
    }

    if (unknown.length > 0) {
        lines.push(`-- ${unknown.length} SKUs with NO parseable pack size — fill in manually if needed`);
        lines.push(`-- Most likely 1/each (uline lists eaches by default for many items)`);
        lines.push(`-- Format: ('SKU', UNITS, 'UNIT', EA_PRICE_NULL_OR_NUM, 'uline_manual', 'NOTE')`);
        for (const a of unknown.slice(0, 50)) {
            lines.push(`-- ${a.sku.padEnd(10)} avg $${a.avgUnitPrice.toFixed(2)}/unit  desc="${escapeSql(a.description.slice(0, 80))}"`);
        }
        if (unknown.length > 50) {
            lines.push(`-- ...and ${unknown.length - 50} more (showing top 50 by spend)`);
        }
        lines.push(``);
    }

    fs.writeFileSync(outPath, lines.join('\n'));
    console.log(`✅ Migration written: ${outPath}`);
    console.log(`   Apply: node _run_migration.js ${outPath}`);
    console.log(`   Then: pm2 restart aria-bot && pm2 reload aria-dashboard\n`);
}

main().catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
});
