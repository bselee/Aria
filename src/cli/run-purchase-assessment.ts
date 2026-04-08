/**
 * run-purchase-assessment.ts — Full pipeline: scrape → assess → store → diff → Telegram
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { exec } from 'child_process';
import { promisify } from 'util';
import { Telegraf } from 'telegraf';
import { assess, AssessmentResult } from '../lib/purchases/assessor';
import { createClient } from '../lib/supabase';

const execAsync = promisify(exec);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    process.exit(1);
}

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

function formatHighNeedItem(item: any): string {
    const dr = item.dailyRate ?? item.daily_rate ?? 0;
    const ltd = item.leadTimeDays ?? item.lead_time_days ?? 14;
    const runway = item.adjustedRunwayDays ?? item.adjusted_runway_days ?? 0;
    const suggest = Math.max(1, Math.ceil(dr * (ltd + 60)));
    return `<b>${item.sku}</b> — ${item.description}\n` +
           `Stock: ${item.stockOnHand ?? item.stock_on_hand ?? 0} | Daily rate: ${dr.toFixed(2)} | Runway: ${runway}d\n` +
           `→ Suggest ordering ~${suggest}\n` +
           `${item.explanation}\n`;
}

function formatRequestItem(item: any): string {
    const score = item.fuzzyMatchScore ?? item.fuzzy_match_score;
    const scorePart = score !== undefined ? ` (match: ${score.toFixed(2)})` : '';
    const skuPart = item.sku && item.sku !== '(no match)' && item.sku !== '(error)' ? `<code>${item.sku}</code>` : '<i>no match</i>';
    return `<b>${skuPart}</b> — ${item.rawDetails || item.description}\n` +
           `Department: ${item.vendor} | Necessity: ${item.necessity}\n` +
           `${scorePart}\n`;
}

async function main() {
    console.log('🚀 Starting purchase assessment pipeline...');
    let scrapeSuccess = false;
    let scrapeError = '';

    // 1) Scrape
    console.log('  [1/5] Running scraper...');
    try {
        await execAsync('node --import tsx src/cli/scrape-purchases.ts', { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
        scrapeSuccess = true;
        console.log('  ✅ Scraper completed');
    } catch (err: any) {
        scrapeSuccess = false;
        scrapeError = err.stderr || err.message || 'Unknown error';
        console.error('  ❌ Scraper failed:', scrapeError);
    }

    // 2) Assess (only if scrape succeeded)
    let assessmentResult: AssessmentResult | null = null;
    if (scrapeSuccess) {
        console.log('  [2/5] Assessing...');
        try {
            assessmentResult = await assess({});
            console.log(`  ✅ Assessment complete: ${assessmentResult.allAssessed.length} items`);
        } catch (err: any) {
            console.error('  ❌ Assessment failed:', err.message);
            // Proceed to Telegram without storage/diff
        }
    } else {
        console.log('  [2/5] Skipping assessment due to scraper failure');
    }

    // 3) Store snapshot
    let runId: string | null = null;
    if (assessmentResult) {
        console.log('  [3/5] Storing snapshot...');
        const supabase = createClient();
        if (!supabase) {
            console.warn('  ⚠️ No Supabase — skipping storage');
        } else {
            try {
                const { data: runRow, error: runErr } = await supabase
                    .from('purchase_assessment_runs')
                    .insert({
                        scrape_success: scrapeSuccess,
                        auth_redirected: scrapeError.toLowerCase().includes('not signed in') || scrapeError.toLowerCase().includes('/auth/signin'),
                    })
                    .select('id')
                    .single();

                if (runErr || !runRow) {
                    console.error('  ❌ Failed to insert run record:', runErr?.message);
                } else {
                    runId = runRow.id;
                    const itemsToInsert = assessmentResult.allAssessed.map(item => ({
                        run_id: runId,
                        source: item.source,
                        vendor: item.vendor,
                        sku: item.sku,
                        description: item.description,
                        raw_details: item.rawDetails,
                        raw_request_json: item.rawRequest,
                        fuzzy_match_score: item.fuzzyMatchScore,
                        scraped_urgency: item.scrapedUrgency,
                        necessity: item.necessity,
                        stock_on_hand: item.stockOnHand,
                        stock_on_order: item.stockOnOrder,
                        sales_velocity: item.salesVelocity,
                        purchase_velocity: item.purchaseVelocity,
                        daily_rate: item.dailyRate,
                        runway_days: item.runwayDays,
                        adjusted_runway_days: item.adjustedRunwayDays,
                        lead_time_days: item.leadTimeDays,
                        open_pos_json: item.openPOs,
                        explanation: item.explanation,
                        finale_found: item.finaleFound,
                        do_not_reorder: item.doNotReorder,
                    }));

                    const { error: insertErr } = await supabase
                        .from('purchase_assessments')
                        .insert(itemsToInsert);
                    if (insertErr) {
                        console.error('  ❌ Failed to insert items:', insertErr.message);
                    } else {
                        console.log(`  ✅ Stored ${itemsToInsert.length} items`);
                    }
                }
            } catch (e: any) {
                console.error('  ❌ Storage error:', e.message);
            }
        }
    }

    // 4) Diff
    let newHighNeed: any[] = [];
    let newRequests: any[] = [];
    if (runId && assessmentResult) {
        console.log('  [4/5] Diffing against previous snapshot...');
        const supabase = createClient();
        if (supabase) {
            try {
                const { data: prevRuns, error: prevErr } = await supabase
                    .from('purchase_assessment_runs')
                    .select('id')
                    .lt('run_at', new Date().toISOString())
                    .order('run_at', { ascending: false })
                    .limit(1);
                if (prevErr) throw prevErr;

                if (prevRuns && prevRuns.length > 0) {
                    const prevRunId = prevRuns[0].id;
                    const { data: prevItems, error: prevItemsErr } = await supabase
                        .from('purchase_assessments')
                        .select('*')
                        .eq('run_id', prevRunId);
                    if (prevItemsErr) throw prevItemsErr;

                    const prevMap = new Map<string, any>();
                    for (const pi of prevItems || []) {
                        const key = `${pi.sku}|${pi.source}|${pi.vendor}`;
                        prevMap.set(key, pi);
                    }

                    for (const cur of assessmentResult.allAssessed) {
                        const key = `${cur.sku}|${cur.source}|${cur.vendor}`;
                        const prev = prevMap.get(key);
                        if (!prev) {
                            if (cur.necessity === 'HIGH_NEED') newHighNeed.push(cur);
                            if (cur.source === 'TEAM_REQUEST') newRequests.push(cur);
                        } else {
                            if (cur.necessity === 'HIGH_NEED' && prev.necessity !== 'HIGH_NEED') {
                                newHighNeed.push(cur);
                            }
                        }
                    }
                } else {
                    newHighNeed = assessmentResult.allAssessed.filter(i => i.necessity === 'HIGH_NEED');
                    newRequests = assessmentResult.allAssessed.filter(i => i.source === 'TEAM_REQUEST');
                }
                console.log(`  ✅ Diff: ${newHighNeed.length} new HIGH_NEED, ${newRequests.length} new requests`);
            } catch (e: any) {
                console.error('  ❌ Diff error:', e.message);
            }
        }
    }

    // 5) Telegram
    console.log('  [5/5] Sending Telegram digest...');
    let message = '<b>📊 Purchase Assessment Report</b>\n\n';
    message += `🕐 Run at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}\n`;
    message += `📈 Total items: ${assessmentResult?.allAssessed.length || 0}\n`;
    if (assessmentResult) {
        const high = assessmentResult.allAssessed.filter(i => i.necessity === 'HIGH_NEED').length;
        const med = assessmentResult.allAssessed.filter(i => i.necessity === 'MEDIUM').length;
        const low = assessmentResult.allAssessed.filter(i => i.necessity === 'LOW').length;
        const noise = assessmentResult.allAssessed.filter(i => i.necessity === 'NOISE').length;
        message += `🔴 HIGH NEED: ${high} | 🟡 MEDIUM: ${med} | 🟠 LOW: ${low} | ⚪ NOISE: ${noise}\n`;
    }

    if (!scrapeSuccess) {
        message += `\n⚠️ <b>Scraper failed!</b>\n`;
        message += `Please refresh your .basauto-session.json from Chrome DevTools.\n`;
        message += `Error: ${scrapeError.substring(0, 200)}...\n`;
    }

    if (newHighNeed.length > 0) {
        message += '\n<b>🔥 New HIGH NEED items:</b>\n';
        for (const item of newHighNeed.slice(0, 20)) {
            message += formatHighNeedItem(item);
        }
        if (newHighNeed.length > 20) message += `...and ${newHighNeed.length - 20} more\n`;
    }

    if (newRequests.length > 0) {
        message += '\n<b>📋 New Pending Requests:</b>\n';
        for (const item of newRequests.slice(0, 20)) {
            message += formatRequestItem(item);
        }
        if (newRequests.length > 20) message += `...and ${newRequests.length - 20} more\n`;
    }

    try {
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true });
        console.log('  ✅ Telegram sent');
    } catch (err: any) {
        console.error('  ❌ Telegram failed:', err.message);
    }

    console.log('✅ Pipeline complete');
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
