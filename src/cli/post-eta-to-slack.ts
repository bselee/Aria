#!/usr/bin/env node
/**
 * @file    src/cli/post-eta-to-slack.ts
 * @purpose Query POs in ACKNOWLEDGED state with tracking numbers and no ETA Slack
 *          notification yet. Posts formatted ETA to #purchase-orders and marks notified.
 * @usage   node --import tsx src/cli/post-eta-to-slack.ts
 *
 * Slack format:  *Ordered <Finale-url|PO-####> ETA mm/dd*
 *
 * DESIGN: Idempotent — uses eta_slack_notified_at column to track which POs
 * have already been posted. Safety cap of 20 POs per run.
 */

import { WebClient } from '@slack/web-api';

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || process.env.SLACK_ACCESS_TOKEN;
const SLACK_CHANNEL = '#purchase-orders';
const PGRST_URL = process.env.PGRST_URL || 'http://localhost:5434';
const MAX_PER_RUN = 20;

interface PostResult {
    poNumber: string;
    action: 'posted' | 'skipped_no_eta' | 'error';
    eta?: string;
    error?: string;
}

function formatDate(dateStr: string): string {
    try {
        const d = new Date(dateStr);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    } catch {
        return dateStr?.slice(5, 10) || '?';
    }
}

function buildFinaleUrl(poNumber: string): string {
    return `https://app.finaleinventory.com/buildasoilorganics/sc2/?order/purchase/order/L2J1aWxkYXNvaWxvcmdhbmljcy9wdXJjaGFzZS9vcmRlci9wdXJjaGFzZS9vcmRlci8ke3BvTnVtYmVyfQ%3D%3D`
        .replace('${poNumber}', poNumber);
}

export async function postETAtoSlack(): Promise<{ posted: number; results: PostResult[] }> {
    if (!SLACK_TOKEN) {
        console.error('[post-eta-to-slack] No Slack token found (SLACK_BOT_TOKEN or SLACK_ACCESS_TOKEN)');
        return { posted: 0, results: [] };
    }

    const slack = new WebClient(SLACK_TOKEN);
    const results: PostResult[] = [];

    try {
        // Query POs in ACKNOWLEDGED state with tracking numbers, not yet notified
        const url = `${PGRST_URL}/purchase_orders?select=po_number,tracking_numbers,vendor_stated_eta,eta_slack_notified_at&status=eq.ACKNOWLEDGED&tracking_numbers=not.is.null&eta_slack_notified_at=is.null&limit=${MAX_PER_RUN}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`PostgREST query failed: ${res.status} ${res.statusText}`);
        
        const pos: any[] = await res.json();
        if (pos.length === 0) {
            console.log('[post-eta-to-slack] No POs awaiting ETA notification');
            return { posted: 0, results: [] };
        }

        console.log(`[post-eta-to-slack] Found ${pos.length} POs to notify`);

        for (const po of pos) {
            try {
                // Determine best ETA
                let eta: string | null = null;
                if (po.vendor_stated_eta) {
                    eta = po.vendor_stated_eta;
                }

                if (!eta) {
                    results.push({ poNumber: po.po_number, action: 'skipped_no_eta' });
                    continue;
                }

                const etaFormatted = formatDate(eta);
                const finaleUrl = buildFinaleUrl(po.po_number);
                const message = `*Ordered <${finaleUrl}|PO-${po.po_number}> ETA ${etaFormatted}*`;

                // Post to Slack
                await slack.chat.postMessage({
                    channel: SLACK_CHANNEL,
                    text: message,
                    mrkdwn: true,
                });

                // Mark as notified
                await fetch(`${PGRST_URL}/purchase_orders?po_number=eq.${po.po_number}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
                    body: JSON.stringify({ eta_slack_notified_at: new Date().toISOString() }),
                });

                results.push({ poNumber: po.po_number, action: 'posted', eta: etaFormatted });
                console.log(`  ✅ PO-${po.po_number} ETA ${etaFormatted} → #purchase-orders`);

            } catch (poErr: any) {
                results.push({ poNumber: po.po_number, action: 'error', error: poErr.message });
                console.error(`  ❌ PO-${po.po_number}: ${poErr.message}`);
            }
        }

    } catch (err: any) {
        console.error(`[post-eta-to-slack] Fatal: ${err.message}`);
    }

    const posted = results.filter(r => r.action === 'posted').length;
    return { posted, results };
}

// CLI entry
const isMainModule = process.argv[1]?.includes('post-eta-to-slack');
if (isMainModule) {
    postETAtoSlack().then(({ posted, results }) => {
        const errors = results.filter(r => r.action === 'error').length;
        console.log(`[post-eta-to-slack] ${posted} posted, ${results.filter(r => r.action === 'skipped_no_eta').length} skipped, ${errors} errors`);
    }).catch(err => {
        console.error(`[post-eta-to-slack] Fatal: ${err.message}`);
        process.exit(1);
    });
}
