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
import type { OOSReportResult, EnrichedOOSItem, EnrichedPOInfo } from './oos-report';
import { CalendarClient } from '../google/calendar';
import { BuildParser, type ParsedBuild } from '../intelligence/build-parser';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createClient } from '../supabase';
import { getTrackingStatus } from '../carriers/tracking-service';

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
        incomingPOs: Array<{ orderId: string; quantity: number; finaleUrl: string; expectedDelivery?: string }>;
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
                    // so the email can link directly to the Finale PO page. Refine ETA using live tracking if available.
                    const supabase = createClient();
                    const componentPOs = await Promise.all(profile.incomingPOs.map(async po => {
                        let refinedDelivery = po.expectedDelivery;
                        if (supabase) {
                            const { data } = await supabase.from('purchase_orders')
                                .select('tracking_numbers')
                                .eq('po_number', po.orderId)
                                .maybeSingle();
                                
                            if (data && data.tracking_numbers && data.tracking_numbers.length > 0) {
                                try {
                                    const status = await getTrackingStatus(data.tracking_numbers[0]);
                                    if (status && status.display && status.display.toLowerCase().includes('expected')) {
                                        refinedDelivery = status.display.replace(/expected/i, '').trim();
                                    } else if (status && status.display) {
                                        refinedDelivery = status.display;
                                    }
                                } catch (err) {
                                    // ignore tracking fetch error
                                }
                            }
                        }

                        return {
                            orderId: po.orderId,
                            quantity: po.quantity,
                            expectedDelivery: refinedDelivery,
                            finaleUrl: `https://app.finaleinventory.com/buildasoilorganics/sc2/?order/purchase/order/${Buffer.from(`/buildasoilorganics/api/order/${po.orderId}`).toString('base64')}`,
                        };
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

    // Build Slack mrkdwn body for cross-posting to #purchasing
    // DECISION(2026-03-19): Single unified morning Slack post mirrors the email body.
    // Built here so ops-manager can append Active Purchases and post once.
    result.slackBody = buildSlackBody(result, enrichedItems, scheduledBuilds, buildBlockingMap);
    console.log(`📋 [OOS-Trigger] Slack body built (${result.slackBody.length} chars)`);

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

    // DECISION(2026-03-13): Tracking sources return varied date formats —
    // ISO "2026-03-16", short "Mar 16", "March 16, 2026", or
    // prefixed strings like "Expected Mar 16" / "Delivered".
    // Strip common prefixes first, then normalise year-less dates.
    let cleaned = dateStr.trim()
        .replace(/^(expected|estimated|est\.?|arrives?|delivery|delivered)\s*/i, '')
        .trim();

    // If it's just a status word (e.g. "Delivered") with nothing left, show as-is
    if (!cleaned) return { text: dateStr, color: '#94a3b8' };

    // DECISION(2026-03-13): Detect year-less month+day strings like "Mar 16"
    // or "March 16". JavaScript's Date("Mar 16") defaults to year 2001,
    // which produces wildly wrong "9128 days overdue" results.
    // Fix: append the current year so parsing produces the correct date.
    const monthDayOnly = /^([A-Za-z]+)\s+(\d{1,2})$/;
    const mdMatch = cleaned.match(monthDayOnly);
    if (mdMatch) {
        cleaned = `${mdMatch[1]} ${mdMatch[2]}, ${new Date().getFullYear()}`;
    }

    let target = new Date(cleaned + 'T12:00:00');
    if (isNaN(target.getTime())) {
        target = new Date(cleaned);
    }
    if (isNaN(target.getTime())) {
        // Unparseable — show the raw date string as-is
        return { text: dateStr, color: '#94a3b8' };
    }

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

    const monoStyle = `font-family:${MONO};font-size:11px`;

    // ── Urgent: no PO on file ──
    let urgentBlock = '';
    if (urgent.length > 0) {
        const rows = urgent.map((item, i) => {
            const supplier = item.finaleSupplier.split(';')[0]?.replace(/\s*\(\$[\d.]+\)/, '') || '—';
            const bg = i % 2 === 0 ? '#fff5f5' : '#ffffff';
            return `<tr style="background:${bg}">
                <td class="sku-col" width="75" style="padding:10px 10px;border-bottom:1px solid #fce8e8;font-family:${MONO};font-size:11px;font-weight:700;color:#0e3a3b;vertical-align:top;">${item.sku}</td>
                <td style="padding:10px 10px;border-bottom:1px solid #fce8e8;font-family:${FONT};font-size:12px;color:#0e3a3b;font-weight:500;vertical-align:top;">${trunc(item.productName, 50)}</td>
                <td width="160" style="padding:10px 10px;border-bottom:1px solid #fce8e8;font-family:${FONT};font-size:11px;color:#64748b;vertical-align:top;">${trunc(supplier, 28)}</td>
                <td width="50" style="padding:10px 10px;border-bottom:1px solid #fce8e8;font-family:${FONT};font-size:14px;font-weight:700;color:#dc2626;text-align:center;vertical-align:top;">${item.shopifyAvailable}</td>
            </tr>`;
        }).join('');
        urgentBlock = sect('Needs Ordering — No PO on File', '#dc2626', 'needs ordering',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:2px;">
                <tr style="background:#fef2f2;">${colHdr('SKU', 75)}${colHdr('Product')}${colHdr('Vendor', 160)}${colHdr('Qty', 50, 'center')}</tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows}
            </table>`);
    }

    // ── Aging POs ──
    let agingBlock = '';
    if (aging.length > 0) {
        const rows = aging.map((item, i) => {
            const po = item.openPOs[0];
            const age = po ? Math.floor((Date.now() - new Date(po.orderDate).getTime()) / 86_400_000) : 0;
            const bg = i % 2 === 0 ? '#fffbf0' : '#ffffff';
            const tracking = po?.trackingLinks?.length
                ? `<a href="${po.trackingLinks[0]}" style="color:#0d7377;text-decoration:none;font-family:${FONT};font-size:11px;font-weight:600;">${po.carrier || 'Track'} &#8594;</a>`
                : `<span style="font-family:${FONT};font-size:11px;color:#94a3b8;font-style:italic;">awaiting ship</span>`;
            return `<tr style="background:${bg}">
                <td class="sku-col" width="75" style="padding:10px 10px;border-bottom:1px solid #f5edd8;font-family:${MONO};font-size:11px;font-weight:700;color:#0e3a3b;vertical-align:top;">${item.sku}</td>
                <td style="padding:10px 10px;border-bottom:1px solid #f5edd8;font-family:${FONT};font-size:12px;color:#0e3a3b;font-weight:500;vertical-align:top;">${trunc(item.productName, 35)}</td>
                <td width="65" style="padding:10px 10px;border-bottom:1px solid #f5edd8;font-family:${FONT};font-size:11px;color:#0d7377;font-weight:700;vertical-align:top;">${po ? `<a href="${po.finaleUrl}" style="color:#0d7377;text-decoration:none;font-weight:700;">${po.orderId}</a>` : '—'}</td>
                <td width="50" style="padding:10px 10px;border-bottom:1px solid #f5edd8;font-family:${FONT};font-size:12px;color:#92400e;font-weight:700;vertical-align:top;">${age}d</td>
                <td width="110" style="padding:10px 10px;border-bottom:1px solid #f5edd8;vertical-align:top;">${tracking}</td>
                <td width="100" style="padding:10px 10px;border-bottom:1px solid #f5edd8;font-family:${FONT};font-size:11px;color:#64748b;vertical-align:top;">${po?.supplier || '—'}</td>
            </tr>`;
        }).join('');
        agingBlock = sect('Aging POs — Follow Up with Vendor', '#92400e', 'aging',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:2px;">
                <tr style="background:#fef9ec;">${colHdr('SKU', 75)}${colHdr('Product')}${colHdr('PO', 65)}${colHdr('Age', 50)}${colHdr('Tracking', 110)}${colHdr('Vendor', 100)}</tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
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
            const isOverdue = eta.color === '#b91c1c';
            const rowBg = isOverdue ? '#fff5f5' : (i % 2 === 0 ? '#f9fefe' : '#ffffff');
            const borderColor = isOverdue ? '#fce8e8' : '#e8f4f4';
            const etaDisplay = etaDate
                ? `<div style="font-family:${FONT};font-size:11px;font-weight:700;color:${eta.color};">${eta.text}</div>
                   <div style="font-family:${FONT};font-size:10px;color:#94a3b8;margin-top:1px;">${etaDate}</div>`
                : `<span style="font-family:${FONT};font-size:11px;color:#94a3b8;">TBD</span>`;
            const tracking = po?.trackingLinks?.length
                ? `<a href="${po.trackingLinks[0]}" style="color:#0d7377;text-decoration:none;font-family:${FONT};font-size:11px;font-weight:600;">${po.carrier || 'Track'} &#8594;</a>`
                : `<span style="font-family:${FONT};font-size:11px;color:#94a3b8;font-style:italic;">awaiting ship</span>`;
            return `<tr style="background:${rowBg}">
                <td class="sku-col" width="75" style="padding:10px 10px;border-bottom:1px solid ${borderColor};font-family:${MONO};font-size:11px;font-weight:700;color:#0e3a3b;vertical-align:top;">${item.sku}</td>
                <td style="padding:10px 10px;border-bottom:1px solid ${borderColor};font-family:${FONT};font-size:12px;color:#0e3a3b;font-weight:500;vertical-align:top;">${trunc(item.productName, 40)}</td>
                <td width="65" style="padding:10px 10px;border-bottom:1px solid ${borderColor};font-family:${FONT};font-size:11px;color:#0d7377;font-weight:700;vertical-align:top;">${po ? `<a href="${po.finaleUrl}" style="color:#0d7377;text-decoration:none;font-weight:700;">${po.orderId}</a>` : '—'}</td>
                <td width="135" style="padding:10px 10px;border-bottom:1px solid ${borderColor};vertical-align:top;">${etaDisplay}</td>
                <td width="110" style="padding:10px 10px;border-bottom:1px solid ${borderColor};vertical-align:top;">${tracking}</td>
            </tr>`;
        }).join('');
        onOrderBlock = sect('On Order — POs in Progress', '#0d7377', 'on order',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:2px;">
                <tr style="background:#f0fafa;">${colHdr('SKU', 75)}${colHdr('Product')}${colHdr('PO', 65)}${colHdr('Arrival', 135)}${colHdr('Tracking', 110)}</tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows}
            </table>`);
    }

    // ── Received but still OOS ──
    let receivedBlock = '';
    if (receivedItems.length > 0) {
        const rows = receivedItems.map((item, i) => {
            const po = item.openPOs[0];
            const tracking = po?.trackingLinks?.length
                ? `<a href="${po.trackingLinks[0]}" style="color:#0d7377;text-decoration:none;font-family:${FONT};font-size:11px;font-weight:600;">${po.carrier || 'Track'} &#8594;</a>`
                : po?.trackingNumbers?.length
                    ? `<span style="font-family:${FONT};font-size:11px;color:#94a3b8;">${po.trackingNumbers[0]}</span>`
                    : `<span style="font-family:${FONT};font-size:11px;color:#94a3b8;">—</span>`;
            const bg = i % 2 === 0 ? '#f9fefe' : '#ffffff';
            return `<tr style="background:${bg}">
                <td class="sku-col" width="75" style="padding:10px 10px;border-bottom:1px solid #e8f4f4;font-family:${MONO};font-size:11px;font-weight:700;color:#0e3a3b;vertical-align:top;">${item.sku}</td>
                <td style="padding:10px 10px;border-bottom:1px solid #e8f4f4;font-family:${FONT};font-size:12px;color:#0e3a3b;font-weight:500;vertical-align:top;">${trunc(item.productName, 40)}</td>
                <td width="65" style="padding:10px 10px;border-bottom:1px solid #e8f4f4;font-family:${FONT};font-size:11px;color:#0d7377;font-weight:700;vertical-align:top;">${po ? `<a href="${po.finaleUrl}" style="color:#0d7377;text-decoration:none;font-weight:700;">${po.orderId}</a>` : '—'}</td>
                <td width="100" style="padding:10px 10px;border-bottom:1px solid #e8f4f4;vertical-align:top;"><span style="font-family:${FONT};font-size:10px;font-weight:700;color:#059669;background:#dcfce7;padding:2px 8px;border-radius:10px;white-space:nowrap;">Received</span></td>
                <td width="110" style="padding:10px 10px;border-bottom:1px solid #e8f4f4;vertical-align:top;">${tracking}</td>
            </tr>`;
        }).join('');
        receivedBlock = sect('Received — Still OOS', '#059669', 'received',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:2px;">
                <tr style="background:#f0fdf4;">${colHdr('SKU', 75)}${colHdr('Product')}${colHdr('PO', 65)}${colHdr('Status', 100)}${colHdr('Tracking', 110)}</tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows}
            </table>`);
    }

    // ── Internal builds with calendar schedule + BOM analysis ──
    let buildsBlock = '';
    if (builds.length > 0) {
        const rows = builds.map((item, i) => {
            const sched = findScheduledBuild(item.sku);
            const blocking = buildBlockingMap.get(item.sku.toUpperCase());
            const isBlocked = blocking && blocking.components.some(c => c.isBlocking);

            // Urgency-based row tinting
            let rowBg: string;
            let borderColor: string;
            if (sched) {
                const rel = relativeETA(sched.buildDate);
                if (rel.text === 'Today' || rel.text === 'Tomorrow') {
                    rowBg = '#fffdf0'; borderColor = '#fef3c7';
                } else if (isBlocked) {
                    rowBg = '#fff5f5'; borderColor = '#fce8e8';
                } else {
                    rowBg = i % 2 === 0 ? '#f9feff' : '#ffffff'; borderColor = '#f0f4ff';
                }
            } else {
                rowBg = isBlocked ? '#fff5f5' : (i % 2 === 0 ? '#f9feff' : '#ffffff');
                borderColor = isBlocked ? '#fce8e8' : '#f0f4ff';
            }

            // Schedule column
            let schedCell: string;
            if (sched) {
                const rel = relativeETA(sched.buildDate);
                const facility = sched.designation === 'SOIL' ? 'Soil' : 'MFG';
                const isToday = rel.text === 'Today';
                const dot = isToday ? '&#9679; ' : '';
                schedCell = `<div style="font-family:${FONT};font-size:11px;font-weight:700;color:${rel.color};">${dot}${rel.text}</div>`
                    + `<div style="font-family:${FONT};font-size:10px;color:#94a3b8;margin-top:1px;">${sched.buildDate} &middot; ${facility} &middot; ${sched.quantity} units</div>`;
            } else {
                schedCell = `<span style="font-family:${FONT};font-size:11px;color:#94a3b8;font-style:italic;">No build on calendar</span>`;
            }

            // Status / blocking column
            let statusCell: string;
            if (blocking && isBlocked) {
                const blockers = blocking.components.filter(c => c.isBlocking);
                const names = blockers.slice(0, 2).map(b => {
                    let label = b.componentSku;
                    if (b.onOrder && b.onOrder > 0 && b.incomingPOs.length > 0) {
                        const po = b.incomingPOs[0];
                        const etaStr = po.expectedDelivery ? `, ETA ${po.expectedDelivery}` : '';
                        label += ` <a href="${po.finaleUrl}" style="color:#0d7377;text-decoration:none;font-size:10px;">PO#${po.orderId}${etaStr}</a>`;
                    }
                    return label;
                }).join(', ');
                const suffix = blockers.length > 2 ? ` +${blockers.length - 2}` : '';

                // BLOCKED badge in red pill
                statusCell = `<div style="margin-bottom:3px;"><span style="font-family:${FONT};font-size:9px;font-weight:800;letter-spacing:0.06em;color:#ffffff;background:#dc2626;padding:2px 7px;border-radius:3px;text-transform:uppercase;">BLOCKED</span></div>`
                    + `<div style="font-family:${FONT};font-size:11px;color:#dc2626;font-weight:600;margin-top:3px;">Awaiting ${names}${suffix}</div>`;
            } else if (!blocking || !blocking.hasBOM) {
                statusCell = `<span style="font-family:${FONT};font-size:11px;color:#2563eb;">No BOM in Finale — needs setup</span>`;
            } else if (sched) {
                statusCell = `<span style="font-family:${FONT};font-size:11px;color:#059669;font-weight:600;">Components ready</span>`;
            } else {
                statusCell = `<span style="font-family:${FONT};font-size:11px;color:#2563eb;font-weight:500;">Ready to schedule — components in stock</span>`;
            }

            return `<tr style="background:${rowBg}">
                <td class="sku-col" width="90" style="padding:10px 10px;border-bottom:1px solid ${borderColor};font-family:${MONO};font-size:10px;font-weight:700;color:#0e3a3b;vertical-align:top;">${item.sku}</td>
                <td style="padding:10px 10px;border-bottom:1px solid ${borderColor};font-family:${FONT};font-size:12px;color:#0e3a3b;font-weight:500;vertical-align:top;">${trunc(item.productName, 35)}</td>
                <td width="175" style="padding:10px 10px;border-bottom:1px solid ${borderColor};vertical-align:top;">${schedCell}</td>
                <td width="185" style="padding:10px 10px;border-bottom:1px solid ${borderColor};vertical-align:top;">${statusCell}</td>
            </tr>`;
        }).join('');
        buildsBlock = sect('Internal Builds — Manufacturing', '#2563eb', 'internal builds',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:2px;">
                <tr style="background:#eff6ff;">${colHdr('SKU', 90)}${colHdr('Product')}${colHdr('Build Schedule', 175)}${colHdr('Status', 185)}</tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows}
            </table>`);
    }

    // ── Not in Finale ──
    let missingBlock = '';
    if (missing.length > 0) {
        const skus = missing.map(i =>
            `<span style="font-family:${MONO};font-size:12px;font-weight:700;color:#0e3a3b;background:#ede9fe;padding:2px 8px;border-radius:4px;margin-left:6px;">${i.sku}</span>`
        ).join(' ');
        missingBlock = sect('Not in Finale', '#9333ea', 'not in finale',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr style="background:#faf5ff;"><td style="padding:12px 10px;font-family:${FONT};font-size:12px;color:#9333ea;font-weight:600;">
                These SKUs may be new products or bundles that need setup: ${skus}
            </td></tr></table>`);
    }

    let reviewBlock = '';
    if (reviewItems.length > 0) {
        const rows = reviewItems.map((item, i) => {
            const bg = i % 2 === 0 ? '#fffdf5' : '#ffffff';
            const shortStatus = item.actionRequired
                .replace(/^REVIEW — /, '')
                .replace(/\. Take down listing or reorder\?$/, '');
            return `<tr style="background:${bg}">
                <td class="sku-col" width="75" style="padding:10px 10px;border-bottom:1px solid #fef3c7;font-family:${MONO};font-size:11px;font-weight:700;color:#0e3a3b;vertical-align:top;white-space:nowrap;">${item.sku}</td>
                <td width="200" style="padding:10px 10px;border-bottom:1px solid #fef3c7;font-family:${FONT};font-size:12px;color:#0e3a3b;font-weight:500;vertical-align:top;">${trunc(item.productName, 45)}</td>
                <td style="padding:10px 10px;border-bottom:1px solid #fef3c7;font-family:${FONT};font-size:11px;color:#d97706;font-weight:600;vertical-align:top;">${shortStatus}</td>
            </tr>`;
        }).join('');
        reviewBlock = sect('Needs Review — Do Not Reorder', '#d97706', 'needs review',
            `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:2px;">
                <tr style="background:#fffbeb;">${colHdr('SKU', 75)}${colHdr('Product', 200)}${colHdr('Status')}</tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                ${rows}
            </table>`);
    }

    const shortDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Denver' });
    const filename = `OOS-Report-${new Date().toISOString().slice(0, 10)}.xlsx`;

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { margin: 0; padding: 0; background: #e8f4f4; }
  table { border-collapse: collapse; }
  img { border: 0; }
  @media only screen and (max-width: 600px) {
    .email-wrap { width: 100% !important; }
    .mobile-stack { display: block !important; width: 100% !important; }
    .mobile-hide { display: none !important; }
    .mobile-pad { padding: 12px !important; }
    .sku-col { width: 60px !important; font-size: 10px !important; }
    .stat-cell { display: block !important; width: 100% !important; margin-bottom: 6px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#e8f4f4;font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8f4f4;padding:24px 12px;">
<tr><td align="center">
<table class="email-wrap" width="680" cellpadding="0" cellspacing="0" border="0" style="width:680px;max-width:100%;">

  <!-- HEADER BANNER -->
  <tr>
    <td style="background:linear-gradient(135deg,#0a5c60 0%,#0d7377 40%,#14a085 100%);border-radius:12px 12px 0 0;padding:28px 32px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:top;">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="vertical-align:middle;padding-right:12px;">
                <div style="width:36px;height:36px;background:rgba(255,255,255,0.2);border-radius:8px;text-align:center;line-height:36px;font-size:18px;font-weight:900;color:white;font-family:${FONT};letter-spacing:-1px;">S</div>
              </td>
              <td style="vertical-align:middle;">
                <div style="font-family:${FONT};font-size:9px;letter-spacing:0.15em;color:rgba(255,255,255,0.65);text-transform:uppercase;margin-bottom:3px;">BuildASoil OPS</div>
                <div style="font-family:${FONT};font-size:22px;font-weight:700;color:#ffffff;line-height:1;letter-spacing:-0.5px;">Stock Out Digest</div>
                <div style="font-family:${FONT};font-size:10px;color:rgba(255,255,255,0.55);margin-top:5px;letter-spacing:0.04em;">Response to Stockie</div>
              </td>
            </tr></table>
            <div style="margin-top:12px;font-family:${FONT};font-size:12px;color:rgba(255,255,255,0.85);font-weight:600;">&#9888;&#xFE0F; ${tagline}</div>
          </td>
          <td style="vertical-align:top;text-align:right;">
            <div style="font-family:${FONT};font-size:9px;color:rgba(255,255,255,0.55);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">${dateStr}</div>
            <div style="font-family:${FONT};font-size:44px;font-weight:700;color:#ffffff;line-height:1;letter-spacing:-2px;">${result.totalItems}</div>
            <div style="font-family:${FONT};font-size:9px;color:rgba(255,255,255,0.55);letter-spacing:0.12em;text-transform:uppercase;">Items Flagged</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- SUMMARY COUNT BAR -->
  <tr>
    <td style="background:#ffffff;border-left:1px solid #cce8e8;border-right:1px solid #cce8e8;padding:16px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            ${qStat(urgent.length, 'Need PO', urgent.length > 0 ? '#dc2626' : '#6b7280')}
            ${qStat(reviewItems.length, 'Review', reviewItems.length > 0 ? '#d97706' : '#6b7280')}
            ${qStat(aging.length, 'Aging', aging.length > 0 ? '#92400e' : '#6b7280')}
            ${qStat(onOrder.length, 'On Order', '#0d7377')}
            ${qStat(receivedItems.length, 'Received', receivedItems.length > 0 ? '#059669' : '#6b7280')}
            ${qStat(builds.length, 'Builds', '#2563eb')}
            ${qStat(missing.length, 'Not Found', missing.length > 0 ? '#9333ea' : '#6b7280', true)}
      </tr></table>
    </td>
  </tr>

  <!-- SECTIONS -->
  ${urgentBlock}
  ${reviewBlock}
  ${agingBlock}
  ${onOrderBlock}
  ${receivedBlock}
  ${buildsBlock}
  ${missingBlock}

  <!-- FOOTER -->
  <tr>
    <td style="background:#0d7377;border-radius:0 0 12px 12px;padding:18px 28px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;">
          <div style="font-family:${FONT};font-size:10px;color:rgba(255,255,255,0.6);letter-spacing:0.05em;">
            &#128206; Full spreadsheet attached — opens in Google Sheets:
            <span style="color:rgba(255,255,255,0.9);font-weight:600;"> ${filename}</span>
          </div>
        </td>
        <td style="text-align:right;vertical-align:middle;">
          <div style="font-family:${FONT};font-size:10px;color:rgba(255,255,255,0.5);">
            Sent from <span style="color:rgba(255,255,255,0.85);font-weight:600;">BuildASoil OPS</span> &middot; via Stockie
          </div>
        </td>
      </tr></table>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body></html>`;
}

// ── HTML Helpers (new UI) ──

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif`;
const MONO = `'Courier New',Courier,monospace`;

/** Section-to-route mapping — department only, no personal names */
const ROUTE_MAP: Record<string, { route: string; color: string }> = {
    'needs ordering': { route: '→ Purchasing', color: '#dc2626' },
    'needs review': { route: '→ Purchasing', color: '#d97706' },
    'aging': { route: '→ Purchasing / Logistics', color: '#92400e' },
    'on order': { route: '→ Purchasing / Logistics', color: '#0d7377' },
    'received': { route: '→ Receiving / Ops', color: '#059669' },
    'internal builds': { route: '→ Manufacturing', color: '#2563eb' },
    'not in finale': { route: '→ Setup / Admin', color: '#9333ea' },
};

function qStat(value: number, label: string, color: string, last = false): string {
    const border = last ? '' : 'border-right:1px solid #e8f4f4;';
    return `<td class="stat-cell" style="text-align:center;padding:8px 10px;${border}vertical-align:middle;">
        <div style="font-family:${FONT};font-size:20px;font-weight:700;color:${color};line-height:1;">${value}</div>
        <div style="font-family:${FONT};font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;margin-top:2px;">${label}</div>
    </td>`;
}

/** Column header cell for section tables */
function colHdr(label: string, width?: number, align = 'left'): string {
    const w = width ? `width="${width}"` : '';
    return `<td ${w} style="padding:6px 10px;font-family:${FONT};font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;text-align:${align};">${label}</td>`;
}

/** Section header with colored pip + uppercase title + route label */
function sect(title: string, accent: string, routeKey: string, content: string): string {
    const info = ROUTE_MAP[routeKey] || { route: '', color: accent };
    const routeSpan = info.route
        ? `<td style="padding-left:10px;vertical-align:middle;"><span style="font-family:${FONT};font-size:10px;color:${info.color};font-weight:600;">${info.route}</span></td>`
        : '';
    return `
    <!-- SPACER -->
    <tr><td style="background:#ffffff;border-left:1px solid #cce8e8;border-right:1px solid #cce8e8;height:4px;"></td></tr>
    <tr>
      <td style="background:#ffffff;border-left:1px solid #cce8e8;border-right:1px solid #cce8e8;padding:0 20px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:10px;">
          <tr><td style="padding:16px 0 8px;border-bottom:2px solid ${accent};">
            <table cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding-right:10px;vertical-align:middle;"><div style="width:4px;height:16px;background:${accent};border-radius:2px;"></div></td>
              <td style="vertical-align:middle;"><span style="font-family:${FONT};font-size:11px;font-weight:700;color:#0e3a3b;text-transform:uppercase;letter-spacing:0.1em;">${title}</span></td>
              ${routeSpan}
            </tr></table>
          </td></tr>
        </table>
        ${content}
      </td>
    </tr>`;
}

function trunc(str: string, max: number): string {
    return str.length <= max ? str : str.slice(0, max - 1) + '\u2026';
}

// ──────────────────────────────────────────────────
// SLACK BODY BUILDER (mirrors buildEmailBody for #purchasing)
// ──────────────────────────────────────────────────

/**
 * Build a Slack mrkdwn version of the OOS report that mirrors the email body.
 * Same sections: Needs Ordering, Needs Review, Aging, On Order, Received,
 * Internal Builds, Not in Finale. Toned-down formatting — no heavy separators,
 * title-case headers, single-line items.
 *
 * DECISION(2026-03-19): This is the single source of OOS visibility in Slack.
 * Ops-manager appends Active Purchases to create one unified morning post.
 *
 * @param result          - Categorized report result from generateOOSExcel
 * @param items           - Enriched OOS items with PO/tracking data
 * @param scheduledBuilds - Calendar builds parsed from Google Calendar
 * @param buildBlockingMap - Per-SKU BOM blocking analysis
 * @returns Slack mrkdwn text ready for chat.postMessage
 */
export function buildSlackBody(
    result: OOSReportResult,
    items: EnrichedOOSItem[],
    scheduledBuilds: ParsedBuild[],
    buildBlockingMap: Map<string, BuildBlockingInfo>,
): string {
    const urgent = items.filter(i => result.needsOrder.includes(i.sku));
    const aging = items.filter(i => result.agingPOs.includes(i.sku));
    const onOrder = items.filter(i => result.onOrder.includes(i.sku));
    const builds = items.filter(i => result.internalBuild.includes(i.sku));
    const missing = items.filter(i => result.notInFinale.includes(i.sku));
    const receivedItems = items.filter(i => result.received.includes(i.sku));
    const reviewItems = items.filter(i => result.needsReview.includes(i.sku));

    // Build schedule map (same logic as email builder)
    const buildScheduleMap = new Map<string, ParsedBuild>();
    for (const b of scheduledBuilds) {
        const key = b.sku.toUpperCase();
        if (!buildScheduleMap.has(key) || b.buildDate < buildScheduleMap.get(key)!.buildDate) {
            buildScheduleMap.set(key, b);
        }
    }

    const findScheduledBuild = (sku: string): ParsedBuild | undefined => {
        const upper = sku.toUpperCase();
        if (buildScheduleMap.has(upper)) return buildScheduleMap.get(upper);
        for (const [calSku, build] of buildScheduleMap) {
            if (upper.startsWith(calSku) && calSku.length >= 4) return build;
        }
        for (const [calSku, build] of buildScheduleMap) {
            if (calSku.startsWith(upper) && upper.length >= 4) return build;
        }
        return undefined;
    };

    // Tagline — congruent with email
    const tagline = urgent.length === 0
        ? 'Everything has a PO or a plan. Nice.'
        : urgent.length <= 2
            ? `${urgent.length} item${urgent.length > 1 ? 's' : ''} without a PO. Probably worth a call.`
            : `${urgent.length} items sitting with no PO. Time to pick up the phone.`;

    const shortDate = new Date().toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        timeZone: 'America/Denver',
    });

    let msg = `*Stock Out Digest* — ${shortDate}  ·  ${result.totalItems} items flagged\n`;
    msg += `${tagline}\n\n`;

    // Stat bar
    msg += `${urgent.length} Need PO  ·  ${reviewItems.length} Review  ·  ${aging.length} Aging  ·  ${onOrder.length} On Order  ·  ${receivedItems.length} Received  ·  ${builds.length} Builds  ·  ${missing.length} Not Found`;

    // ── Needs Ordering ──
    if (urgent.length > 0) {
        msg += `\n\n*Needs Ordering — No PO on File*  _Purchasing_`;
        for (const item of urgent) {
            const supplier = item.finaleSupplier.split(';')[0]?.replace(/\s*\(\$[\d.]+\)/, '') || '—';
            msg += `\n\`${item.sku}\`  ${trunc(item.productName, 40)} — ${supplier}`;
        }
    }

    // ── Needs Review ──
    if (reviewItems.length > 0) {
        msg += `\n\n*Needs Review — Do Not Reorder*  _Purchasing_`;
        for (const item of reviewItems) {
            const shortStatus = item.actionRequired
                .replace(/^REVIEW — /, '')
                .replace(/\. Take down listing or reorder\?$/, '');
            msg += `\n\`${item.sku}\`  ${trunc(item.productName, 40)} — _${shortStatus}_`;
        }
    }

    // ── Aging POs ──
    if (aging.length > 0) {
        msg += `\n\n*Aging POs — Follow Up with Vendor*  _Purchasing / Logistics_`;
        for (const item of aging) {
            const po = item.openPOs[0];
            const age = po ? Math.floor((Date.now() - new Date(po.orderDate).getTime()) / 86_400_000) : 0;
            const tracking = slackTrackingLink(po);
            const poLink = po ? `<${po.finaleUrl}|${po.orderId}>` : '—';
            msg += `\n\`${item.sku}\`  ${trunc(item.productName, 35)} — ${poLink} · ${age}d old · ${tracking}`;
        }
    }

    // ── On Order ──
    if (onOrder.length > 0) {
        msg += `\n\n*On Order — POs in Progress*  _Purchasing / Logistics_`;
        for (const item of onOrder) {
            const po = item.openPOs[0];
            const eta = relativeETA(po?.expectedDelivery || null);
            const tracking = slackTrackingLink(po);
            const poLink = po ? `<${po.finaleUrl}|${po.orderId}>` : '—';
            msg += `\n\`${item.sku}\`  ${trunc(item.productName, 35)} — ${poLink} · ${eta.text} · ${tracking}`;
        }
    }

    // ── Received ──
    if (receivedItems.length > 0) {
        msg += `\n\n*Received — Still OOS*  _Receiving / Ops_`;
        for (const item of receivedItems) {
            const po = item.openPOs[0];
            const poLink = po ? `<${po.finaleUrl}|${po.orderId}>` : '—';
            msg += `\n\`${item.sku}\`  ${trunc(item.productName, 40)} — ${poLink} · Received`;
        }
    }

    // ── Internal Builds ──
    if (builds.length > 0) {
        const MAX_DISPLAY = 5;
        msg += `\n\n*Internal Builds*  _Manufacturing_`;
        const displayed = builds.slice(0, MAX_DISPLAY);
        for (const item of displayed) {
            const sched = findScheduledBuild(item.sku);
            const blocking = buildBlockingMap.get(item.sku.toUpperCase());
            const isBlocked = blocking && blocking.components.some(c => c.isBlocking);

            let schedPart: string;
            if (sched) {
                const rel = relativeETA(sched.buildDate);
                const facility = sched.designation === 'SOIL' ? 'Soil' : 'MFG';
                schedPart = `${rel.text} · ${facility} · ${sched.quantity} units`;
            } else {
                schedPart = 'No build scheduled';
            }

            let statusPart: string;
            if (isBlocked) {
                const blockers = blocking!.components.filter(c => c.isBlocking);
                const names = blockers.slice(0, 2).map(b => b.componentSku).join(', ');
                statusPart = `BLOCKED: awaiting ${names}`;
            } else if (!blocking || !blocking.hasBOM) {
                statusPart = 'No BOM — needs setup';
            } else if (sched) {
                statusPart = 'Components ready';
            } else {
                statusPart = 'Ready to build';
            }

            msg += `\n\`${item.sku}\`  ${trunc(item.productName, 35)} — ${schedPart} · ${statusPart}`;
        }
        if (builds.length > MAX_DISPLAY) {
            msg += `\n_+${builds.length - MAX_DISPLAY} more builds_`;
        }
    }

    // ── Not in Finale ──
    if (missing.length > 0) {
        msg += `\n\n*Not in Finale*  _Setup / Admin_`;
        msg += `\n` + missing.map(i => `\`${i.sku}\``).join('  ');
    }

    msg += `\n\n_Full spreadsheet attached to the email report_`;

    return msg;
}

/** Format tracking info for Slack — link if available, italic fallback */
function slackTrackingLink(po?: EnrichedPOInfo): string {
    if (!po) return '_awaiting ship_';
    if (po.trackingLinks?.length) {
        return `<${po.trackingLinks[0]}|${po.carrier || 'Track'} \u2192>`;
    }
    return '_awaiting ship_';
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
