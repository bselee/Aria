/**
 * @file    reconcile-fedex.ts
 * @purpose Reconcile FedEx billing CSV against Finale POs — identify and add missing freight charges.
 *          Parses FedEx Billing Online CSV exports, matches entries to Finale POs by PO reference,
 *          uses FedEx Track API to resolve unmatched COLLECT entries by origin city, and adds
 *          missing COLLECT freight charges.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-03-16
 * @deps    dotenv, FinaleClient
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH,
 *          FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT_NUMBER
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-fedex.ts                        # Auto-find latest CSV in Sandbox
 *   node --import tsx src/cli/reconcile-fedex.ts --csv path/to/file.csv # Specify CSV
 *   node --import tsx src/cli/reconcile-fedex.ts --dry-run              # Show diffs without saving
 *   node --import tsx src/cli/reconcile-fedex.ts --report-only          # Just report, no updates
 *
 * DECISION(2026-03-16): Built after discovering 5+ POs with missing FedEx COLLECT freight
 * totaling $3,700+. FedEx has no billing API — CSV export is the correct data source.
 * FedEx Track API supplements with tracking→origin city→vendor matching for
 * entries lacking PO references.
 *
 * DECISION(2026-03-16): Rootwise ships multiple FedEx Freight deliveries against a
 * single PO. Each delivery gets its own freight line item on the PO.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';
import { upsertVendorInvoice } from '../lib/storage/vendor-invoices';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
const FREIGHT_PROMO = '/buildasoilorganics/api/productpromo/10007';
const FINALE_ACCOUNT = 'buildasoilorganics';

// 6-digit Finale PO number regex
const FINALE_PO_RE = /\b(\d{6})\b/;

// Vendors to exclude from freight matching (special shipping arrangements)
const EXCLUDE_VENDORS = ['grokashi'];

// DECISION(2026-03-16): Known vendor → origin city/state mapping for FedEx Track matching.
// Built from analysis of actual FedEx shipments. Add new vendors as identified.
const VENDOR_ORIGIN_MAP: Record<string, { city: string; state: string; vendor: string }> = {
    'evergreen_co': { city: 'EVERGREEN', state: 'CO', vendor: 'Rootwise Soil Dynamics' },
    'laytonville_ca': { city: 'LAYTONVILLE', state: 'CA', vendor: 'Grokashi' },
    'missoula_mt': { city: 'MISSOULA', state: 'MT', vendor: 'Granite Mill' },
};

// ── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const csvArgIdx = args.indexOf('--csv');
const csvPath = csvArgIdx >= 0 ? args[csvArgIdx + 1] : null;
const DRY_RUN = args.includes('--dry-run');
const REPORT_ONLY = args.includes('--report-only');

// ── CSV Parser ────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
        else current += ch;
    }
    fields.push(current.trim());
    return fields;
}

interface FedExEntry {
    shipDate: string;
    invoiceNumber: string;
    amtDue: number;
    poNumber: string;
    refNum: string;
    terms: string;
    shipFrom: string;
    shipTo: string;
    shipFromZip: string;
    shipToZip: string;
}

function parseFedExCSV(filePath: string): FedExEntry[] {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n');
    const headers = lines[0].replace(/"/g, '').split(',');
    const col = (name: string) => headers.indexOf(name);

    const seen = new Set<string>();
    const entries: FedExEntry[] = [];

    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const f = parseCsvLine(lines[i]);
        if (f[col('TEMPLATE_TYPE')] !== 'INVHDR') continue;
        const invNum = f[col('INVOICE_NUMBER')] || '';
        if (seen.has(invNum)) continue;
        seen.add(invNum);

        entries.push({
            shipDate: f[col('SHIP_DATE')] || '',
            invoiceNumber: invNum,
            amtDue: parseFloat((f[col('AMT_DUE')] || '0').replace(/,/g, '')),
            poNumber: f[col('PO_NUMBER')] || '',
            refNum: f[col('REF_NUM')] || '',
            terms: f[col('TERMS')] || '',
            shipFrom: f[col('SHIP_FROM_NAME')] || '',
            shipTo: f[col('SHIPPING_NAME')] || '',
            shipFromZip: f[col('SHIP_FROM_ZIP')] || '',
            shipToZip: f[col('SHIP_TO_ZIP')] || '',
        });
    }

    return entries;
}

// ── FedEx Track API ───────────────────────────────────────────────────────────

const FEDEX_AUTH_URL = 'https://apis.fedex.com/oauth/token';
const FEDEX_TRACK_URL = 'https://apis.fedex.com/track/v1/trackingnumbers';

interface TrackResult {
    trackingNumber: string;
    shipperCity: string;
    shipperState: string;
    shipperCompany: string;
    recipientCity: string;
    recipientState: string;
    weight: number;
    deliveryDate: string;
    serviceType: string;
    matchedVendor: string | null;
}

async function getFedExToken(): Promise<string> {
    const clientId = process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET must be set');
    }

    const res = await fetch(FEDEX_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });

    if (!res.ok) throw new Error(`FedEx auth failed (${res.status})`);
    const data = await res.json();
    return data.access_token;
}

async function trackShipment(token: string, trackingNumber: string): Promise<TrackResult> {
    const res = await fetch(FEDEX_TRACK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-locale': 'en_US',
        },
        body: JSON.stringify({
            includeDetailedScans: false,
            trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
        }),
    });

    if (!res.ok) throw new Error(`FedEx track failed (${res.status})`);
    const data = await res.json();
    const track = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];

    if (!track) throw new Error('No tracking result returned');

    const city = (track.shipperInformation?.address?.city || '').toUpperCase();
    const state = (track.shipperInformation?.address?.stateOrProvinceCode || '').toUpperCase();
    const key = `${city.toLowerCase().replace(/\s+/g, '_')}_${state.toLowerCase()}`;
    const matchedVendor = VENDOR_ORIGIN_MAP[key]?.vendor || null;

    const weight = track.packageDetails?.weightAndDimensions?.weight?.[0];
    const delDate = track.dateAndTimes?.find((d: any) => d.type === 'ACTUAL_DELIVERY')?.dateTime || '';

    return {
        trackingNumber,
        shipperCity: city,
        shipperState: state,
        shipperCompany: track.shipperInformation?.contact?.companyName || '',
        recipientCity: track.recipientInformation?.address?.city || '',
        recipientState: track.recipientInformation?.address?.stateOrProvinceCode || '',
        weight: weight?.value || 0,
        deliveryDate: delDate.split('T')[0],
        serviceType: track.serviceDetail?.description || track.serviceDetail?.type || '',
        matchedVendor,
    };
}

// ── Matching Logic ────────────────────────────────────────────────────────────

interface MatchResult {
    fedex: FedExEntry;
    finalePoId: string | null;
    matchSource: 'po_ref' | 'track_api' | 'unmatched';
    trackInfo?: TrackResult;
    freightAlreadyOnPO: boolean;
    freightAdded: boolean;
    error?: string;
}

function findCorrelatedReception(po: any, dateStr: string): string | null {
    if (!po?.shipments || po.shipments.length === 0) return null;
    const targetMs = new Date(dateStr).getTime();
    if (isNaN(targetMs)) return null;

    for (const sh of po.shipments) {
        if (!sh.receiveDate) continue;
        const recMs = new Date(sh.receiveDate).getTime();
        const diffDays = Math.abs(targetMs - recMs) / 86400000;
        if (diffDays <= 4) { // within 4 days (covers 2-3 days + weekend leeway)
            return `Rec ${sh.shipmentId} on ${sh.receiveDate}`;
        }
    }
    return null;
}

function extractFinalePoId(entry: FedExEntry): string | null {
    const match = entry.poNumber.match(FINALE_PO_RE) || entry.refNum.match(FINALE_PO_RE);
    return match ? match[1] : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n╔═══════════════════════════════════════════════╗`);
    console.log(`║    FedEx Freight → Finale PO Reconciliation   ║`);
    console.log(`╚═══════════════════════════════════════════════╝\n`);
    console.log(`Mode: ${REPORT_ONLY ? '📊 REPORT ONLY' : DRY_RUN ? '🔵 DRY RUN' : '🔴 LIVE UPDATE'}\n`);

    // --- Step 1: Find and parse FedEx CSV ---
    let targetCsv = csvPath;
    if (!targetCsv) {
        const files = fs.readdirSync(SANDBOX_DIR)
            .filter(f => f.startsWith('FEDEX') && f.endsWith('.csv'))
            .sort()
            .reverse();
        if (files.length === 0) {
            console.error('❌ No FEDEX*.csv files found in', SANDBOX_DIR);
            console.error('   Download from: https://www.fedex.com/billing/');
            process.exit(1);
        }
        targetCsv = path.join(SANDBOX_DIR, files[0]);
    }

    if (!fs.existsSync(targetCsv)) {
        console.error('❌ CSV not found:', targetCsv);
        process.exit(1);
    }

    console.log(`📄 CSV: ${path.basename(targetCsv)}`);
    const entries = parseFedExCSV(targetCsv);
    console.log(`📦 Total unique FedEx invoices: ${entries.length}\n`);

    // Archive all FedEx entries into vendor_invoices
    console.log(`📦 Archiving FedEx invoices to vendor_invoices...`);
    let archived = 0;
    for (const e of entries) {
        try {
            await upsertVendorInvoice({
                vendor_name: 'FedEx',
                invoice_number: e.invoiceNumber,
                invoice_date: e.shipDate
                    ? e.shipDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')
                    : null,
                total: e.amtDue,
                freight: e.amtDue,
                po_number: extractFinalePoId(e) || null,
                status: 'received',
                source: 'csv_import',
                source_ref: `fedex-csv-${path.basename(targetCsv)}`,
                notes: `Terms: ${e.terms} | From: ${e.shipFrom} → ${e.shipTo}`,
                raw_data: e as unknown as Record<string, unknown>,
            });
            archived++;
        } catch { /* dedup collision is fine */ }
    }
    console.log(`✅ Archived ${archived}/${entries.length} FedEx invoices\n`);

    // --- Step 2: Categorize entries ---
    const collectEntries = entries.filter(e => e.terms === 'COLLECT');
    const prepaidEntries = entries.filter(e => e.terms === 'PREPAID');
    const otherEntries = entries.filter(e => !['COLLECT', 'PREPAID'].includes(e.terms));

    console.log(`📊 Breakdown:`);
    console.log(`   COLLECT (BAS pays):  ${collectEntries.length} invoices — $${collectEntries.reduce((s, e) => s + e.amtDue, 0).toFixed(2)}`);
    console.log(`   PREPAID (vendor pays): ${prepaidEntries.length} invoices — $${prepaidEntries.reduce((s, e) => s + e.amtDue, 0).toFixed(2)}`);
    if (otherEntries.length > 0) {
        console.log(`   OTHER: ${otherEntries.length} invoices — $${otherEntries.reduce((s, e) => s + e.amtDue, 0).toFixed(2)}`);
    }

    // --- Step 3: Match COLLECT entries to Finale POs ---
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`COLLECT Freight Reconciliation (${collectEntries.length} entries)`);
    console.log(`${'═'.repeat(60)}\n`);

    const finale = new FinaleClient();
    const results: MatchResult[] = [];

    console.log(`Fetching recent POs for reception correlation...`);
    let allPOs: any[] = [];
    try {
        allPOs = await finale.getRecentPurchaseOrders(400);
        console.log(`✅ Loaded ${allPOs.length} POs\n`);
    } catch {
        console.log(`⚠️ Failed to fetch POs for correlation\n`);
    }

    const withPoRef: { fedex: FedExEntry; poId: string }[] = [];
    const withoutPoRef: FedExEntry[] = [];

    for (const e of collectEntries) {
        const poId = extractFinalePoId(e);
        if (poId) {
            withPoRef.push({ fedex: e, poId });
        } else {
            withoutPoRef.push(e);
        }
    }

    console.log(`✅ With PO reference: ${withPoRef.length}`);
    console.log(`❓ Without PO reference: ${withoutPoRef.length}\n`);

    // --- Process entries WITH PO references ---
    if (withPoRef.length > 0) {
        console.log(`── Matched by PO Reference ──\n`);

        for (const { fedex, poId } of withPoRef) {
            const result: MatchResult = {
                fedex,
                finalePoId: poId,
                matchSource: 'po_ref',
                freightAlreadyOnPO: false,
                freightAdded: false,
            };

            try {
                const po = await finale.getOrderDetails(poId);
                const vendor = po.supplierName || po.orderSourceName || '';

                if (EXCLUDE_VENDORS.some(ex => vendor.toLowerCase().includes(ex))) {
                    console.log(`⏭️  PO ${poId} — ${vendor} (excluded)`);
                    results.push(result);
                    continue;
                }

                // Check for existing freight with THIS specific FedEx invoice
                const existingAdj = po.orderAdjustmentList || [];
                const existingThisInv = existingAdj.filter(
                    (a: any) => (a.description || '').includes(fedex.invoiceNumber)
                );
                const existingFreight = existingAdj.filter(
                    (a: any) => (a.description || '').toLowerCase().includes('freight')
                );

                if (existingThisInv.length > 0) {
                    result.freightAlreadyOnPO = true;
                    const existingAmt = existingFreight.reduce(
                        (s: number, a: any) => s + (a.amount || 0), 0
                    );
                    console.log(`✅ PO ${poId} | $${fedex.amtDue.toFixed(2)} | Already has this freight | ${vendor}`);
                } else if (REPORT_ONLY || DRY_RUN) {
                    console.log(`🔵 PO ${poId} | $${fedex.amtDue.toFixed(2)} | ${DRY_RUN ? 'WOULD ADD' : 'NEEDS'} freight | ${vendor} | FedEx ${fedex.invoiceNumber}`);
                } else {
                    let memo = '';
                    const cachedPo = allPOs.find((p: any) => p.orderId === poId);
                    if (cachedPo) {
                        const corr = findCorrelatedReception(cachedPo, fedex.shipDate);
                        if (corr) memo = ` — ${corr}`;
                    }

                    // Add freight — use unique label per delivery
                    const label = `FedEx Collect Freight — Inv ${fedex.invoiceNumber} (${fedex.shipDate})${memo}`;
                    await addFreightToPO(finale, poId, fedex.amtDue, label, po);
                    result.freightAdded = true;
                    console.log(`✅ PO ${poId} | $${fedex.amtDue.toFixed(2)} | ADDED freight | ${vendor} | FedEx ${fedex.invoiceNumber}${memo ? ` | ${memo}` : ''}`);
                }
            } catch (err: any) {
                result.error = err.message;
                console.log(`❌ PO ${poId} | $${fedex.amtDue.toFixed(2)} | Error: ${err.message.substring(0, 60)}`);
            }

            results.push(result);
        }
    }

    // --- Track API matching for entries WITHOUT PO references ---
    if (withoutPoRef.length > 0) {
        console.log(`\n── Resolving Unmatched via FedEx Track API ──\n`);

        let token: string | null = null;
        try {
            token = await getFedExToken();
            console.log('✅ FedEx API authenticated\n');
        } catch (err: any) {
            console.log(`⚠️  FedEx API auth failed: ${err.message}`);
            console.log('   Falling back to manual report\n');
        }

        for (const fedex of withoutPoRef) {
            const result: MatchResult = {
                fedex,
                finalePoId: null,
                matchSource: 'unmatched',
                freightAlreadyOnPO: false,
                freightAdded: false,
            };

            if (token) {
                try {
                    const track = await trackShipment(token, fedex.invoiceNumber);
                    result.trackInfo = track;

                    const vendorName = track.matchedVendor;
                    const originLabel = `${track.shipperCity}, ${track.shipperState}`;

                    if (vendorName) {
                        result.matchSource = 'track_api';

                        // Find vendor POs near this delivery date without this freight
                        const delDate = new Date(track.deliveryDate);
                        const vendorPOs = allPOs.filter(po => {
                            if (!po.vendorName.toLowerCase().includes(vendorName.split(' ')[0].toLowerCase())) return false;
                            
                            // Check shipments proximity
                            if (po.shipments && po.shipments.length > 0) {
                                for (const shipment of po.shipments) {
                                    if (shipment.receiveDate) {
                                        const recDate = new Date(shipment.receiveDate);
                                        const recDiff = Math.abs((delDate.getTime() - recDate.getTime()) / 86400000);
                                        if (recDiff <= 4) return true; // Matches reception
                                    }
                                }
                            }

                            // Fallback to orderDate
                            const poDate = new Date(po.orderDate);
                            const daysDiff = (delDate.getTime() - poDate.getTime()) / 86400000;
                            return daysDiff >= -3 && daysDiff <= 45;
                        });

                        if (vendorPOs.length === 0) {
                            console.log(`📍 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | ⚠️ No matching PO found`);
                        } else {
                            // Check each PO for existing freight with this invoice
                            let matched = false;
                            for (const po of vendorPOs) {
                                try {
                                    const details = await finale.getOrderDetails(po.orderId);
                                    const adj = details.orderAdjustmentList || [];
                                    const hasThisInv = adj.some((a: any) => (a.description || '').includes(fedex.invoiceNumber));

                                    if (hasThisInv) {
                                        result.finalePoId = po.orderId;
                                        result.freightAlreadyOnPO = true;
                                        console.log(`✅ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} already has freight`);
                                        matched = true;
                                        break;
                                    }

                                    // If PO has no freight at all, it's a candidate
                                    const hasAnyFreight = adj.some((a: any) =>
                                        (a.description || '').toLowerCase().includes('freight')
                                    );

                                    if (!hasAnyFreight || vendorName.includes('Rootwise')) {
                                        // Rootwise can have multiple freight entries per PO
                                        result.finalePoId = po.orderId;

                                        if (REPORT_ONLY || DRY_RUN) {
                                            console.log(`🔵 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} | ${DRY_RUN ? 'WOULD ADD' : 'NEEDS freight'}`);
                                        } else {
                                            let memo = '';
                                            const corr = findCorrelatedReception(po, track.deliveryDate);
                                            if (corr) memo = ` — ${corr}`;

                                            const label = `FedEx Collect Freight — Inv ${fedex.invoiceNumber} (${fedex.shipDate})${memo}`;
                                            await addFreightToPO(finale, po.orderId, fedex.amtDue, label, details);
                                            result.freightAdded = true;
                                            console.log(`✅ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} | ADDED freight${memo ? ` | ${memo}` : ''}`);
                                        }
                                        matched = true;
                                        break;
                                    }
                                } catch {
                                    // Skip erroring POs
                                }
                            }
                            if (!matched) {
                                console.log(`📍 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | All candidate POs already have freight`);
                            }
                        }
                    } else {
                        console.log(`❓ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} | Weight: ${track.weight} lbs | Unknown vendor`);
                    }

                    // Rate limit courtesy
                    await new Promise(r => setTimeout(r, 300));
                } catch (err: any) {
                    console.log(`❌ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | Track error: ${err.message.substring(0, 60)}`);
                }
            } else {
                console.log(`❓ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${fedex.shipDate} | No Track API available`);
            }

            results.push(result);
        }
    }

    // --- Summary ---
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`SUMMARY`);
    console.log(`${'═'.repeat(60)}\n`);

    const matched = results.filter(r => r.finalePoId);
    const unmatched = results.filter(r => !r.finalePoId);
    const alreadyHad = results.filter(r => r.freightAlreadyOnPO);
    const added = results.filter(r => r.freightAdded);
    const errors = results.filter(r => r.error);
    const trackMatched = results.filter(r => r.matchSource === 'track_api');
    const needsAdding = matched.filter(r => !r.freightAlreadyOnPO && !r.freightAdded && !r.error);

    console.log(`📦 Total COLLECT entries: ${collectEntries.length} ($${collectEntries.reduce((s, e) => s + e.amtDue, 0).toFixed(2)})`);
    console.log(`✅ Matched to PO:        ${matched.length} (${withPoRef.length} by PO ref, ${trackMatched.length} by Track API)`);
    console.log(`   Already had freight:  ${alreadyHad.length}`);
    console.log(`   Freight added:        ${added.length} ($${added.reduce((s, r) => s + r.fedex.amtDue, 0).toFixed(2)})`);
    if (needsAdding.length > 0) {
        console.log(`   Needs freight added:  ${needsAdding.length} ($${needsAdding.reduce((s, r) => s + r.fedex.amtDue, 0).toFixed(2)})`);
    }
    if (errors.length > 0) {
        console.log(`   Errors:               ${errors.length}`);
    }
    console.log(`❓ Unmatched:            ${unmatched.length} ($${unmatched.reduce((s, r) => s + r.fedex.amtDue, 0).toFixed(2)})`);

    if (unmatched.length > 0) {
        console.log(`\n   Unmatched entries (need manual review):`);
        for (const r of unmatched) {
            const origin = r.trackInfo
                ? `${r.trackInfo.shipperCity}, ${r.trackInfo.shipperState} (${r.trackInfo.weight} lbs)`
                : r.fedex.shipFromZip;
            console.log(`     ${r.fedex.shipDate} | $${r.fedex.amtDue.toFixed(2)} | ${r.fedex.invoiceNumber} | ${origin}`);
        }
    }

    if (prepaidEntries.length > 0) {
        console.log(`\n📋 PREPAID entries (vendor-paid, for reference):`);
        console.log(`   ${prepaidEntries.length} invoices totaling $${prepaidEntries.reduce((s, e) => s + e.amtDue, 0).toFixed(2)}`);
        console.log(`   These are included in vendor invoice pricing — no action needed.`);
    }

    // Save audit report
    const reportPath = path.join(SANDBOX_DIR, 'fedex-reconcile-report.json');
    const report = {
        runDate: new Date().toISOString(),
        csvFile: path.basename(targetCsv),
        mode: REPORT_ONLY ? 'report' : DRY_RUN ? 'dry-run' : 'live',
        summary: {
            totalEntries: entries.length,
            collectEntries: collectEntries.length,
            collectTotal: collectEntries.reduce((s, e) => s + e.amtDue, 0),
            matched: matched.length,
            matchedByPoRef: withPoRef.length,
            matchedByTrackApi: trackMatched.length,
            unmatched: unmatched.length,
            freightAdded: added.length,
            freightAddedTotal: added.reduce((s, r) => s + r.fedex.amtDue, 0),
        },
        results: results.map(r => ({
            fedexInvoice: r.fedex.invoiceNumber,
            shipDate: r.fedex.shipDate,
            amount: r.fedex.amtDue,
            terms: r.fedex.terms,
            poRef: r.fedex.poNumber,
            finalePoId: r.finalePoId,
            matchSource: r.matchSource,
            freightAlreadyOnPO: r.freightAlreadyOnPO,
            freightAdded: r.freightAdded,
            trackInfo: r.trackInfo ? {
                shipperCity: r.trackInfo.shipperCity,
                shipperState: r.trackInfo.shipperState,
                weight: r.trackInfo.weight,
                deliveryDate: r.trackInfo.deliveryDate,
                matchedVendor: r.trackInfo.matchedVendor,
            } : undefined,
            error: r.error,
        })),
    };

    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved: ${reportPath}`);
}

/**
 * Add a freight adjustment to a PO, handling multiple freight entries per PO.
 * Uses direct POST to append (not replace) existing freight lines.
 */
async function addFreightToPO(
    finale: FinaleClient,
    poId: string,
    amount: number,
    label: string,
    existingPO?: any
): Promise<void> {
    const po = existingPO || await finale.getOrderDetails(poId);
    const originalStatus = await finale.unlockForEditing(po, poId);

    const adjustments = [...(po.orderAdjustmentList || [])];
    adjustments.push({
        amount,
        description: label,
        productPromoUrl: FREIGHT_PROMO,
    });

    const encodedId = encodeURIComponent(poId);
    await (finale as any).post(
        `/${FINALE_ACCOUNT}/api/order/${encodedId}`,
        { ...po, orderAdjustmentList: adjustments }
    );

    await finale.restoreOrderStatus(poId, originalStatus);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
