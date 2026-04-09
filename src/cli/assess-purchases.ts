/**
 * assess-purchases.ts — Cross-reference scraped purchasing suggestions AND pending purchase requests
 *
 * TWO INPUTS:
 *   1. purchases-data.json (scraped from basauto.vercel.app/purchases) — vendor suggestions
 *   2. purchase-requests.json (scraped from Purchase Request Form) — team requests
 *
 * For each SKU from purchases tab: queries Finale for stock, sales velocity, open POs, lead time,
 * then ranks items by genuine need (HIGH_NEED / MEDIUM / LOW / NOISE).
 *
 * For each Pending request: fuzzy-matches the details string to a Finale SKU (reuses Slack watchdog's
 * Fuse.js pattern), queries Finale, and classifies the same way. Filters to status === 'Pending' only.
 *
 * Output distinguishes between: VENDOR_SUGGESTION vs TEAM_REQUEST source.
 *
 * Usage:
 *   node --import tsx src/cli/assess-purchases.ts
 *   node --import tsx src/cli/assess-purchases.ts --json          # Machine-readable output
 *   node --import tsx src/cli/assess-purchases.ts --vendor ULINE  # Filter purchases to one vendor
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as fs from 'fs';
import * as path from 'path';
import { assess, printAssessment, ScrapedData, RawRequestsData } from '@/lib/purchases/assessor';

// ── Types ── (use library types where possible)

interface PurchaseRequest {
    date: string;
    department: string;
    type: 'Existing product' | 'New product';
    details: string;
    quantity: string;
    link: string;
    status: string;
    ordered: string;
}

// ── Main ──

async function main() {
    const args = process.argv.slice(2);
    const jsonOutput = args.includes('--json');
    const vendorFilterIdx = args.indexOf('--vendor');
    const vendorFilter = vendorFilterIdx >= 0 ? args[vendorFilterIdx + 1]?.toLowerCase() : null;

    // Load scraped data
    const dataPath = path.resolve(__dirname, '../../purchases-data.json');
    if (!fs.existsSync(dataPath)) {
        console.error(`purchases-data.json not found at ${dataPath}`);
        process.exit(1);
    }
    const scrapedData: ScrapedData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

    // Load requests data if exists
    let requestsData: RawRequestsData | undefined;
    const requestsPath = path.resolve(__dirname, '../../purchase-requests.json');
    if (fs.existsSync(requestsPath)) {
        requestsData = JSON.parse(fs.readFileSync(requestsPath, 'utf-8'));
    }

    const result = await assess({
        scrapedData,
        requestsData,
        vendorFilter,
        daysBack: 90,
    });

    if (jsonOutput) {
        console.log(JSON.stringify(result.vendorAssessments));
        process.exit(0);
    }

    printAssessment(result);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});