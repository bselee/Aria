/**
 * @file    oos-email-trigger.ts
 * @purpose Monitors Gmail for the daily Stockie Low Stock Alert email, extracts the
 *          inventory-report.csv attachment, generates an enriched OOS Excel report,
 *          and emails it to colleagues. Also saves a local copy.
 * @author  Antigravity / ARIA
 * @created 2026-03-11
 * @updated 2026-03-11
 * @deps    @googleapis/gmail, oos-report, finale/client
 * @env     GMAIL_AUTH credentials, FINALE_API_KEY, FINALE_API_SECRET, OOS_REPORT_RECIPIENTS
 */

import { gmail as GmailApi } from '@googleapis/gmail';
import { getAuthenticatedClient } from '../gmail/auth';
import { FinaleClient } from '../finale/client';
import { parseStockieCSV, enrichOOSItems, generateOOSExcel } from './oos-report';
import type { OOSReportResult, EnrichedOOSItem } from './oos-report';
import { CalendarClient } from '../google/calendar';
import { BuildParser, type ParsedBuild } from '../intelligence/build-parser';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ──────────────────────────────────────────────────
// BOM BLOCKING ANALYSIS TYPES
// ──────────────────────────────────────────────────

/** Per-SKU analysis of why a build may be blocked */
export interface BuildBlockingInfo {
    sku: string;
    hasBOM: boolean;
    components: Array<{
        componentSku: string;
        onHand: number | null;
        onOrder: number | null;
        isBlocking: boolean; // on-hand <= 0
        /** PO details for this component (if on order) */
        incomingPOs: Array<{ orderId: string; quantity: number; finaleUrl: string }>;
    }>;
    blockingReason: string; // Human-readable summary
}

// ──────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────

const STOCKIE_SENDER = 'dev@plutonian.io';
const STOCKIE_SUBJECT = 'Out Of Stock';
// Label applied after processing to avoid re-running on the same email
const PROCESSED_LABEL_NAME = 'OOS-Processed';

/**
 * Recipients for the OOS report email.
 * Override via env var OOS_REPORT_RECIPIENTS (comma-separated).
 * Default: bill.selee@buildasoil.com
 */
function getRecipients(): string[] {
    if (process.env.OOS_REPORT_RECIPIENTS) {
        return process.env.OOS_REPORT_RECIPIENTS.split(',').map(e => e.trim()).filter(Boolean);
    }
    return ['bill.selee@buildasoil.com'];
}

/**
 * Local output directory for a backup copy.
 * Uses a non-OneDrive location to avoid sync issues.
 */
function getOutputDir(): string {
    if (process.env.OOS_REPORT_OUTPUT_DIR) {
        return process.env.OOS_REPORT_OUTPUT_DIR;
    }
    // DECISION(2026-03-11): Save to project tmp dir instead of Desktop to avoid OneDrive
    // sync complications. Primary delivery is via email.
    return path.join(process.cwd(), 'tmp', 'oos-reports');
}

// ──────────────────────────────────────────────────
// MAIN TRIGGER
// ──────────────────────────────────────────────────

/**
 * Scan Gmail for the latest unprocessed Stockie Low Stock Alert email,
 * generate an enriched OOS report, email it to colleagues, and save locally.
 *
 * @returns Report result with output path and stats, or null if no email found
 */
export async function processStockieEmail(): Promise<OOSReportResult | null> {
    console.log('📋 [OOS-Trigger] Scanning Gmail for Stockie Low Stock Alert email...');

    const auth = await getAuthenticatedClient('default');
    const gmail = GmailApi({ version: 'v1', auth });

    // Search for unprocessed Stockie emails from today (or last 24h)
    const since = new Date();
    since.setHours(since.getHours() - 24);
    const sinceStr = since.toISOString().slice(0, 10).replace(/-/g, '/');

    const searchQuery = `from:${STOCKIE_SENDER} subject:${STOCKIE_SUBJECT} after:${sinceStr} -label:${PROCESSED_LABEL_NAME}`;
    const { data: search } = await gmail.users.messages.list({
        userId: 'me',
        q: searchQuery,
        maxResults: 1,
    });

    if (!search.messages?.length) {
        console.log('📋 [OOS-Trigger] No unprocessed Stockie email found.');
        return null;
    }

    const messageId = search.messages[0].id!;
    console.log(`📋 [OOS-Trigger] Found Stockie email: ${messageId}`);

    // Fetch the full message with attachments
    const { data: msg } = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
    });

    // Find the CSV attachment
    const csvAttachment = findCSVAttachment(msg);
    if (!csvAttachment) {
        console.error('📋 [OOS-Trigger] No CSV attachment found in Stockie email.');
        return null;
    }

    // Download the attachment
    const { data: attachmentData } = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: csvAttachment.attachmentId!,
    });

    const csvContent = Buffer.from(attachmentData.data!, 'base64').toString('utf-8');
    console.log(`📋 [OOS-Trigger] Downloaded CSV — ${csvContent.split('\n').length - 1} data rows`);

    // Parse CSV
    const oosItems = parseStockieCSV(csvContent);
    console.log(`📋 [OOS-Trigger] Parsed ${oosItems.length} OOS SKUs from CSV`);

    if (oosItems.length === 0) {
        console.warn('📋 [OOS-Trigger] No OOS items parsed from CSV. Skipping report.');
        return null;
    }

    // Enrich with Finale data
    const finaleClient = new FinaleClient();
    const enrichedItems = await enrichOOSItems(oosItems, finaleClient);
    console.log(`📋 [OOS-Trigger] Enriched ${enrichedItems.length} items with Finale + tracking data`);

    // Fetch upcoming production calendar builds for cross-reference
    let scheduledBuilds: ParsedBuild[] = [];
    try {
        const calendar = new CalendarClient();
        const calEvents = await calendar.getAllUpcomingBuilds(60);
        if (calEvents.length > 0) {
            const parser = new BuildParser();
            scheduledBuilds = await parser.extractBuildPlan(calEvents);
            console.log(`📋 [OOS-Trigger] Found ${scheduledBuilds.length} upcoming calendar builds`);
        }
    } catch (err: any) {
        console.warn(`📋 [OOS-Trigger] Calendar fetch failed (non-fatal): ${err.message}`);
    }

    // Build a set of OOS SKUs for cross-referencing BOM components.
    // DECISION(2026-03-11): If a BOM component is itself on the OOS report,
    // it is definitionally blocking — even if Finale shows a small positive
    // onHand count (e.g. CRP101 is OOS, so CRP103 can't be built).
    const oosSkuSet = new Set(enrichedItems.map(i => i.sku.toUpperCase()));

    const buildBlockingMap = new Map<string, BuildBlockingInfo>();
    const internalBuildItems = enrichedItems.filter(i => i.isManufactured || i.hasBOM);
    if (internalBuildItems.length > 0) {
        console.log(`📋 [OOS-Trigger] Analyzing BOM components for ${internalBuildItems.length} manufactured items...`);
        for (const item of internalBuildItems) {
            try {
                const bom = await finaleClient.getBillOfMaterials(item.sku);
                const components: BuildBlockingInfo['components'] = [];
                const blockingSkus: string[] = [];

                for (const comp of bom) {
                    const profile = await finaleClient.getComponentStockProfile(comp.componentSku);
                    // A component is blocking if:
                    //   1. It appears on the OOS report itself (cross-reference)
                    //   2. Its onHand is <= 0 (clearly out)
                    //   3. Its onHand is null (Finale didn't return data — assume unavailable)
                    const isOOS = oosSkuSet.has(comp.componentSku.toUpperCase());
                    const isBlocking = isOOS
                        || profile.onHand === null
                        || profile.onHand <= 0;

                    // DECISION(2026-03-12): Capture PO details per blocking component
                    // so the email can link directly to the Finale PO page.
                    const componentPOs = profile.incomingPOs.map(po => ({
                        orderId: po.orderId,
                        quantity: po.quantity,
                        finaleUrl: `https://app.finaleinventory.com/buildasoilorganics/sc2/?order/purchase/order/${Buffer.from(`/buildasoilorganics/api/order/${po.orderId}`).toString('base64')}`,
                    }));

                    components.push({
                        componentSku: comp.componentSku,
                        onHand: profile.onHand,
                        onOrder: profile.onOrder,
                        isBlocking,
                        incomingPOs: componentPOs,
                    });
                    if (isBlocking) blockingSkus.push(comp.componentSku);
                }

                let blockingReason: string;
                if (bom.length === 0) {
                    blockingReason = 'No BOM configured — needs setup in Finale';
                } else if (blockingSkus.length > 0) {
                    const topBlockers = blockingSkus.slice(0, 3).join(', ');
                    const suffix = blockingSkus.length > 3 ? ` +${blockingSkus.length - 3} more` : '';
                    blockingReason = `Awaiting: ${topBlockers}${suffix}`;
                } else {
                    blockingReason = 'Components in stock — ready to build';
                }

                buildBlockingMap.set(item.sku.toUpperCase(), {
                    sku: item.sku,
                    hasBOM: bom.length > 0,
                    components,
                    blockingReason,
                });
            } catch (err: any) {
                console.warn(`   ⚠️ BOM check failed for ${item.sku}: ${err.message}`);
                buildBlockingMap.set(item.sku.toUpperCase(), {
                    sku: item.sku,
                    hasBOM: false,
                    components: [],
                    blockingReason: 'BOM check failed',
                });
            }
        }
        console.log(`📋 [OOS-Trigger] BOM analysis complete for ${buildBlockingMap.size} items`);
    }

    // Generate Excel report (local backup)
    const outputDir = getOutputDir();
    const result = await generateOOSExcel(enrichedItems, outputDir);
    console.log(`📋 [OOS-Trigger] Report saved locally: ${result.outputPath}`);
    console.log(`   📊 Summary: ${result.needsOrder.length} need order, ${result.needsReview.length} review, ${result.onOrder.length} on order, ${result.received.length} received, ${result.agingPOs.length} aging, ${result.internalBuild.length} internal build, ${result.notInFinale.length} not in Finale`);

    // Email the report to colleagues with enriched detail in the body
    await emailReport(gmail, result, enrichedItems, scheduledBuilds, buildBlockingMap);

    // Label the email as processed to avoid re-triggering
    await labelEmailAsProcessed(gmail, messageId);
    console.log(`📋 [OOS-Trigger] Email labeled as OOS-Processed`);

    return result;
}

// ──────────────────────────────────────────────────
// EMAIL DELIVERY
// ──────────────────────────────────────────────────

/**
 * Build and send the OOS report as an email with the XLSX attached.
 * Recipients open it directly in Google Sheets from Gmail.
 */
async function emailReport(
    gmail: any,
    result: OOSReportResult,
    enrichedItems: EnrichedOOSItem[],
    scheduledBuilds: ParsedBuild[],
    buildBlockingMap: Map<string, BuildBlockingInfo>,
): Promise<void> {
    const recipients = getRecipients();
    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        timeZone: 'America/Denver',
    });
    const shortDate = new Date().toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
        timeZone: 'America/Denver',
    });

    // Read the XLSX file for attachment
    const xlsxBuffer = fs.readFileSync(result.outputPath);
    const xlsxBase64 = xlsxBuffer.toString('base64');
    const filename = path.basename(result.outputPath);

    // Build HTML body with full detail
    const htmlBody = buildEmailBody(result, enrichedItems, scheduledBuilds, buildBlockingMap, today);

    // Build MIME message with attachment
    const boundary = `----=_Part_${Date.now()}`;
    const toHeader = recipients.join(', ');

    const mimeMessage = [
        `From: bill.selee@buildasoil.com`,
        `To: ${toHeader}`,
        `Subject: =?UTF-8?B?${Buffer.from(`OOS Report ${shortDate} — ${result.needsOrder.length} need ordering, ${result.totalItems} total`).toString('base64')}?=`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        htmlBody,
        ``,
        `--${boundary}`,
        `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        xlsxBase64,
        ``,
        `--${boundary}--`,
    ].join('\r\n');

    // Encode as base64url for Gmail API
    const encodedMessage = Buffer.from(mimeMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    try {
        await gmail.users.messages.send({
            userId: 'me',
            requestBody: { raw: encodedMessage },
        });
        console.log(`📋 [OOS-Trigger] Report emailed to: ${recipients.join(', ')}`);
    } catch (err: any) {
        console.error(`📋 [OOS-Trigger] Failed to send email: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────
// HTML EMAIL BUILDER
// ──────────────────────────────────────────────────

/** Format a date relative to today — "in 3 days", "5 days overdue", "today" */
export function relativeETA(dateStr: string | null): { text: string; color: string } {
    if (!dateStr) return { text: 'TBD', color: '#94a3b8' };
    const target = new Date(dateStr + 'T12:00:00');
    const now = new Date();
    const diffDays = Math.round((target.getTime() - now.getTime()) / 86_400_000);
    if (diffDays === 0) return { text: 'Today', color: '#166534' };
    if (diffDays === 1) return { text: 'Tomorrow', color: '#166534' };
    if (diffDays > 1) return { text: `in ${diffDays} days`, color: '#166534' };
    if (diffDays === -1) return { text: '1 day overdue', color: '#b91c1c' };
    return { text: `${Math.abs(diffDays)} days overdue`, color: '#b91c1c' };
}

export function buildEmailBody(
    result: OOSReportResult,
    items: EnrichedOOSItem[],
    scheduledBuilds: ParsedBuild[],
    buildBlockingMap: Map<string, BuildBlockingInfo>,
    dateStr: string,
): string {
    const urgent = items.filter(i => result.needsOrder.includes(i.sku));
    const aging = items.filter(i => result.agingPOs.includes(i.sku));
    const onOrder = items.filter(i => result.onOrder.includes(i.sku));
    const builds = items.filter(i => result.internalBuild.includes(i.sku));
    const missing = items.filter(i => result.notInFinale.includes(i.sku));
    const receivedItems = items.filter(i => result.received.includes(i.sku));
    const reviewItems = items.filter(i => result.needsReview.includes(i.sku));

    // Build a SKU → next scheduled build date map
    // Uses multi-strategy matching: exact → prefix → reverse-prefix
    // e.g. LOSOLY3 on calendar matches LOSOLY3PLT in OOS list
    const buildScheduleMap = new Map<string, ParsedBuild>();
    for (const b of scheduledBuilds) {
        const key = b.sku.toUpperCase();
        if (!buildScheduleMap.has(key) || b.buildDate < buildScheduleMap.get(key)!.buildDate) {
            buildScheduleMap.set(key, b);
        }
    }

    /** Find the closest scheduled build for an OOS SKU */
    const findScheduledBuild = (sku: string): ParsedBuild | undefined => {
        const upper = sku.toUpperCase();
        // 1. Exact match
        if (buildScheduleMap.has(upper)) return buildScheduleMap.get(upper);
        // 2. OOS SKU starts with a calendar SKU (LOSOLY3PLT → LOSOLY3)
        for (const [calSku, build] of buildScheduleMap) {
            if (upper.startsWith(calSku) && calSku.length >= 4) return build;
        }
        // 3. Calendar SKU starts with OOS SKU (rare but possible)
        for (const [calSku, build] of buildScheduleMap) {
            if (calSku.startsWith(upper) && upper.length >= 4) return build;
        }
        return undefined;
    };

    // Tagline
    const tagline = urgent.length === 0
        ? 'Everything has a PO or a plan. Nice.'
        : urgent.length <= 2
            ? `${urgent.length} item${urgent.length > 1 ? 's' : ''} without a PO. Probably worth a call.`
            : `${urgent.length} items sitting with no PO. Time to pick up the phone.`;

    // ── TH helper for consistent column headers ──
    const th = (label: string, align = 'left') =>
        `<th style="padding:6px 12px;text-align:${align};color:#94B8C8;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px">${label}</th>`;
    const mono = `font-family:'SF Mono',Consolas,monospace;font-size:13px`;

    // ── Urgent: no PO on file ──
    let urgentBlock = '';
    if (urgent.length > 0) {
        const rows = urgent.map((item, i) => {
            const supplier = item.finaleSupplier.split(';')[0]?.replace(/\s*\(\$[\d.]+\)/, '') || '—';
            const bg = i % 2 === 0 ? '#fff' : '#fafbfc';
            return `<tr style="background:${bg}">
                <td style="padding:8px 12px;${mono};font-weight:600">${item.sku}</td>
                <td style="padding:8px 12px;color:#333">${trunc(item.productName, 40)}</td>
                <td style="padding:8px 12px;color:#666">${trunc(supplier, 28)}</td>
                <td style="padding:8px 12px;text-align:center;${mono};color:#b91c1c;font-weight:600">${item.shopifyAvailable}</td>
            </tr>`;
        }).join('');
        urgentBlock = sect('Needs ordering — no PO on file', '#b91c1c',
            `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr style="background:#1B3A4B">${th('SKU')}${th('Product')}${th('Vendor')}${th('Qty', 'center')}</tr>
                ${rows}
            </table>`);
    }

    // ── Aging POs ──
    let agingBlock = '';
    if (aging.length > 0) {
        const rows = aging.map((item, i) => {
            const po = item.openPOs[0];
            const age = po ? Math.floor((Date.now() - new Date(po.orderDate).getTime()) / 86_400_000) : 0;
            const bg = i % 2 === 0 ? '#fff' : '#fafbfc';
            const tracking = po?.trackingLinks?.length
                ? `<a href="${po.trackingLinks[0]}" style="color:#2563EB;text-decoration:none">${po.carrier || 'Track'} &rarr;</a>`
                : '<span style="color:#ccc">none</span>';
            return `<tr style="background:${bg}">
                <td style="padding:8px 12px;${mono};font-weight:600">${item.sku}</td>
                <td style="padding:8px 12px;color:#333">${trunc(item.productName, 30)}</td>
                <td style="padding:8px 12px">${po ? `<a href="${po.finaleUrl}" style="color:#2563EB;text-decoration:none;${mono}">${po.orderId}</a>` : '—'}</td>
                <td style="padding:8px 12px;color:#92400e;font-weight:600;${mono}">${age}d</td>
                <td style="padding:8px 12px">${tracking}</td>
                <td style="padding:8px 12px;color:#666">${po?.supplier || '—'}</td>
            </tr>`;
        }).join('');
        agingBlock = sect('Aging POs — follow up with vendor', '#92400e',
            `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr style="background:#1B3A4B">${th('SKU')}${th('Product')}${th('PO')}${th('Age')}${th('Tracking')}${th('Vendor')}</tr>
                ${rows}
            </table>`);
    }

    // ── On Order with better ETA + tracking ──
    let onOrderBlock = '';
    if (onOrder.length > 0) {
        const rows = onOrder.map((item, i) => {
            const po = item.openPOs[0];
            const eta = relativeETA(po?.expectedDelivery || null);
            const etaDate = po?.expectedDelivery || '';
            const etaDisplay = etaDate
                ? `<span style="color:${eta.color};font-weight:600">${eta.text}</span><br><span style="color:#94a3b8;font-size:11px">${etaDate}</span>`
                : `<span style="color:#94a3b8">TBD</span>`;
            const tracking = po?.trackingLinks?.length
                ? `<a href="${po.trackingLinks[0]}" style="color:#2563EB;text-decoration:none;font-weight:500">${po.carrier || 'Track'} &rarr;</a>`
                : '<span style="color:#ccc">awaiting ship</span>';
            const bg = i % 2 === 0 ? '#fff' : '#fafbfc';
            return `<tr style="background:${bg}">
                <td style="padding:8px 12px;${mono};font-weight:600">${item.sku}</td>
                <td style="padding:8px 12px;color:#333">${trunc(item.productName, 30)}</td>
                <td style="padding:8px 12px">${po ? `<a href="${po.finaleUrl}" style="color:#2563EB;text-decoration:none;${mono}">${po.orderId}</a>` : '—'}</td>
                <td style="padding:8px 12px">${etaDisplay}</td>
                <td style="padding:8px 12px">${tracking}</td>
            </tr>`;
        }).join('');
        onOrderBlock = sect('On order — POs in progress', '#166534',
            `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr style="background:#1B3A4B">${th('SKU')}${th('Product')}${th('PO')}${th('Arrival')}${th('Tracking')}</tr>
                ${rows}
            </table>`);
    }

    // ── Received but still OOS ──
    let receivedBlock = '';
    if (receivedItems.length > 0) {
        const rows = receivedItems.map((item, i) => {
            const po = item.openPOs[0];
            const tracking = po?.trackingLinks?.length
                ? `<a href="${po.trackingLinks[0]}" style="color:#2563EB;text-decoration:none;font-weight:500">${po.carrier || 'Track'} &rarr;</a>`
                : po?.trackingNumbers?.length
                    ? `<span style="color:#94a3b8">${po.trackingNumbers[0]}</span>`
                    : '<span style="color:#ccc">—</span>';
            const bg = i % 2 === 0 ? '#fff' : '#fafbfc';
            return `<tr style="background:${bg}">
                <td style="padding:8px 12px;${mono};font-weight:600">${item.sku}</td>
                <td style="padding:8px 12px;color:#333">${trunc(item.productName, 30)}</td>
                <td style="padding:8px 12px">${po ? `<a href="${po.finaleUrl}" style="color:#2563EB;text-decoration:none;${mono}">${po.orderId}</a>` : '—'}</td>
                <td style="padding:8px 12px"><span style="color:#059669;font-weight:600">Received</span></td>
                <td style="padding:8px 12px">${tracking}</td>
            </tr>`;
        }).join('');
        receivedBlock = sect('Received — Still OOS', '#7c3aed',
            `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr style="background:#1B3A4B">${th('SKU')}${th('Product')}${th('PO')}${th('Status')}${th('Tracking')}</tr>
                ${rows}
            </table>`);
    }

    // ── Internal builds with calendar schedule + BOM analysis ──
    let buildsBlock = '';
    if (builds.length > 0) {
        const rows = builds.map((item, i) => {
            const sched = findScheduledBuild(item.sku);
            const blocking = buildBlockingMap.get(item.sku.toUpperCase());
            const bg = i % 2 === 0 ? '#fff' : '#fafbfc';

            // Schedule column
            let schedCell: string;
            if (sched) {
                const rel = relativeETA(sched.buildDate);
                const facility = sched.designation === 'SOIL' ? 'Soil' : 'MFG';
                schedCell = `<span style="color:${rel.color};font-weight:600">${rel.text}</span>`
                    + `<br><span style="color:#94a3b8;font-size:11px">${sched.buildDate} &middot; ${facility} &middot; ${sched.quantity} units</span>`;
            } else {
                schedCell = `<span style="color:#94a3b8;font-size:12px">No build on calendar</span>`;
            }

            // Status / blocking column — the actionable context
            let statusCell: string;
            if (sched) {
                // Has scheduled build — show ready or blocking components
                if (blocking && blocking.components.some(c => c.isBlocking)) {
                    const blockers = blocking.components.filter(c => c.isBlocking);
                    const names = blockers.slice(0, 2).map(b => {
                        let label = `<code style="${mono};font-size:11px;color:#b91c1c">${b.componentSku}</code>`;
                        if (b.onOrder && b.onOrder > 0 && b.incomingPOs.length > 0) {
                            const po = b.incomingPOs[0];
                            label += ` (<a href="${po.finaleUrl}" style="color:#2563EB;text-decoration:none;font-size:11px">${b.onOrder} on order</a>)`;
                        } else if (b.onOrder && b.onOrder > 0) {
                            label += ` (${b.onOrder} on order)`;
                        }
                        return label;
                    }).join(', ');
                    const suffix = blockers.length > 2 ? ` +${blockers.length - 2}` : '';
                    statusCell = `<span style="color:#b91c1c;font-weight:500;font-size:12px">⚠ Awaiting ${names}${suffix}</span>`;
                } else {
                    statusCell = `<span style="color:#166534;font-weight:500;font-size:12px">✓ Components ready</span>`;
                }
            } else {
                // No scheduled build — explain WHY
                if (!blocking || !blocking.hasBOM) {
                    statusCell = `<span style="color:#92400e;font-size:12px">No BOM in Finale — needs setup</span>`;
                } else if (blocking.components.some(c => c.isBlocking)) {
                    const blockers = blocking.components.filter(c => c.isBlocking);
                    const names = blockers.slice(0, 2).map(b => {
                        let label = `<code style="${mono};font-size:11px;color:#b91c1c">${b.componentSku}</code>`;
                        // DECISION(2026-03-12): Link "on order" text to the PO in Finale
                        // so the recipient can click through directly from the email.
                        if (b.onOrder && b.onOrder > 0 && b.incomingPOs.length > 0) {
                            const po = b.incomingPOs[0];
                            label += ` (<a href="${po.finaleUrl}" style="color:#2563EB;text-decoration:none;font-size:11px">${b.onOrder} on order</a>)`;
                        } else if (b.onOrder && b.onOrder > 0) {
                            label += ` (${b.onOrder} on order)`;
                        }
                        return label;
                    }).join(', ');
                    const suffix = blockers.length > 2 ? ` +${blockers.length - 2}` : '';
                    statusCell = `<span style="color:#b91c1c;font-size:12px">Blocked — awaiting ${names}${suffix}</span>`;
                } else {
                    statusCell = `<span style="color:#2563EB;font-weight:500;font-size:12px">Ready to schedule — components in stock</span>`;
                }
            }

            return `<tr style="background:${bg}">
                <td style="padding:8px 12px;${mono};font-weight:600">${item.sku}</td>
                <td style="padding:8px 12px;color:#333">${trunc(item.productName, 28)}</td>
                <td style="padding:8px 12px">${schedCell}</td>
                <td style="padding:8px 12px">${statusCell}</td>
            </tr>`;
        }).join('');
        buildsBlock = sect('Internal builds — manufacturing', '#475569',
            `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr style="background:#1B3A4B">${th('SKU')}${th('Product')}${th('Build schedule')}${th('Status')}</tr>
                ${rows}
            </table>`);
    }

    // ── Not in Finale ──
    let missingBlock = '';
    if (missing.length > 0) {
        const skus = missing.map(i =>
            `<span style="${mono};font-weight:600">${i.sku}</span>`
        ).join(', ');
        missingBlock = sect('Not in Finale', '#92400e',
            `<p style="margin:0;color:#78350f;font-size:14px">These SKUs may be new products or bundles that need setup: ${skus}</p>`);
    }

    let reviewBlock = '';
    if (reviewItems.length > 0) {
        const rows = reviewItems.map((item, i) => {
            const bg = i % 2 === 0 ? '#fff' : '#fafbfc';
            return `<tr style="background:${bg}">
                <td style="padding:8px 12px;${mono};font-weight:600">${item.sku}</td>
                <td style="padding:8px 12px;color:#333">${trunc(item.productName, 30)}</td>
                <td style="padding:8px 12px;color:#92400e">${item.actionRequired}</td>
            </tr>`;
        }).join('');
        reviewBlock = sect('Needs Review — Do Not Reorder', '#92400e',
            `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                <tr style="background:#1B3A4B">${th('SKU')}${th('Product')}${th('Status')}</tr>
                ${rows}
            </table>`);
    }

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:700px;margin:20px auto">

    <!-- Header -->
    <div style="background:#1B3A4B;padding:24px 28px;border-radius:8px 8px 0 0">
        <table width="100%"><tr>
            <td>
                <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px">Out of Stock</div>
                <div style="font-size:13px;color:#7FB3CB;margin-top:4px">${dateStr}</div>
            </td>
            <td style="text-align:right;vertical-align:top">
                <div style="background:#2C5F7C;border-radius:6px;padding:10px 14px;display:inline-block">
                    <div style="font-size:24px;font-weight:700;color:#fff;${mono};line-height:1">${result.totalItems}</div>
                    <div style="font-size:10px;color:#7FB3CB;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px">items</div>
                </div>
            </td>
        </tr></table>
    </div>

    <!-- Tagline -->
    <div style="background:#15293B;padding:10px 28px">
        <span style="font-size:13px;color:#94B8C8;font-style:italic">${tagline}</span>
    </div>

    <!-- Stats -->
    <div style="background:#fff;padding:14px 28px;border-bottom:1px solid #e2e8f0">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
            ${qStat(urgent.length, 'Need PO', urgent.length > 0 ? '#b91c1c' : '#ccc')}
            ${qStat(reviewItems.length, 'Review', reviewItems.length > 0 ? '#92400e' : '#ccc')}
            ${qStat(aging.length, 'Aging', aging.length > 0 ? '#92400e' : '#ccc')}
            ${qStat(onOrder.length, 'On Order', '#166534')}
            ${qStat(receivedItems.length, 'Received', receivedItems.length > 0 ? '#7c3aed' : '#ccc')}
            ${qStat(builds.length, 'Builds', '#475569')}
            ${qStat(missing.length, 'Not Found', missing.length > 0 ? '#92400e' : '#ccc')}
        </tr></table>
    </div>

    <!-- Sections -->
    <div style="background:#fff;padding:20px 28px 28px">
        ${urgentBlock}
        ${reviewBlock}
        ${agingBlock}
        ${onOrderBlock}
        ${receivedBlock}
        ${buildsBlock}
        ${missingBlock}
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:12px 28px;border-top:1px solid #e2e8f0;border-radius:0 0 8px 8px">
        <span style="font-size:11px;color:#cbd5e1">Full spreadsheet attached &mdash; opens in Google Sheets</span>
    </div>

</div>
</body></html>`;
}

// ── HTML Helpers ──

function qStat(value: number, label: string, color: string): string {
    return `<td style="text-align:center;padding:0 4px">
        <span style="font-size:18px;font-weight:700;color:${color};font-family:'SF Mono',Consolas,monospace">${value}</span>
        <span style="font-size:11px;color:#94a3b8;margin-left:3px">${label}</span>
    </td>`;
}

function sect(title: string, accent: string, content: string): string {
    return `
    <div style="margin-bottom:24px">
        <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:${accent};margin-bottom:8px;padding-bottom:6px;border-bottom:2px solid ${accent}">${title}</div>
        <div>${content}</div>
    </div>`;
}

function trunc(str: string, max: number): string {
    return str.length <= max ? str : str.slice(0, max - 1) + '\u2026';
}

// ──────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────

/**
 * Find the CSV attachment in a Gmail message payload.
 * Handles both direct body and multipart MIME structures.
 */
function findCSVAttachment(msg: any): { filename: string; attachmentId: string } | null {
    const parts = msg.payload?.parts || [];

    for (const part of parts) {
        if (
            (part.filename?.endsWith('.csv') || part.mimeType === 'text/csv') &&
            part.body?.attachmentId
        ) {
            return {
                filename: part.filename,
                attachmentId: part.body.attachmentId,
            };
        }
        // Check nested parts (multipart/alternative etc.)
        if (part.parts) {
            for (const subpart of part.parts) {
                if (
                    (subpart.filename?.endsWith('.csv') || subpart.mimeType === 'text/csv') &&
                    subpart.body?.attachmentId
                ) {
                    return {
                        filename: subpart.filename,
                        attachmentId: subpart.body.attachmentId,
                    };
                }
            }
        }
    }

    return null;
}

/**
 * Apply the OOS-Processed label to prevent re-processing.
 * Creates the label if it doesn't exist yet.
 */
async function labelEmailAsProcessed(gmail: any, messageId: string): Promise<void> {
    try {
        // Try to find existing label
        const { data: labels } = await gmail.users.labels.list({ userId: 'me' });
        let labelId = labels.labels?.find(
            (l: any) => l.name === PROCESSED_LABEL_NAME
        )?.id;

        // Create label if it doesn't exist
        if (!labelId) {
            const { data: newLabel } = await gmail.users.labels.create({
                userId: 'me',
                requestBody: {
                    name: PROCESSED_LABEL_NAME,
                    labelListVisibility: 'labelHide',
                    messageListVisibility: 'hide',
                },
            });
            labelId = newLabel.id;
        }

        // Apply the label
        await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: {
                addLabelIds: [labelId],
            },
        });
    } catch (err: any) {
        // Non-fatal — report was still generated
        console.warn(`📋 [OOS-Trigger] Failed to label email: ${err.message}`);
    }
}
