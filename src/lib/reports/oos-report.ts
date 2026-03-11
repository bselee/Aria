/**
 * @file    oos-report.ts
 * @purpose Generates enriched Out-of-Stock inventory reports from Stockie Low Stock Alert emails.
 *          Cross-references OOS SKUs with Finale POs, fetches tracking data (EasyPost/FedEx/LTL),
 *          estimates delivery dates, and produces an Excel report for colleagues.
 * @author  Antigravity / ARIA
 * @created 2026-03-11
 * @updated 2026-03-11
 * @deps    finale/client, supabase, @easypost/api, ExcelJS
 * @env     FINALE_API_KEY, FINALE_API_SECRET, EASYPOST_API_KEY, FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET
 */

import { FinaleClient, type FullPO, type POInfo } from '../finale/client';
import { createClient } from '../supabase';
import { getAuthenticatedClient } from '../gmail/auth';
import { gmail as GmailApi } from '@googleapis/gmail';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export interface OOSItem {
    sku: string;
    productName: string;
    variant: string;
    shopifyVendor: string;
    shopifyCommitted: number;
    shopifyAvailable: number;
    shopifyOnHand: number;
    shopifyIncoming: number;
    shopifyProductUrl: string;
}

export interface EnrichedOOSItem extends OOSItem {
    finaleStatus: string;
    finaleSupplier: string;
    isManufactured: boolean;
    hasBOM: boolean;
    leadTimeDays: number | null;
    openPOs: EnrichedPOInfo[];
    actionRequired: string;
    finaleProductUrl: string;
}

export interface EnrichedPOInfo {
    orderId: string;
    status: string;
    orderDate: string;
    supplier: string;
    quantityOnOrder: number;
    total: string;
    finaleUrl: string;
    expectedDelivery: string | null;
    trackingNumbers: string[];
    trackingLinks: string[];
    trackingStatuses: string[];
    shipDate: string | null;
    carrier: string | null;
}

export interface OOSReportResult {
    outputPath: string;
    totalItems: number;
    needsOrder: string[];
    onOrder: string[];
    agingPOs: string[];
    internalBuild: string[];
    notInFinale: string[];
    received: string[];
    needsReview: string[];
}

// ──────────────────────────────────────────────────
// CARRIER URL GENERATION (mirrors ops-manager.ts)
// ──────────────────────────────────────────────────

const LTL_DIRECT_LINKS: Record<string, string> = {
    "Old Dominion Freight Line": "https://www.odfl.com/trace/Trace.jsp?pro={PRO}",
    "Old Dominion": "https://www.odfl.com/trace/Trace.jsp?pro={PRO}",
    "Saia": "https://www.saia.com/tracking?pro={PRO}",
    "Estes": "https://www.estes-express.com/tracking?pro={PRO}",
    "R&L Carriers": "https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro={PRO}",
    "XPO Logistics": "https://app.xpo.com/track/pro/{PRO}",
    "Dayton Freight": "https://www.daytonfreight.com/tracking/?pro={PRO}",
    "FedEx Freight": "https://www.fedex.com/fedextrack/?tracknumbers={PRO}",
    "TForce Freight": "https://www.tforcefreight.com/ltl/apps/Tracking?type=P&HAWB={PRO}",
};

function carrierUrl(trackingNumber: string): string {
    if (trackingNumber.includes(":::")) {
        const [carrierName, actualNumber] = trackingNumber.split(":::", 2);
        const knownCarrier = Object.keys(LTL_DIRECT_LINKS).find(k =>
            carrierName.toLowerCase().includes(k.toLowerCase())
        );
        if (knownCarrier) {
            return LTL_DIRECT_LINKS[knownCarrier].replace("{PRO}", encodeURIComponent(actualNumber));
        }
        return `https://parcelsapp.com/en/tracking/${actualNumber}`;
    }

    if (/^1Z/i.test(trackingNumber)) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    if (/^(94|92|93|95)/.test(trackingNumber)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    if (/^JD/i.test(trackingNumber)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
    if (/\b(96\d{18}|\d{15}|\d{12})\b/.test(trackingNumber)) return `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`;
    return `https://parcelsapp.com/en/tracking/${trackingNumber}`;
}

function detectCarrier(trackingNumber: string): string {
    if (trackingNumber.includes(":::")) return trackingNumber.split(":::")[0];
    if (/^1Z/i.test(trackingNumber)) return "UPS";
    if (/^(94|92|93|95)/.test(trackingNumber)) return "USPS";
    if (/^JD/i.test(trackingNumber)) return "DHL";
    if (/^(96\d{18}|\d{15}|\d{12})$/.test(trackingNumber)) return "FedEx";
    return "Unknown";
}

// ──────────────────────────────────────────────────
// DATE HELPERS
// ──────────────────────────────────────────────────

/** Advance `start` by `bdays` business days (skips Sat/Sun). */
function addBusinessDays(start: Date, bdays: number): Date {
    const d = new Date(start);
    let added = 0;
    while (added < bdays) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) added++;
    }
    return d;
}

// ──────────────────────────────────────────────────
// CSV PARSING
// ──────────────────────────────────────────────────

/**
 * Parse the Stockie inventory-report.csv into structured OOS items.
 * Handles quoted CSV fields (e.g. vendor names with commas).
 */
export function parseStockieCSV(csvContent: string): OOSItem[] {
    const lines = csvContent.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    const items: OOSItem[] = [];

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);
        if (fields.length < 15) continue;

        const available = parseInt(fields[10]) || 0;
        // Only include items that are at or below threshold
        items.push({
            sku: fields[4]?.trim() || '',
            productName: fields[1]?.trim() || '',
            variant: fields[3]?.trim() || '',
            shopifyVendor: fields[6]?.trim() || '',
            shopifyCommitted: parseInt(fields[9]) || 0,
            shopifyAvailable: available,
            shopifyOnHand: parseInt(fields[11]) || 0,
            shopifyIncoming: parseInt(fields[12]) || 0,
            shopifyProductUrl: fields[2]?.trim() || '',
        });
    }

    return items.filter(item => item.sku);
}

/**
 * Parse a single CSV line respecting quoted fields.
 */
function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current.trim());
    return fields;
}

// ──────────────────────────────────────────────────
// ENRICHMENT
// ──────────────────────────────────────────────────

/**
 * Enrich OOS items with Finale data, open POs, tracking numbers, and delivery estimates.
 *
 * @param items         - Parsed OOS items from Stockie CSV
 * @param finaleClient  - Authenticated Finale API client
 * @returns Enriched items with PO/tracking data + categorized action flags
 */
export async function enrichOOSItems(
    items: OOSItem[],
    finaleClient: FinaleClient,
): Promise<EnrichedOOSItem[]> {
    const supabase = createClient();

    // Pre-fetch vendor lead time history for ETA estimation
    const vendorLeadTimes = await finaleClient.getVendorLeadTimeHistory(180);

    // Pre-fetch recent POs (last 120 days) for cross-referencing
    const recentPOs = await finaleClient.getRecentPurchaseOrders(120);
    const oosSkuSet = new Set(items.map(i => i.sku.toLowerCase()));

    // Find all POs that contain OOS SKUs
    // DECISION(2026-03-11): Include both Committed AND Completed POs.
    // Finale auto-completes POs when reception qty matches, but:
    //   - Item may still be OOS (stock consumed faster than received)
    //   - Tracking/shipping info is still relevant context
    //   - Invoice matching is still pending on Completed POs
    const relevantStatuses = new Set(['Committed', 'Completed']);
    const relevantPOs = recentPOs.filter(po =>
        relevantStatuses.has(po.status) &&
        po.items.some(item => oosSkuSet.has((item.productId || '').toLowerCase()))
    );

    // Fetch tracking numbers from Supabase for relevant POs
    const poTrackingMap = new Map<string, string[]>();
    if (relevantPOs.length > 0) {
        const poNumbers = relevantPOs.map(po => po.orderId);
        const { data: poRecords } = await supabase
            .from('purchase_orders')
            .select('po_number, tracking_numbers')
            .in('po_number', poNumbers);

        for (const record of (poRecords || [])) {
            if (record.tracking_numbers?.length) {
                poTrackingMap.set(record.po_number, record.tracking_numbers);
            }
        }
    }

    // Also try to get shipment tracking from Finale for POs without Supabase tracking
    for (const po of relevantPOs) {
        if (!poTrackingMap.has(po.orderId)) {
            try {
                const summary = await finaleClient.getOrderSummary(po.orderId);
                if (summary?.shipmentUrls?.length) {
                    const trackingCodes: string[] = [];
                    for (const shipUrl of summary.shipmentUrls) {
                        try {
                            const shipment = await finaleClient.getShipmentDetails(shipUrl);
                            if (shipment?.trackingCode) {
                                trackingCodes.push(shipment.trackingCode);
                            }
                        } catch {
                            // Shipment fetch failed — non-fatal
                        }
                    }
                    if (trackingCodes.length > 0) {
                        poTrackingMap.set(po.orderId, trackingCodes);
                    }
                }
            } catch {
                // Order summary fetch failed — non-fatal
            }
        }
    }

    // DECISION(2026-03-11): Third tracking source — Gmail vendor shipping emails.
    // Vendors like MORR send shipping confirmations with carrier/PRO info by email,
    // but don't update Finale's shipment records. Search for them.
    try {
        const authClient = await getAuthenticatedClient();
        const gmail = GmailApi({ version: 'v1', auth: authClient });

        for (const po of relevantPOs) {
            if (poTrackingMap.has(po.orderId)) continue; // already found
            if (!po.vendorName) continue;

            console.log(`📬 [OOS] Searching Gmail for PO ${po.orderId} vendor=${po.vendorName}`);

            // Search Gmail for shipping emails from this vendor in the PO timeframe
            // DECISION(2026-03-11): Use first keyword of vendor name only for cleaner match.
            // Search both from: AND subject: to catch emails from vendor subdomains
            // (e.g., morrfarms.odoo.com when vendor is "MORR Farms").
            const vendorKeyword = po.vendorName.split(/[\s,]+/)[0];
            const searchQuery = `(from:(${vendorKeyword}) OR subject:(${vendorKeyword})) (shipped OR tracking OR "has shipped" OR "PRO number") after:${po.orderDate}`;

            try {
                const listRes = await gmail.users.messages.list({
                    userId: 'me',
                    q: searchQuery,
                    maxResults: 3,
                });

                const messages = listRes.data.messages || [];
                for (const msg of messages) {
                    const full = await gmail.users.messages.get({
                        userId: 'me',
                        id: msg.id!,
                        format: 'full',
                    });

                    // Recursive body text extraction for nested MIME parts
                    // (handles multipart/mixed → multipart/alternative → text/html)
                    let bodyText = '';
                    function extractText(part: any): void {
                        if (!part) return;
                        if (part.mimeType === 'text/plain' && part.body?.data) {
                            bodyText += Buffer.from(part.body.data, 'base64url').toString();
                        } else if (part.mimeType === 'text/html' && part.body?.data) {
                            bodyText += Buffer.from(part.body.data, 'base64url').toString()
                                .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
                        }
                        if (part.parts) {
                            for (const sub of part.parts) extractText(sub);
                        }
                    }
                    extractText(full.data.payload);

                    // Extract tracking/PRO numbers from body
                    // DECISION(2026-03-11): Require colon/equals before captured number
                    // to avoid capturing label words like "Number". Numbers must contain
                    // at least 3 digits and be 6-30 chars long.
                    const trackingPatterns = [
                        // "PRO Number: 422639593", "Tracking (PRO) Number: 422639593"
                        /(?:PRO|tracking)\s*(?:\([^)]*\)\s*)?(?:Number|#|No\.?)?\s*[:=]\s*(\d[\w-]{5,29})/gi,
                        // "Tracking: 1Z999AA10123456784"
                        /(?:tracking|pro)\s*[:=]\s*(\d[\w-]{5,29})/gi,
                        // Standalone PRO/tracking number after colon: "Pro: 422639593"  
                        /\bPRO\b[^:\n]{0,15}[:=]\s*(\d{6,20})/gi,
                    ];

                    const extractedNums = new Set<string>();
                    for (const pattern of trackingPatterns) {
                        let match;
                        while ((match = pattern.exec(bodyText)) !== null) {
                            const num = match[1].trim();
                            // Must contain at least 3 digits and not be a common word
                            const digitCount = (num.match(/\d/g) || []).length;
                            if (num.length >= 6 && digitCount >= 3 && !/^(BUILD|ORDER|INVOICE|NUMBER|SHIP)/i.test(num)) {
                                extractedNums.add(num);
                            }
                        }
                    }

                    // Also extract carrier from the email
                    let carrier = '';
                    const carrierMatch = bodyText.match(/Carrier\s*[:=]?\s*(XPO|FedEx|UPS|USPS|Saia|Old Dominion|Estes|R&L|Dayton|TForce|ODFL)[^\n]*/i);
                    if (carrierMatch) carrier = carrierMatch[1];

                    if (extractedNums.size > 0) {
                        const trackingArr = Array.from(extractedNums);
                        // Prefix with carrier if found for better URL generation
                        const enriched = carrier
                            ? trackingArr.map(t => `${carrier}:::${t}`)
                            : trackingArr;
                        poTrackingMap.set(po.orderId, enriched);
                        console.log(`📬 [OOS] Found tracking for PO ${po.orderId} via email: ${trackingArr.join(', ')} (${carrier || 'unknown carrier'})`);
                        break; // Found tracking, stop searching messages
                    }
                }
            } catch (searchErr: any) {
                console.warn(`📬 [OOS] Gmail search failed for PO ${po.orderId}: ${searchErr.message}`);
            }
        }
    } catch (err: any) {
        console.warn(`📬 [OOS] Gmail tracking search failed (non-fatal): ${err.message}`);
    }

    // Build a map: SKU → relevant POs with enriched tracking
    const skuPOMap = new Map<string, EnrichedPOInfo[]>();

    for (const po of relevantPOs) {
        const trackingNums = poTrackingMap.get(po.orderId) || [];
        const trackingLinks = trackingNums.map(t => carrierUrl(t));
        const trackingStatuses = trackingNums.map(t => {
            const carrier = detectCarrier(t);
            const rawNum = t.includes(':::') ? t.split(':::')[1] : t;
            return `${carrier}: ${rawNum}`;
        });

        // Estimate delivery: use Finale expectedDate, vendor lead time, or 10 biz days
        let expectedDelivery = po.expectedDate;
        // DECISION(2026-03-11): When Finale's dueDate === orderDate, it's a default
        // placeholder, not a real delivery estimate. Ignore it and fall through.
        if (expectedDelivery && po.orderDate && expectedDelivery === po.orderDate) {
            expectedDelivery = null;
        }
        if (!expectedDelivery && po.orderDate) {
            const medianDays = po.vendorName ? vendorLeadTimes.get(po.vendorName) : undefined;
            // DECISION(2026-03-11): Use vendor median lead time if known, else
            // default to 10 business days (≈14 calendar days) as reasonable floor.
            const calendarDays = medianDays ?? 14;
            const orderDate = new Date(po.orderDate);
            expectedDelivery = addBusinessDays(orderDate, Math.ceil(calendarDays * 5 / 7)).toISOString().split('T')[0];
        }

        const enrichedPO: EnrichedPOInfo = {
            orderId: po.orderId,
            status: po.status,
            orderDate: po.orderDate,
            supplier: po.vendorName,
            quantityOnOrder: 0, // filled per-SKU below
            total: `$${po.total.toLocaleString()}`,
            finaleUrl: po.finaleUrl,
            expectedDelivery: expectedDelivery || null,
            trackingNumbers: trackingNums,
            trackingLinks,
            trackingStatuses,
            shipDate: null,
            carrier: trackingNums.length > 0 ? detectCarrier(trackingNums[0]) : null,
        };

        for (const item of po.items) {
            const skuLower = (item.productId || '').toLowerCase();
            if (oosSkuSet.has(skuLower)) {
                const poForSku = { ...enrichedPO, quantityOnOrder: Number(item.quantity) || 0 };
                const existing = skuPOMap.get(skuLower) || [];
                existing.push(poForSku);
                skuPOMap.set(skuLower, existing);
            }
        }
    }

    // Enrich each OOS item
    const enriched: EnrichedOOSItem[] = [];

    for (const item of items) {
        let enrichedItem: EnrichedOOSItem;

        try {
            const report = await finaleClient.productReport(item.sku);

            if (report.found && report.product) {
                const p = report.product;
                const poInfos = skuPOMap.get(item.sku.toLowerCase()) || [];

                // If productReport returned openPOs but we don't have them in our cross-ref,
                // merge them in
                if (p.openPOs.length > 0 && poInfos.length === 0) {
                    for (const po of p.openPOs) {
                        const trackingNums = poTrackingMap.get(po.orderId) || [];
                        poInfos.push({
                            orderId: po.orderId,
                            status: po.status,
                            orderDate: po.orderDate,
                            supplier: po.supplier,
                            quantityOnOrder: po.quantityOnOrder,
                            total: String(po.total),
                            finaleUrl: `https://app.finaleinventory.com/buildasoilorganics/sc2/?order/purchase/order/${Buffer.from(`/buildasoilorganics/api/order/${po.orderId}`).toString('base64')}`,
                            expectedDelivery: null,
                            trackingNumbers: trackingNums,
                            trackingLinks: trackingNums.map(t => carrierUrl(t)),
                            trackingStatuses: trackingNums.map(t => `${detectCarrier(t)}: ${t.includes(':::') ? t.split(':::')[1] : t}`),
                            shipDate: null,
                            carrier: trackingNums.length > 0 ? detectCarrier(trackingNums[0]) : null,
                        });
                    }
                }

                // Determine action required
                const action = determineAction(item, p, poInfos);

                enrichedItem = {
                    ...item,
                    finaleStatus: p.statusId === 'PRODUCT_ACTIVE' ? 'Active' : p.statusId,
                    finaleSupplier: p.suppliers.map(s => `${s.name} ($${(s.cost ?? 0).toFixed(2)})`).join('; '),
                    isManufactured: p.isManufactured,
                    hasBOM: p.hasBOM,
                    leadTimeDays: p.leadTimeDays,
                    openPOs: poInfos,
                    actionRequired: action,
                    finaleProductUrl: `https://app.finaleinventory.com/buildasoilorganics/app#product?productUrl=${encodeURIComponent(p.finaleUrl)}`,
                };
            } else {
                enrichedItem = {
                    ...item,
                    finaleStatus: 'NOT FOUND',
                    finaleSupplier: 'Not in Finale',
                    isManufactured: false,
                    hasBOM: false,
                    leadTimeDays: null,
                    openPOs: [],
                    actionRequired: '⚠️ NOT IN FINALE — May be new/bundle. Needs setup',
                    finaleProductUrl: '',
                };
            }
        } catch (err: any) {
            enrichedItem = {
                ...item,
                finaleStatus: 'ERROR',
                finaleSupplier: `Error: ${err.message}`,
                isManufactured: false,
                hasBOM: false,
                leadTimeDays: null,
                openPOs: [],
                actionRequired: `❌ Finale lookup error: ${err.message}`,
                finaleProductUrl: '',
            };
        }

        enriched.push(enrichedItem);
    }

    return enriched;
}

/**
 * Determine the action required for an OOS item based on its Finale data and PO status.
 */
function determineAction(
    item: OOSItem,
    product: { isManufactured: boolean; hasBOM: boolean; doNotReorder?: boolean; category?: string | null; suppliers: Array<{ name: string }> },
    openPOs: EnrichedPOInfo[],
): string {
    // Manufactured items → internal build
    if (product.isManufactured || product.hasBOM) {
        return '🔧 Internal build needed — schedule manufacturing';
    }

    // DECISION(2026-03-11): Items marked "Do not reorder" in Finale or categorized
    // as "Deprecating" should NOT trigger "NEEDS ORDER". Instead, flag for review:
    // the team needs to decide whether to take it down or place a final reorder.
    if (product.doNotReorder) {
        // Only show category label if it's human-readable (not a raw ID like ##user39)
        const cat = product.category;
        const catLabel = (cat && !cat.startsWith('##')) ? ` (${cat})` : '';
        return `🔍 REVIEW — Marked "Do not reorder"${catLabel}. Take down listing or reorder?`;
    }

    // No POs at all → needs ordering
    if (openPOs.length === 0) {
        const supplierName = product.suppliers[0]?.name || 'vendor';
        return `🚨 NEEDS ORDER — No open PO. Contact ${supplierName}`;
    }

    // Separate completed vs open POs
    const completedPOs = openPOs.filter(po => po.status === 'Completed');
    const activePOs = openPOs.filter(po => po.status !== 'Completed');

    // Check active (Committed) POs first
    const now = Date.now();
    for (const po of activePOs) {
        const orderDate = new Date(po.orderDate).getTime();
        const ageDays = Math.floor((now - orderDate) / 86_400_000);

        if (po.trackingNumbers.length > 0) {
            const etaStr = po.expectedDelivery || 'tracking active';
            return `📦 Shipped — ${po.trackingNumbers.length} tracking #(s). ETA: ${etaStr}`;
        }

        if (po.expectedDelivery) {
            return `✅ On order — expected delivery ${po.expectedDelivery}`;
        }

        if (ageDays > 30) {
            return `⚠️ PO aging ${ageDays}+ days — follow up with ${po.supplier}`;
        }

        return `✅ On order — PO #${po.orderId} (${po.supplier})`;
    }

    // Only completed POs remain — show received status with tracking
    // DECISION(2026-03-11): Completed POs are still relevant because
    // the item is OOS despite being received. Show tracking for context.
    for (const po of completedPOs) {
        if (po.trackingNumbers.length > 0) {
            return `📫 Received (PO ${po.orderId}) — tracking: ${po.trackingStatuses[0] || po.trackingNumbers[0]}. Still OOS — may need reorder`;
        }
        return `📫 Received (PO ${po.orderId}) on ${po.expectedDelivery || po.orderDate}. Still OOS — may need reorder`;
    }

    return '✅ On order';
}

// ──────────────────────────────────────────────────
// EXCEL GENERATION
// ──────────────────────────────────────────────────

/**
 * Generate the enriched OOS Excel report with Summary + Detail sheets.
 *
 * @param items      - Enriched OOS items
 * @param outputDir  - Directory to save the report
 * @returns Result with file path and categorized SKU counts
 */
export async function generateOOSExcel(
    items: EnrichedOOSItem[],
    outputDir: string,
): Promise<OOSReportResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const filename = `OOS-Report-${today}.xlsx`;
    const outputPath = path.join(outputDir, filename);

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    const wb = new ExcelJS.Workbook();

    // ── DETAIL SHEET ──
    const ws = wb.addWorksheet('Out of Stock Detail');

    // Title rows
    ws.addRow([`BuildASoil Out of Stock Inventory Report — ${today}`]);
    ws.mergeCells('A1:T1');
    const titleRow = ws.getRow(1);
    titleRow.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A4B' } };
    titleRow.height = 28;

    ws.addRow(['Source: Stockie Low Stock Alert (dev@plutonian.io) | Generated by ARIA']);
    ws.mergeCells('A2:T2');
    const subtitleRow = ws.getRow(2);
    subtitleRow.font = { size: 10, bold: true, color: { argb: 'FFB0D0E0' } };
    subtitleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C5F7C' } };

    ws.addRow([]); // spacer

    // Headers
    const headers = [
        'SKU', 'Product Name', 'Variant', 'Vendor (Shopify)',
        'Committed', 'Available', 'On Hand', 'Incoming',
        'Finale Status', 'Finale Supplier (Cost)', 'Made In-House?', 'Lead Time',
        'PO #', 'PO Status', 'Order Date', 'Expected Delivery',
        'Tracking #', 'Tracking Link', 'Carrier',
        'Action Required',
    ];
    ws.addRow(headers);
    const headerRow = ws.getRow(4);
    headerRow.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3A7CA5' } };
    headerRow.alignment = { wrapText: true, vertical: 'middle' };

    // Categorized tracking
    const needsOrder: string[] = [];
    const onOrder: string[] = [];
    const agingPOs: string[] = [];
    const internalBuild: string[] = [];
    const notInFinale: string[] = [];
    const received: string[] = [];
    const needsReview: string[] = [];

    // Data rows
    for (const item of items) {
        // Categorize
        if (item.finaleStatus === 'NOT FOUND') {
            notInFinale.push(item.sku);
        } else if (item.isManufactured || item.hasBOM) {
            internalBuild.push(item.sku);
        } else if (item.actionRequired.includes('REVIEW')) {
            needsReview.push(item.sku);
        } else if (item.actionRequired.includes('Received')) {
            received.push(item.sku);
        } else if (item.openPOs.length === 0) {
            needsOrder.push(item.sku);
        } else if (item.actionRequired.includes('aging')) {
            agingPOs.push(item.sku);
        } else {
            onOrder.push(item.sku);
        }

        if (item.openPOs.length === 0) {
            ws.addRow([
                item.sku, item.productName, item.variant, item.shopifyVendor,
                item.shopifyCommitted, item.shopifyAvailable, item.shopifyOnHand, item.shopifyIncoming,
                item.finaleStatus, item.finaleSupplier,
                item.isManufactured ? 'Yes (BOM)' : 'No',
                item.leadTimeDays !== null ? `${item.leadTimeDays} days` : '—',
                '—', '—', '—', '—', '—', '—', '—',
                item.actionRequired,
            ]);
        } else {
            // One row per PO for this SKU
            for (const po of item.openPOs) {
                const trackingStr = po.trackingNumbers.length > 0
                    ? po.trackingNumbers.map(t => t.includes(':::') ? t.split(':::')[1] : t).join(', ')
                    : '—';
                const trackingLinkStr = po.trackingLinks.length > 0
                    ? po.trackingLinks[0]
                    : '—';
                const carrierStr = po.carrier || '—';

                const row = ws.addRow([
                    item.sku, item.productName, item.variant, item.shopifyVendor,
                    item.shopifyCommitted, item.shopifyAvailable, item.shopifyOnHand, item.shopifyIncoming,
                    item.finaleStatus, item.finaleSupplier,
                    item.isManufactured ? 'Yes (BOM)' : 'No',
                    item.leadTimeDays !== null ? `${item.leadTimeDays} days` : '—',
                    po.orderId, po.status, po.orderDate,
                    po.expectedDelivery || '—',
                    trackingStr, trackingLinkStr, carrierStr,
                    item.actionRequired,
                ]);

                // Make PO # a hyperlink to Finale
                const poCell = row.getCell(13);
                poCell.value = { text: po.orderId, hyperlink: po.finaleUrl };
                poCell.font = { color: { argb: 'FF2B6CB0' }, underline: true };

                // Make tracking link clickable
                if (po.trackingLinks.length > 0) {
                    const trackCell = row.getCell(18);
                    trackCell.value = { text: 'Track →', hyperlink: po.trackingLinks[0] };
                    trackCell.font = { color: { argb: 'FF2B6CB0' }, underline: true };
                }
            }
        }
    }

    // Column widths
    const colWidths = [12, 40, 20, 22, 10, 10, 10, 10, 10, 30, 12, 10, 10, 10, 12, 16, 22, 20, 10, 45];
    colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // ── STYLING: alternating rows, borders, conditional formatting ──
    const thinBorder: Partial<ExcelJS.Borders> = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    };
    const stripeLight: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    const stripeWhite: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };

    for (let r = 5; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const isEven = (r - 5) % 2 === 0;
        const actionVal = String(row.getCell(20).value || '');

        // Alternating row stripes
        row.fill = isEven ? stripeWhite : stripeLight;

        // Thin borders on every data cell
        for (let c = 1; c <= 20; c++) {
            row.getCell(c).border = thinBorder;
        }

        // Default font for data rows
        if (!row.getCell(1).font?.bold) {
            row.font = { size: 10, name: 'Calibri' };
        }

        // Conditional formatting for action column (col T = 20)
        const cell = row.getCell(20);
        if (actionVal.includes('NEEDS ORDER')) {
            cell.font = { bold: true, color: { argb: 'FFCC0000' }, size: 10 };
            row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0F0' } };
        } else if (actionVal.includes('REVIEW')) {
            cell.font = { bold: true, color: { argb: 'FF92400E' }, size: 10 };
            row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFBEB' } };
        } else if (actionVal.includes('aging')) {
            cell.font = { bold: true, color: { argb: 'FFCC8800' }, size: 10 };
        } else if (actionVal.includes('Shipped') || actionVal.includes('On order')) {
            cell.font = { color: { argb: 'FF228B22' }, size: 10 };
        } else if (actionVal.includes('Received')) {
            cell.font = { color: { argb: 'FF7C3AED' }, size: 10 };
            row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } };
        } else if (actionVal.includes('build')) {
            cell.font = { color: { argb: 'FF666666' }, size: 10 };
        }
    }

    // Auto-filter on the header row
    ws.autoFilter = { from: 'A4', to: `T${ws.rowCount}` };

    // Freeze panes: lock header (rows 1–4) and SKU column (col A)
    ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 4, topLeftCell: 'B5', activeCell: 'B5' }];

    // ── SUMMARY SHEET ──
    const summaryWs = wb.addWorksheet('Summary');

    summaryWs.addRow([`OUT OF STOCK SUMMARY — ${today}`]);
    summaryWs.mergeCells('A1:D1');
    const sTitleRow = summaryWs.getRow(1);
    sTitleRow.font = { size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
    sTitleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A4B' } };
    sTitleRow.height = 28;

    summaryWs.addRow([]);
    summaryWs.addRow(['Category', 'Count', 'SKUs', 'Status']);
    const sHdrRow = summaryWs.getRow(3);
    sHdrRow.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    sHdrRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3A7CA5' } };
    for (let c = 1; c <= 4; c++) {
        sHdrRow.getCell(c).border = thinBorder;
    }

    const summaryRows = [
        ['🚨 NEEDS ORDER (No PO)', needsOrder.length, needsOrder.join(', '), 'No open POs — vendor reorder needed ASAP'],
        ['🔍 NEEDS REVIEW', needsReview.length, needsReview.join(', '), 'Marked "Do not reorder" — take down listing or place final reorder?'],
        ['⚠️ ON ORDER — Aging PO', agingPOs.length, agingPOs.join(', '), 'POs older than 30 days — contact vendor'],
        ['✅ ON ORDER', onOrder.length, onOrder.join(', '), 'On order — delivery expected'],
        ['📫 RECEIVED', received.length, received.join(', '), 'PO completed — verify invoice & put away'],
        ['🔧 Internal Build (BOM)', internalBuild.length, internalBuild.join(', '), 'Manufactured in-house — schedule production'],
        ['⚠️ NOT IN FINALE', notInFinale.length, notInFinale.join(', '), 'New/bundle SKU — needs Finale setup'],
    ];
    summaryRows.forEach((rowData, i) => {
        const row = summaryWs.addRow(rowData);
        const bgColor = i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
        for (let c = 1; c <= 4; c++) {
            row.getCell(c).border = thinBorder;
        }
        // Highlight count > 0 rows
        if ((rowData[1] as number) > 0 && (rowData[0] as string).includes('NEEDS ORDER')) {
            row.getCell(1).font = { bold: true, color: { argb: 'FFCC0000' } };
        }
    });

    summaryWs.addRow([]);
    summaryWs.addRow([]);

    // Open POs table
    const poStartRow = summaryWs.rowCount + 1;
    summaryWs.addRow(['OPEN PURCHASE ORDERS CONTAINING OOS ITEMS']);
    summaryWs.mergeCells(`A${poStartRow}:H${poStartRow}`);
    const poTitleRow = summaryWs.getRow(poStartRow);
    poTitleRow.font = { size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
    poTitleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A4B' } };

    summaryWs.addRow([]);
    summaryWs.addRow(['PO #', 'Vendor', 'Order Date', 'Expected Delivery', 'Status', 'Total', 'OOS Items', 'Tracking']);
    const poHdrRow = summaryWs.getRow(poStartRow + 2);
    poHdrRow.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    poHdrRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3A7CA5' } };

    // Deduplicate POs across items
    const seenPOs = new Set<string>();
    for (const item of items) {
        const enrichedItem = items.find(i => i.sku === item.sku);
        // We need to reference enriched data — items passed are EnrichedOOSItem
        const eItem = enrichedItem as unknown as EnrichedOOSItem;
        if (!eItem?.openPOs) continue;

        for (const po of eItem.openPOs) {
            if (seenPOs.has(po.orderId)) continue;
            seenPOs.add(po.orderId);

            // Collect all OOS SKUs on this PO
            const skusOnPO = (items as unknown as EnrichedOOSItem[])
                .filter(i => i.openPOs?.some(p => p.orderId === po.orderId))
                .map(i => `${i.sku} (×${po.quantityOnOrder})`)
                .join(', ');

            const trackingStr = po.trackingNumbers.length > 0
                ? po.trackingNumbers.map(t => t.includes(':::') ? t.split(':::')[1] : t).join(', ')
                : '—';

            const row = summaryWs.addRow([
                po.orderId, po.supplier, po.orderDate,
                po.expectedDelivery || '—', po.status, po.total,
                skusOnPO, trackingStr,
            ]);

            // Alternating row colors + borders for PO table
            const poRowIdx = summaryWs.rowCount;
            const poRow = summaryWs.getRow(poRowIdx);
            const poIsEven = (poRowIdx - poStartRow) % 2 === 0;
            poRow.fill = poIsEven ? stripeWhite : stripeLight;
            for (let c = 1; c <= 8; c++) {
                poRow.getCell(c).border = thinBorder;
            }

            // PO # hyperlink
            const poCell = row.getCell(1);
            poCell.value = { text: po.orderId, hyperlink: po.finaleUrl };
            poCell.font = { color: { argb: 'FF2B6CB0' }, underline: true };
        }
    }

    // Column widths for summary
    [25, 8, 40, 50].forEach((w, i) => {
        summaryWs.getColumn(i + 1).width = w;
    });

    // Freeze panes on summary sheet
    summaryWs.views = [{ state: 'frozen', ySplit: 3, topLeftCell: 'A4', activeCell: 'A4' }];

    // Write file
    await wb.xlsx.writeFile(outputPath);

    return {
        outputPath,
        totalItems: items.length,
        needsOrder,
        onOrder,
        agingPOs,
        internalBuild,
        notInFinale,
        received,
        needsReview,
    };
}
