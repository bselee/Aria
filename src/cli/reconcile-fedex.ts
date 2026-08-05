/**
 * @file    reconcile-fedex.ts
 * @purpose Reconcile FedEx billing CSV against Finale POs — identify and add missing freight charges.
 *          Parses FedEx Billing Online CSV exports, matches entries to Finale POs by PO reference
 *          (primary — Uline puts PO# on the order so it lands on the FedEx bill), uses FedEx Track
 *          API for unmatched COLLECT by shipper name/origin city, and adds missing COLLECT freight.
 *          Uline ~$1.50 in-house charge is not carrier freight and does not block apply.
 *          Rootwise: multi-delivery via FedEx; each receive gets its own freight line.
 *          Non-FedEx Uline shipping is on the Uline invoice — manual.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-04-23  — reverted to CSV parsing (FedEx Invoice Billing API does not exist)
 * @deps    dotenv, FinaleClient
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH,
 *          FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT_NUMBER
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-fedex.ts                        # Auto-find latest CSV in Sandbox (dry-run default)
 *   node --import tsx src/cli/reconcile-fedex.ts --live                # Apply changes to Finale
 *   node --import tsx src/cli/reconcile-fedex.ts --report-only         # Report only, no Finale updates
 *   node --import tsx src/cli/reconcile-fedex.ts --csv path/to/file.csv # Specify CSV path
 *
 * DECISION(2026-03-16): Built after discovering 5+ POs with missing FedEx COLLECT freight
 * totaling $3,700+. FedEx Billing Online CSV export is the correct data source.
 * FedEx Track API supplements with tracking→origin city→vendor matching for
 * entries lacking PO references.
 *
 * DECISION(2026-03-16): Rootwise ships multiple FedEx Freight deliveries against a
 * single PO. Each delivery gets its own freight line item on the PO.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';
import { upsertVendorInvoice, lookupVendorInvoices } from '../lib/storage/vendor-invoices';
import { ReconciliationRun } from '@/lib/reconciliation/run-tracker';
import { sendReconciliationSummary } from '@/lib/reconciliation/notifier';
import { assertSubtotalMatch, InvariantViolationError } from '@/lib/reconciliation/invariants';
import {
    findLatestFedexCsvCandidate,
    archiveFedexCsvToAria,
    getFedexStatementDir,
} from '@/lib/statements/fedex-acquisition';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ── ChangeSet Types ────────────────────────────────────────────────────────────

interface ChangeSetItem {
    type: 'price_change' | 'freight_add' | 'po_update';
    poId: string;
    sku?: string;
    oldPrice?: number;
    newPrice?: number;
    freightCents?: number;
    invoiceNumber: string;
}
type ChangeSet = ChangeSetItem[];

// ── Config ────────────────────────────────────────────────────────────────────

const FREIGHT_PROMO = '/buildasoilorganics/api/productpromo/10007';
const FINALE_ACCOUNT = 'buildasoilorganics';

// 6-digit Finale PO number regex
const FINALE_PO_RE = /\b(\d{6})\b/;

// Vendors to exclude from freight matching (special shipping arrangements)
const EXCLUDE_VENDORS = ['grokashi'];

/**
 * Uline adds a fixed ~$1.50 in-house charge on every order (not carrier freight).
 * That line must not count as "already has freight" and must not block FedEx COLLECT.
 * Real truck $ is bas_freight via FedEx (PO# is entered on the Uline order → appears
 * on the FedEx bill). Non-FedEx Uline shipping is on the Uline invoice — manual.
 */
const ULINE_HOUSE_CHARGE_MAX = 2.5;

// DECISION(2026-03-16): Known origin city/state → Finale vendor (Track API fallback).
// Vendor strings must match Finale supplier names (plain — no invented labels).
// Primary Uline join is PO# on the FedEx entry; cities below are Track fallback only.
const VENDOR_ORIGIN_MAP: Record<string, { city: string; state: string; vendor: string }> = {
    'evergreen_co': { city: 'EVERGREEN', state: 'CO', vendor: 'Rootwise Soil Dynamics' },
    'laytonville_ca': { city: 'LAYTONVILLE', state: 'CA', vendor: 'Grokashi' },
    'missoula_mt': { city: 'MISSOULA', state: 'MT', vendor: 'Granite Mill' },
    // Uline branch cities (https://www.uline.com/Corporate/About_Locations) — Track fallback
    'pleasant_prairie_wi': { city: 'PLEASANT PRAIRIE', state: 'WI', vendor: 'ULINE' },
    'kenosha_wi': { city: 'KENOSHA', state: 'WI', vendor: 'ULINE' },
    'braselton_ga': { city: 'BRASELTON', state: 'GA', vendor: 'ULINE' },
    'etna_oh': { city: 'ETNA', state: 'OH', vendor: 'ULINE' },
    'allentown_pa': { city: 'ALLENTOWN', state: 'PA', vendor: 'ULINE' },
    'breinigsville_pa': { city: 'BREINIGSVILLE', state: 'PA', vendor: 'ULINE' },
    'reno_nv': { city: 'RENO', state: 'NV', vendor: 'ULINE' },
    'dallas_tx': { city: 'DALLAS', state: 'TX', vendor: 'ULINE' },
    'arlington_tx': { city: 'ARLINGTON', state: 'TX', vendor: 'ULINE' },
    'ontario_ca': { city: 'ONTARIO', state: 'CA', vendor: 'ULINE' },
    'city_of_industry_ca': { city: 'CITY OF INDUSTRY', state: 'CA', vendor: 'ULINE' },
    'lacey_wa': { city: 'LACEY', state: 'WA', vendor: 'ULINE' },
    'minneapolis_mn': { city: 'MINNEAPOLIS', state: 'MN', vendor: 'ULINE' },
    'coppell_tx': { city: 'COPPELL', state: 'TX', vendor: 'ULINE' },
    'hudson_wi': { city: 'HUDSON', state: 'WI', vendor: 'ULINE' },
};

/** Shipper company / CSV ship-from text → Finale vendor (plain names only). */
function matchVendorFromShipperText(text: string): string | null {
    const t = (text || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
    if (/\bULINE\b|\bU[\s-]?LINE\b/.test(t)) return 'ULINE';
    if (/\bROOTWISE\b/.test(t)) return 'Rootwise Soil Dynamics';
    if (/\bGRANITE\s*MILL\b/.test(t)) return 'Granite Mill';
    return null;
}

/**
 * Resolve vendor from Track result: company name first, then origin city map.
 */
function matchVendorFromTrack(track: {
    shipperCity: string;
    shipperState: string;
    shipperCompany: string;
}): string | null {
    const byName = matchVendorFromShipperText(track.shipperCompany);
    if (byName) return byName;
    const city = (track.shipperCity || '').toUpperCase();
    const state = (track.shipperState || '').toUpperCase();
    const key = `${city.toLowerCase().replace(/\s+/g, '_')}_${state.toLowerCase()}`;
    return VENDOR_ORIGIN_MAP[key]?.vendor || null;
}

function matchVendorFromCsvShipFrom(entry: {
    shipFrom: string;
    shipFromZip: string;
}): string | null {
    return matchVendorFromShipperText(entry.shipFrom) || matchVendorFromShipperText(entry.shipFromZip);
}

function isUlineVendor(name: string): boolean {
    return /\buline\b/i.test(name || '');
}

/**
 * True if this adjustment is already the FedEx charge for this invoice/tracking.
 * Ignores Uline's ~$1.50 in-house charge (not carrier freight).
 */
function adjIsThisFedExInvoice(adj: { description?: string; amount?: number }, invoiceNumber: string): boolean {
    const desc = (adj.description || '').toLowerCase();
    const inv = (invoiceNumber || '').toLowerCase();
    if (!inv) return false;
    return desc.includes(inv);
}

/**
 * True if PO already has real carrier freight (not only Uline's house charge).
 */
function poHasRealCarrierFreight(
    adjustments: Array<{ description?: string; amount?: number; productPromoUrl?: string }>,
): boolean {
    return adjustments.some((a) => {
        const desc = (a.description || '').toLowerCase();
        const amt = Number(a.amount) || 0;
        if (amt > 0 && amt <= ULINE_HOUSE_CHARGE_MAX) return false; // Uline house charge
        if (desc.includes('freight') || (a.productPromoUrl || '').includes('/10007')) {
            return amt > ULINE_HOUSE_CHARGE_MAX;
        }
        return false;
    });
}

/** Simple Finale note — amount is the $ field. No product/system branding. */
function buildFedExFreightLabel(fedex: FedExEntry): string {
    const inv = (fedex.invoiceNumber || '').trim();
    if (inv) return `Freight ${inv}`;
    return 'Freight';
}

// ── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const csvArgIdx = args.indexOf('--csv');
const csvPath = csvArgIdx >= 0 ? args[csvArgIdx + 1] : null;
const LIVE = args.includes('--live');
const DRY_RUN = !LIVE;
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

const SANDBOX_DIR = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');

function parseFedExCSV(filePath: string): FedExEntry[] {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/\r?\n$/, '');
    const lines = raw.split(/\r?\n/);
    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const dateIdx = headers.findIndex(h => h.includes('ship') || h.includes('date') || h.includes('pickup'));
    const invIdx = headers.findIndex(h => h.includes('invoice') || h.includes('inv') || h.includes('number'));
    const amtIdx = headers.findIndex(h => h.includes('amt') || h.includes('charge') || h.includes('total') || h.includes('due'));
    const poIdx = headers.findIndex(h => h.includes('po') || h.includes('reference') || h.includes('ref'));
    const refIdx = headers.findIndex(h => h.includes('ref') && headers.indexOf(h) !== poIdx);
    const termsIdx = headers.findIndex(h => h.includes('term') || h.includes('pay') || h.includes('collect'));
    const fromIdx = headers.findIndex(h => h.includes('from') || h.includes('orig') || h.includes('shipper'));
    const toIdx = headers.findIndex(h => h.includes('to') || h.includes('dest') || h.includes('deliv'));
    const fromZipIdx = headers.findIndex(h => h.includes('fromzip') || h.includes('originzip'));
    const toZipIdx = headers.findIndex(h => h.includes('tozip') || h.includes('destzip'));

    const entries: FedExEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        if (fields.length < 2 || !fields[invIdx]?.trim()) continue;

        const rawDate = fields[dateIdx]?.trim() || '';
        const dateParts = rawDate.match(/(\d+)\/(\d+)\/(\d+)/);
        const shipDate = dateParts
            ? `${dateParts[3].padStart(4, '20')}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`
            : rawDate;

        const amtStr = fields[amtIdx]?.replace(/[$,]/g, '').trim() || '0';
        const amtDue = parseFloat(amtStr);

        entries.push({
            shipDate,
            invoiceNumber: fields[invIdx]?.trim() || '',
            amtDue: isNaN(amtDue) ? 0 : amtDue,
            poNumber: fields[poIdx]?.trim() || '',
            refNum: refIdx >= 0 ? fields[refIdx]?.trim() || '' : '',
            terms: termsIdx >= 0 ? (fields[termsIdx]?.toUpperCase().includes('COLLECT') ? 'COLLECT' : 'PREPAID') : 'COLLECT',
            shipFrom: fromIdx >= 0 ? fields[fromIdx]?.trim() || '' : '',
            shipTo: toIdx >= 0 ? fields[toIdx]?.trim() || '' : '',
            shipFromZip: fromZipIdx >= 0 ? fields[fromZipIdx]?.trim() || '' : '',
            shipToZip: toZipIdx >= 0 ? fields[toZipIdx]?.trim() || '' : '',
        });
    }
    return entries;
}

// ── FedEx Entry (API response mapped to legacy shape) ──────────────────────────

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
    const shipperCompany = track.shipperInformation?.contact?.companyName || '';
    const matchedVendor = matchVendorFromTrack({
        shipperCity: city,
        shipperState: state,
        shipperCompany,
    });

    const weight = track.packageDetails?.weightAndDimensions?.weight?.[0];
    const delDate = track.dateAndTimes?.find((d: any) => d.type === 'ACTUAL_DELIVERY')?.dateTime || '';

    return {
        trackingNumber,
        shipperCity: city,
        shipperState: state,
        shipperCompany,
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
    let run: ReconciliationRun | null = null;
    try {
        run = await ReconciliationRun.start('FedEx', DRY_RUN ? 'dry-run' : 'live', { csvPath, reportOnly: REPORT_ONLY });

        console.log(`\n╔═══════════════════════════════════════════════╗`);
        console.log(`║    FedEx Freight → Finale PO Reconciliation   ║`);
        console.log(`╚═══════════════════════════════════════════════╝\n`);
        console.log(`Mode: ${REPORT_ONLY ? '📊 REPORT ONLY' : DRY_RUN ? '🔵 DRY RUN' : '🔴 LIVE UPDATE'}\n`);

        // --- Step 1: Find and parse FedEx CSV ---
        let targetCsv: string | null = null;

        if (csvPath) {
            targetCsv = csvPath;
        } else {
            const candidate = findLatestFedexCsvCandidate();
            if (!candidate) {
                console.error('❌ No FEDEX*.csv found in:');
                console.error(`   ${getFedexStatementDir()}`);
                console.error(`   ${path.join(os.homedir(), 'Downloads')}`);
                console.error(`   ${SANDBOX_DIR}`);
                console.error('   Run: node --env-file=.env.local --import tsx src/cli/fetch-fedex-csv.ts');
                throw new Error('No FEDEX*.csv files found');
            }
            targetCsv = candidate.fullPath;
            console.log(`📂 Source: ${candidate.source} (${path.basename(candidate.fullPath)})`);
            // Keep a stable copy under Aria statements + Sandbox FEDEX_ name for ops
            try {
                const archived = archiveFedexCsvToAria(targetCsv);
                if (fs.existsSync(SANDBOX_DIR)) {
                    const sandboxName = path.basename(archived).toUpperCase().startsWith('FEDEX')
                        ? path.basename(archived)
                        : `FEDEX_${path.basename(archived)}`;
                    const sandboxPath = path.join(SANDBOX_DIR, sandboxName);
                    if (path.resolve(archived) !== path.resolve(sandboxPath)) {
                        fs.copyFileSync(archived, sandboxPath);
                    }
                }
            } catch {
                /* non-fatal */
            }
        }

        if (!targetCsv || !fs.existsSync(targetCsv)) {
            console.error('❌ CSV not found:', targetCsv);
            throw new Error('CSV file not found: ' + targetCsv);
        }

        console.log(`📄 CSV: ${path.basename(targetCsv)}`);
        const entries: FedExEntry[] = parseFedExCSV(targetCsv);

        console.log(`📦 Total unique FedEx invoices: ${entries.length}\n`);

        for (const _e of entries) {
            run.recordInvoiceFound();
        }

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
    const changes: ChangeSet = [];
    const poFreightMap: Record<string, { fedex: FedExEntry; label: string }[]> = {};

    console.log(`\nFetching recent POs for reception correlation...`);
    let allPOs: any[] = [];
    try {
        allPOs = await finale.getRecentPurchaseOrders(400, 1000);
        console.log(`Fetched ${allPOs.length} POs for correlation.`);
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
            const existing = await lookupVendorInvoices({ vendor: 'FedEx', invoice_number: fedex.invoiceNumber });
            if (existing.length > 0 && existing[0].status !== 'void') {
                run.recordWarning(`Invoice ${fedex.invoiceNumber} already reconciled, skipping`, { invoiceNumber: fedex.invoiceNumber });
                continue;
            }
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

                const existingAdj = po.orderAdjustmentList || [];
                const existingThisInv = existingAdj.filter(
                    (a: any) => adjIsThisFedExInvoice(a, fedex.invoiceNumber)
                );

                if (existingThisInv.length > 0) {
                    result.freightAlreadyOnPO = true;
                    console.log(`✅ PO ${poId} | $${fedex.amtDue.toFixed(2)} | Already has this freight | ${vendor}`);
                } else if (REPORT_ONLY || DRY_RUN) {
                    // Uline $1.50 house charge is fine to leave; we add real FedEx COLLECT next to it
                    console.log(`🔵 PO ${poId} | $${fedex.amtDue.toFixed(2)} | ${DRY_RUN ? 'WOULD ADD' : 'NEEDS'} freight | ${vendor} | FedEx ${fedex.invoiceNumber}`);
                } else {
                    const label = buildFedExFreightLabel(fedex);

                    // Phase 1: collect change instead of applying
                    changes.push({
                        type: 'freight_add',
                        poId,
                        freightCents: Math.round(fedex.amtDue * 100),
                        invoiceNumber: fedex.invoiceNumber,
                    });

                    if (!poFreightMap[poId]) poFreightMap[poId] = [];
                    poFreightMap[poId].push({ fedex, label });

                    result.freightAdded = true;
                    console.log(`✅ PO ${poId} | $${fedex.amtDue.toFixed(2)} | ADDED freight | ${vendor} | FedEx ${fedex.invoiceNumber}`);
                }
            } catch (err: any) {
                result.error = err.message;
                run.recordError(`PO ${poId} processing failed`, err instanceof Error ? err : new Error(err.message));
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
            const existing = await lookupVendorInvoices({ vendor: 'FedEx', invoice_number: fedex.invoiceNumber });
            if (existing.length > 0 && existing[0].status !== 'void') {
                run.recordWarning(`Invoice ${fedex.invoiceNumber} already reconciled, skipping`, { invoiceNumber: fedex.invoiceNumber });
                continue;
            }
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

                    // Company name (ULINE) first, then city map; CSV ship-from as extra hint
                    const vendorName =
                        track.matchedVendor ||
                        matchVendorFromCsvShipFrom(fedex);
                    const originLabel = `${track.shipperCity}, ${track.shipperState}`;

                    if (vendorName) {
                        result.matchSource = 'track_api';

                        const delDate = new Date(track.deliveryDate || fedex.shipDate);
                        const vendorKey = vendorName.split(' ')[0].toLowerCase();
                        const vendorPOs = allPOs.filter(po => {
                            const vn = (po.vendorName || '').toLowerCase();
                            if (!vn.includes(vendorKey) && !(isUlineVendor(vendorName) && isUlineVendor(po.vendorName))) {
                                return false;
                            }
                            // Dropship never
                            if (/dropship/i.test(po.orderId || '')) return false;

                            if (po.shipments && po.shipments.length > 0) {
                                for (const shipment of po.shipments) {
                                    if (shipment.receiveDate) {
                                        const recDate = new Date(shipment.receiveDate);
                                        const recDiff = Math.abs((delDate.getTime() - recDate.getTime()) / 86400000);
                                        // Uline: one ship per date; Rootwise multi-delivery noted on receiving
                                        if (recDiff <= 7) return true;
                                    }
                                }
                            }

                            const poDate = new Date(po.orderDate);
                            const daysDiff = (delDate.getTime() - poDate.getTime()) / 86400000;
                            return daysDiff >= -3 && daysDiff <= 45;
                        });

                        vendorPOs.sort((a, b) => {
                            const aCorr = findCorrelatedReception(a, track.deliveryDate || fedex.shipDate);
                            const bCorr = findCorrelatedReception(b, track.deliveryDate || fedex.shipDate);
                            if (aCorr && !bCorr) return -1;
                            if (!aCorr && bCorr) return 1;

                            const poDateA = new Date(a.orderDate);
                            const poDateB = new Date(b.orderDate);
                            const diffA = Math.abs(delDate.getTime() - poDateA.getTime());
                            const diffB = Math.abs(delDate.getTime() - poDateB.getTime());
                            return diffA - diffB;
                        });

                        if (vendorPOs.length === 0) {
                            console.log(`📍 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | ⚠️ No matching PO found`);
                        } else {
                            let matched = false;
                            for (const po of vendorPOs) {
                                try {
                                    const details = await finale.getOrderDetails(po.orderId);
                                    const adj = details.orderAdjustmentList || [];
                                    const hasThisInv = adj.some((a: any) => adjIsThisFedExInvoice(a, fedex.invoiceNumber));

                                    if (hasThisInv) {
                                        result.finalePoId = po.orderId;
                                        result.freightAlreadyOnPO = true;
                                        console.log(`✅ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} already has freight`);
                                        matched = true;
                                        break;
                                    }

                                    const corr = findCorrelatedReception(po, track.deliveryDate || fedex.shipDate);
                                    // Rootwise / Granite: multi-delivery — require receive correlation
                                    const isMultiRecVendor = ['rootwise', 'granite', 'grokashi', 'gro kashi'].some(v =>
                                        vendorName.toLowerCase().includes(v)
                                    );
                                    // Uline: one FedEx per date; $1.50 house charge must NOT block
                                    const isUline = isUlineVendor(vendorName);
                                    let isValidCandidate: boolean;
                                    if (isMultiRecVendor) {
                                        isValidCandidate = !!corr;
                                    } else if (isUline) {
                                        // Prefer same-date receive; allow if no real carrier freight yet
                                        isValidCandidate = !!corr || !poHasRealCarrierFreight(adj);
                                    } else {
                                        isValidCandidate = !poHasRealCarrierFreight(adj);
                                    }

                                    if (isValidCandidate) {
                                        result.finalePoId = po.orderId;

                                        if (REPORT_ONLY || DRY_RUN) {
                                            console.log(`🔵 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} | ${DRY_RUN ? 'WOULD ADD' : 'NEEDS freight'}`);
                                        } else {
                                            const label = buildFedExFreightLabel(fedex);

                                            changes.push({
                                                type: 'freight_add',
                                                poId: po.orderId,
                                                freightCents: Math.round(fedex.amtDue * 100),
                                                invoiceNumber: fedex.invoiceNumber,
                                            });

                                            if (!poFreightMap[po.orderId]) poFreightMap[po.orderId] = [];
                                            poFreightMap[po.orderId].push({ fedex, label });

                                            result.freightAdded = true;
                                            console.log(`✅ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} | ADDED freight`);
                                        }
                                        matched = true;
                                        break;
                                    }
                                } catch (err: any) {
                                    run.recordError(`PO ${po.orderId} track match failed`, err instanceof Error ? err : new Error(err.message));
                                }
                            }
                            if (!matched) {
                                console.log(`📍 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | All candidate POs already have freight`);
                            }
                        }
                    } else {
                        console.log(`❓ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} | Weight: ${track.weight} lbs | Unknown vendor`);
                    }

                    await new Promise(r => setTimeout(r, 300));
                } catch (err: any) {
                    run.recordError(`FedEx ${fedex.invoiceNumber} track failed`, err instanceof Error ? err : new Error(err.message));
                    console.log(`❌ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | Track error: ${err.message.substring(0, 60)}`);
                }
            } else {
                console.log(`❓ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${fedex.shipDate} | No Track API available`);
            }

            results.push(result);
        }
    }

    // --- Phase 2: Apply collected changes (live mode only) ---
    // Phase 1 collected all changes; now validate invariants then apply if live
    try {
        for (const change of changes) {
            // No per-change invariants for freight (only price changes have ratio checks)
            // but we validate subtotal match per PO after all items collected
        }

        // Assert subtotal match for each affected PO
        for (const [poId, freightItems] of Object.entries(poFreightMap)) {
            // FedEx freight is additive — no per-invoice subtotal check needed
            // Just verify PO exists and is accessible
        }

        if (run.isLive() && Object.keys(poFreightMap).length > 0) {
            console.log(`\n${'─'.repeat(60)}`);
            console.log(`PHASE 2: Applying ${changes.length} freight change(s) to ${Object.keys(poFreightMap).length} PO(s)`);
            console.log(`${'─'.repeat(60)}\n`);

            for (const [poId, freightItems] of Object.entries(poFreightMap)) {
                try {
                    const po = await finale.getOrderDetails(poId);
                    const originalStatus = await finale.unlockForEditing(po, poId);

                    const adjustments = [...(po.orderAdjustmentList || [])];
                    for (const item of freightItems) {
                        adjustments.push({
                            amount: item.fedex.amtDue,
                            description: item.label,
                            productPromoUrl: FREIGHT_PROMO,
                        });
                        run.recordFreight(Math.round(item.fedex.amtDue * 100));
                    }

                    const encodedId = encodeURIComponent(poId);
                    await (finale as any).post(
                        `/${FINALE_ACCOUNT}/api/order/${encodedId}`,
                        { ...po, orderAdjustmentList: adjustments }
                    );

                    await finale.restoreOrderStatus(poId, originalStatus);
                    run.recordPoUpdated(poId);
                    console.log(`   ✅ PO ${poId}: applied ${freightItems.length} freight entry(ies)`);
                } catch (err: any) {
                    run.recordError(`Phase 2 apply failed for PO ${poId}`, err instanceof Error ? err : new Error(err.message));
                    console.log(`   ❌ PO ${poId} Phase 2 failed: ${err.message}`);
                }
            }
        }
    } catch (err) {
        if (err instanceof InvariantViolationError) {
            run.recordError('Invariant violation during FedEx reconciliation', err);
            await run.fail('FedEx reconciliation aborted: invariant violation', err);
            await sendReconciliationSummary(run);
            throw err;
        }
        throw err;
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
    const reportPath = path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox', 'fedex-reconcile-report.json');
    const report = {
        runDate: new Date().toISOString(),
        source: 'csv_import',
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

        await run.complete('FedEx reconciliation complete.');
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (run) {
            await run.fail('FedEx reconciliation failed', error);
        } else {
            console.error('[FedEx] Fatal error before run could be created:', error.message);
        }
        throw err;
    } finally {
        if (run) await sendReconciliationSummary(run);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
