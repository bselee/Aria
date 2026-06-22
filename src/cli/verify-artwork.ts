/**
 * @file    src/cli/verify-artwork.ts
 * @purpose CLI to verify artwork in Dash matches Finale SKU before ordering.
 *          Usage:
 *            First-time auth:  npx tsx src/cli/verify-artwork.ts --auth
 *            Verify SKU:       npx tsx src/cli/verify-artwork.ts CRAFT4
 *            Batch verify:     npx tsx src/cli/verify-artwork.ts CRAFT4 PU100 GNS16
 * @author  Hermia
 * @created 2026-06-22
 * @deps    src/lib/dash/client.ts
 * @env     DASH_CLIENT_ID, DASH_CLIENT_SECRET
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { getDashConfig, getAccessToken, verifyArtworkForSku, buildAuthUrl, parseDashFilename, searchAssetsByFilename, getAssetById, downloadAssetFile } from '../lib/dash/client';
import { buildAssetIndex, formatCorrelationReport } from '../lib/dash/asset-index';
import { verifyBarcode } from '../lib/dash/barcode-check';
import { getBarcodeForSku, barcodeMatches } from '../lib/dash/barcode-registry';

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help')) {
        console.log(`
Usage: npx tsx src/cli/verify-artwork.ts [options] [SKU...]

Options:
  --auth          First-time authentication (opens browser)
  --code=X        Exchange auth code for token
  --list [sku]    List all Dash assets matching SKU (detailed)
  --barcode [sku] Read barcode from print-ready art in Dash
  --build-index   Build full asset index and correlation report
  --help          Show this help

Examples:
  npx tsx src/cli/verify-artwork.ts --auth
  npx tsx src/cli/verify-artwork.ts CRAFT4
  npx tsx src/cli/verify-artwork.ts CRAFT4 PU100 GNS16
  npx tsx src/cli/verify-artwork.ts --list CRAFT4
  npx tsx src/cli/verify-artwork.ts --build-index
`);
        return;
    }

    const config = getDashConfig();
    let token: string;

    if (args.includes('--auth')) {
        const url = buildAuthUrl(config);
        console.log('\nOpen this URL in your browser to authorize Aria with Dash:\n');
        console.log('  ' + url + '\n');
        console.log('After authorizing, you will be redirected to a callback URL.');
        console.log('Copy the "code" parameter from the URL and run:\n');
        console.log('  npx tsx src/cli/verify-artwork.ts --code=YOUR_CODE\n');
        return;
    }

    const codeArg = args.find(a => a.startsWith('--code='));
    if (codeArg) {
        const code = codeArg.split('=')[1];
        token = await getAccessToken(config, code);
        console.log('✓ Authentication successful. Token cached for future use.\n');
        return;
    }

    // Normal mode — verify SKUs
    token = await getAccessToken(config);

    // Build full index mode
    if (args.includes('--build-index')) {
        console.log('Scanning all Dash assets and cross-referencing with known SKUs...\n');
        const index = await buildAssetIndex(token);
        console.log(formatCorrelationReport(index));
        return;
    }

    const skus = args.filter(a => !a.startsWith('--'));
    const isListMode = args.includes('--list');
    const isBarcodeCheck = args.includes('--barcode');

    for (const sku of skus) {
        console.log(`\n=== ${sku} ===`);

        if (isListMode) {
            const assets = await searchAssetsByFilename(token, sku, 20);
            if (assets.length === 0) {
                console.log('  No assets found.');
                continue;
            }
            for (const asset of assets) {
                const p = parseDashFilename(asset.filename);
                console.log(`  ${asset.filename}`);
                console.log(`    ID: ${asset.id}`);
                console.log(`    SKU match: ${p.skuMatch || '—'}`);
                console.log(`    Size: ${p.sizeMatch || '—'}`);
                console.log(`    Print ready: ${p.isPrintReady ? '✓' : '—'}`);
                console.log(`    Status: ${asset.lifecycleStatus}`);
                console.log(`    Modified: ${asset.dateLastModified || '—'}`);
            }
        } else {
            const result = await verifyArtworkForSku(token, sku);
            if (result.verified) {
                console.log(`  ✓ ${result.message}`);
                for (const asset of result.assets) {
                    const p = parseDashFilename(asset.filename);
                    console.log(`    · ${asset.filename}`);
                    if (p.sizeMatch) console.log(`      Size: ${p.sizeMatch}`);
                }
            } else {
                console.log(`  ✗ ${result.message}`);
                if (result.assets.length > 0) {
                    for (const asset of result.assets) {
                        console.log(`    · ${asset.filename}`);
                    }
                }
            }
        }

        // Barcode check mode
        if (isBarcodeCheck) {
            const result = await verifyArtworkForSku(token, sku);
            const printReady = result.assets;
            if (printReady.length === 0) {
                console.log('  ✗ No print-ready assets to check barcode on.');
                continue;
            }
            const expected = getBarcodeForSku(sku);
            if (!expected) {
                console.log('  ? No barcode registered for this SKU in the official barcode database.');
                console.log('    Add it to src/lib/dash/barcode-registry.ts from the OfficialBarcodes.xlsx spreadsheet.');
            }
            for (const asset of printReady.slice(0, 3)) {
                console.log(`  Checking barcode on: ${asset.filename.substring(0, 50)}...`);
                const buffer = await downloadAssetFile(token, asset);
                if (!buffer) {
                    console.log('    Could not download file.');
                    continue;
                }
                const barcodeResult = await verifyBarcode(buffer, asset.filename, expected || '', sku);
                if (barcodeResult.barcode) {
                    const match = expected ? (barcodeMatches(sku, barcodeResult.barcode) ? '✓ MATCH' : '✗ MISMATCH') : '?';
                    console.log(`    Barcode: ${barcodeResult.barcode} ${match}`);
                    if (match === '✗ MISMATCH') {
                        console.log(`    Expected: ${expected} but art has ${barcodeResult.normalizedMatch ? 'correct number' : 'different number'}`);
                    }
                    if (expected) {
                        console.log(`    Expected: ${expected}`);
                    }
                } else {
                    console.log('    No barcode detected in file.');
                }
            }
        }
    }
}

main().catch(err => {
    console.error('\nError:', err.message);
    process.exit(1);
});
