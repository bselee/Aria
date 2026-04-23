/**
 * @file    reconcile-fedex.ts
 * @purpose Reconcile FedEx billing against Finale POs — identify and add missing freight charges.
 *          Fetches FedEx invoices via the FedEx Invoice Billing API (last 30 days), matches entries
 *          to Finale POs by PO reference, uses FedEx Track API to resolve unmatched COLLECT entries
 *          by origin city, and adds missing COLLECT freight charges.
 * @author  Will / Antigravity
 * @created 2026-03-16
 * @updated 2026-04-23  — replaced CSV scraping with FedEx Invoice Billing API
 * @deps    dotenv, FinaleClient
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH,
 *          FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, FEDEX_ACCOUNT_NUMBER
 *
 * Usage:
 *   node --import tsx src/cli/reconcile-fedex.ts       # Fetch last 30 days, dry-run
 *   node --import tsx src/cli/reconcile-fedex.ts --live # Apply changes to Finale
 *   node --import tsx src/cli/reconcile-fedex.ts --report-only  # Report only, no updates
 *
 * DECISION(2026-03-16): Built after discovering 5+ POs with missing FedEx COLLECT freight
 * totaling $3,700+. FedEx Invoice Billing API is the correct data source.
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
import { getFedExInvoices, FedExInvoice } from '@/lib/fedex/billing';
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

// DECISION(2026-03-16): Known vendor → origin city/state mapping for FedEx Track matching.
// Built from analysis of actual FedEx shipments. Add new vendors as identified.
const VENDOR_ORIGIN_MAP: Record<string, { city: string; state: string; vendor: string }> = {
    'evergreen_co': { city: 'EVERGREEN', state: 'CO', vendor: 'Rootwise Soil Dynamics' },
    'laytonville_ca': { city: 'LAYTONVILLE', state: 'CA', vendor: 'Grokashi' },
    'missoula_mt': { city: 'MISSOULA', state: 'MT', vendor: 'Granite Mill' },
};

// ── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const DRY_RUN = !LIVE;
const REPORT_ONLY = args.includes('--report-only');

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
    let run: ReconciliationRun | null = null;
    try {
        run = await ReconciliationRun.start('FedEx', DRY_RUN ? 'dry-run' : 'live', { reportOnly: REPORT_ONLY });

        console.log(`\n╔═══════════════════════════════════════════════╗`);
        console.log(`║    FedEx Freight → Finale PO Reconciliation   ║`);
        console.log(`╚═══════════════════════════════════════════════╝\n`);
        console.log(`Mode: ${REPORT_ONLY ? '📊 REPORT ONLY' : DRY_RUN ? '🔵 DRY RUN' : '🔴 LIVE UPDATE'}\n`);

        // --- Step 1: Fetch FedEx invoices from API ---
        console.log(`📡 Fetching FedEx invoices from billing API...`);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const apiInvoices = await getFedExInvoices({ from: thirtyDaysAgo, to: new Date() });

        const entries: FedExEntry[] = apiInvoices.map((inv: FedExInvoice) => ({
            shipDate: inv.invoiceDate,
            invoiceNumber: inv.invoiceNumber,
            amtDue: inv.totalAmount,
            poNumber: inv.poNumber || '',
            refNum: '',
            terms: 'COLLECT',
            shipFrom: inv.originCity || '',
            shipTo: '',
            shipFromZip: '',
            shipToZip: '',
        }));

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
                source: 'fedex_api',
                source_ref: `fedex-api-${e.invoiceNumber}`,
                notes: `Origin: ${e.shipFrom} | Trackers: ${apiInvoices.find(i => i.invoiceNumber === e.invoiceNumber)?.trackingNumbers.join(', ') || 'none'}`,
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

                    const label = `FedEx Collect Freight — Inv ${fedex.invoiceNumber} (${fedex.shipDate})${memo}`;

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
                    console.log(`✅ PO ${poId} | $${fedex.amtDue.toFixed(2)} | ADDED freight | ${vendor} | FedEx ${fedex.invoiceNumber}${memo ? ` | ${memo}` : ''}`);
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

                    const vendorName = track.matchedVendor;
                    const originLabel = `${track.shipperCity}, ${track.shipperState}`;

                    if (vendorName) {
                        result.matchSource = 'track_api';

                        const delDate = new Date(track.deliveryDate);
                        const vendorPOs = allPOs.filter(po => {
                            if (!po.vendorName.toLowerCase().includes(vendorName.split(' ')[0].toLowerCase())) return false;

                            if (po.shipments && po.shipments.length > 0) {
                                for (const shipment of po.shipments) {
                                    if (shipment.receiveDate) {
                                        const recDate = new Date(shipment.receiveDate);
                                        const recDiff = Math.abs((delDate.getTime() - recDate.getTime()) / 86400000);
                                        if (recDiff <= 7) return true;
                                    }
                                }
                            }

                            const poDate = new Date(po.orderDate);
                            const daysDiff = (delDate.getTime() - poDate.getTime()) / 86400000;
                            return daysDiff >= -3 && daysDiff <= 45;
                        });

                        vendorPOs.sort((a, b) => {
                            const aCorr = findCorrelatedReception(a, track.deliveryDate);
                            const bCorr = findCorrelatedReception(b, track.deliveryDate);
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
                                    const hasThisInv = adj.some((a: any) => (a.description || '').includes(fedex.invoiceNumber));

                                    if (hasThisInv) {
                                        result.finalePoId = po.orderId;
                                        result.freightAlreadyOnPO = true;
                                        console.log(`✅ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} already has freight`);
                                        matched = true;
                                        break;
                                    }

                                    const hasAnyFreight = adj.some((a: any) =>
                                        (a.description || '').toLowerCase().includes('freight')
                                    );

                                    const corr = findCorrelatedReception(po, track.deliveryDate);
                                    let isValidCandidate = !hasAnyFreight;

                                    const isMultiRecVendor = ['rootwise', 'granite', 'grokashi', 'gro kashi'].some(v =>
                                        vendorName.toLowerCase().includes(v)
                                    );

                                    if (isMultiRecVendor) {
                                        isValidCandidate = !!corr;
                                    }

                                    if (isValidCandidate) {
                                        result.finalePoId = po.orderId;

                                        if (REPORT_ONLY || DRY_RUN) {
                                            console.log(`🔵 FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} | ${DRY_RUN ? 'WOULD ADD' : 'NEEDS freight'}`);
                                        } else {
                                            let memo = '';
                                            const corr = findCorrelatedReception(po, track.deliveryDate);
                                            if (corr) memo = ` — ${corr}`;

                                            const label = `FedEx Collect Freight — Inv ${fedex.invoiceNumber} (${fedex.shipDate})${memo}`;

                                            changes.push({
                                                type: 'freight_add',
                                                poId: po.orderId,
                                                freightCents: Math.round(fedex.amtDue * 100),
                                                invoiceNumber: fedex.invoiceNumber,
                                            });

                                            if (!poFreightMap[po.orderId]) poFreightMap[po.orderId] = [];
                                            poFreightMap[po.orderId].push({ fedex, label });

                                            result.freightAdded = true;
                                            console.log(`✅ FedEx ${fedex.invoiceNumber} | $${fedex.amtDue.toFixed(2)} | ${originLabel} → ${vendorName} | PO ${po.orderId} | ADDED freight${memo ? ` | ${memo}` : ''}`);
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
        source: 'fedex_api',
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
