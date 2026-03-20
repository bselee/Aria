/**
 * @file    amazon-order-parser.ts
 * @purpose Parses Amazon order confirmation and shipping notification emails.
 *          Extracts order #, items, quantities, prices, tracking, and ETA.
 *          Matches orders to pending Slack requests and sends Telegram
 *          notifications for Will's review before notifying requesters.
 * @author  Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    supabase, zod, intelligence/llm, axios
 */

import { createClient } from '../../supabase';
import { unifiedObjectGeneration } from '../llm';
import { z } from 'zod';
import axios from 'axios';

// ── Types ────────────────────────────────────────────────────────────────────

interface AmazonEmailInput {
    gmailMessageId: string;
    from: string;
    subject: string;
    bodyText: string;
    type: string; // e.g., 'Amazon Order Confirmation', 'Amazon Shipping'
}

const AmazonOrderSchema = z.object({
    orderId: z.string().describe('Amazon order ID in format like 112-1234567-1234567'),
    items: z.array(z.object({
        name: z.string().describe('Product name as listed on Amazon'),
        quantity: z.number().describe('Quantity ordered'),
        price: z.number().nullable().describe('Unit price if visible, null otherwise'),
    })).describe('All items in the order'),
    total: z.number().nullable().describe('Order total in USD, null if not visible'),
    estimatedDelivery: z.string().nullable().describe('Estimated delivery date as text, null if not mentioned'),
    trackingNumber: z.string().nullable().describe('Tracking number if present, null otherwise'),
    carrier: z.string().nullable().describe('Shipping carrier (UPS, USPS, FedEx, Amazon) if mentioned, null otherwise'),
});

type AmazonOrderData = z.infer<typeof AmazonOrderSchema>;

// ── Parser ───────────────────────────────────────────────────────────────────

export class AmazonOrderParser {

    /**
     * Main entry point. Processes an Amazon email and updates the tracking pipeline.
     */
    async processEmail(input: AmazonEmailInput): Promise<void> {
        console.log(`[AmazonOrderParser] Processing: "${input.subject}" (${input.type})`);

        // Step 1: Extract order data from email using LLM + regex
        const orderData = await this.extractOrderData(input);
        if (!orderData || !orderData.orderId) {
            console.warn(`[AmazonOrderParser] Could not extract order data from: "${input.subject}"`);
            return;
        }

        console.log(`[AmazonOrderParser] Order #${orderData.orderId}: ${orderData.items.length} item(s)`);

        const supabase = createClient();
        if (!supabase) return;

        // Step 2: Check if this order was already processed
        const { data: existing } = await supabase
            .from('slack_requests')
            .select('id, status, amazon_order_id')
            .eq('amazon_order_id', orderData.orderId)
            .limit(1);

        const isShippingUpdate = input.type.includes('Shipping') ||
            input.type.includes('Tracking') ||
            !!orderData.trackingNumber;

        if (existing?.length && isShippingUpdate) {
            // This is a shipping update for an already-matched order
            await this.handleShippingUpdate(existing[0].id, orderData);
            return;
        }

        if (existing?.length) {
            console.log(`[AmazonOrderParser] Order #${orderData.orderId} already processed, skipping`);
            return;
        }

        // Step 3: Try to match to a pending Slack request
        const match = await this.matchToSlackRequest(supabase, orderData);

        // Step 4: Update the slack_request record
        if (match) {
            await supabase
                .from('slack_requests')
                .update({
                    status: isShippingUpdate ? 'shipped' : 'ordered',
                    amazon_order_id: orderData.orderId,
                    amazon_items: orderData.items,
                    amazon_total: orderData.total,
                    tracking_number: orderData.trackingNumber,
                    carrier: orderData.carrier,
                    estimated_delivery: orderData.estimatedDelivery
                        ? this.parseDeliveryDate(orderData.estimatedDelivery)
                        : null,
                    matched_at: new Date().toISOString(),
                })
                .eq('id', match.id);

            console.log(`[AmazonOrderParser] Matched order #${orderData.orderId} to Slack request from ${match.requester_name}`);
        } else {
            // No Slack request match — still record the order for spend tracking
            // Insert a new slack_request record with just the Amazon data
            await supabase.from('slack_requests').insert({
                channel_id: 'unmatched',
                channel_name: 'Amazon (no Slack request)',
                message_ts: `amazon_${orderData.orderId}`,
                requester_user_id: 'system',
                requester_name: 'Amazon Direct',
                original_text: `Amazon order ${orderData.orderId}`,
                items_requested: orderData.items.map(i => i.name),
                status: isShippingUpdate ? 'shipped' : 'ordered',
                amazon_order_id: orderData.orderId,
                amazon_items: orderData.items,
                amazon_total: orderData.total,
                tracking_number: orderData.trackingNumber,
                carrier: orderData.carrier,
                estimated_delivery: orderData.estimatedDelivery
                    ? this.parseDeliveryDate(orderData.estimatedDelivery)
                    : null,
            });
        }

        // Step 5: Notify Will on Telegram with order summary
        // DECISION(2026-03-19): No auto-reply to Slack. Will reviews on Telegram
        // and can approve a Slack notification via /notify command.
        await this.notifyTelegram(orderData, match);
    }

    /**
     * Extracts structured order data from an Amazon email body.
     * Uses regex for the order ID (highly structured) and LLM for everything else.
     */
    private async extractOrderData(input: AmazonEmailInput): Promise<AmazonOrderData | null> {
        // Regex: Amazon order IDs are consistently formatted
        const orderIdMatch = input.bodyText.match(/\b(\d{3}-\d{7}-\d{7})\b/)
            || input.subject.match(/\b(\d{3}-\d{7}-\d{7})\b/);

        if (!orderIdMatch) {
            // If no order ID found in text, this may not be an order email
            console.warn(`[AmazonOrderParser] No order ID pattern found in email body`);
            return null;
        }

        // Regex: tracking numbers
        const tracking = this.extractTracking(input.bodyText);

        try {
            const result = await unifiedObjectGeneration({
                system: `You are parsing an Amazon order email. Extract all order details precisely.
The order ID is: ${orderIdMatch[1]}
If you cannot determine a field, return null for it.
For items, extract every distinct product with its name, quantity, and unit price.
For estimated delivery, return the date as written (e.g., "Thursday, March 27").`,
                prompt: input.bodyText.substring(0, 4000), // Cap to avoid token limits
                schema: AmazonOrderSchema,
                schemaName: 'AmazonOrder',
                temperature: 0.0,
            });

            // Override with regex-extracted values (more reliable)
            result.orderId = orderIdMatch[1];
            if (tracking) {
                result.trackingNumber = tracking.number;
                result.carrier = tracking.carrier || result.carrier;
            }

            return result;
        } catch (err: any) {
            console.error(`[AmazonOrderParser] LLM extraction failed:`, err.message);

            // Fallback: return just the regex-extracted data
            return {
                orderId: orderIdMatch[1],
                items: [{ name: input.subject, quantity: 1, price: null }],
                total: null,
                estimatedDelivery: null,
                trackingNumber: tracking?.number || null,
                carrier: tracking?.carrier || null,
            };
        }
    }

    /**
     * Extract tracking number and carrier from email body using common patterns.
     */
    private extractTracking(text: string): { number: string; carrier: string | null } | null {
        // UPS: 1Z followed by alphanumeric
        const ups = text.match(/\b(1Z[A-Z0-9]{16,18})\b/i);
        if (ups) return { number: ups[1], carrier: 'UPS' };

        // USPS: 20-22 digit number or starts with 92/93/94
        const usps = text.match(/\b(9[2-4]\d{18,22})\b/);
        if (usps) return { number: usps[1], carrier: 'USPS' };

        // FedEx: 12 or 15 digit number
        const fedex = text.match(/\b(\d{12}|\d{15})\b/);
        if (fedex) return { number: fedex[1], carrier: 'FedEx' };

        // Amazon's own tracking: TBA followed by digits
        const tba = text.match(/\b(TBA\d{12,})\b/i);
        if (tba) return { number: tba[1], carrier: 'Amazon' };

        return null;
    }

    /**
     * Match an Amazon order to a pending Slack request by item name similarity and timing.
     */
    private async matchToSlackRequest(
        supabase: ReturnType<typeof createClient>,
        orderData: AmazonOrderData
    ): Promise<{ id: string; requester_name: string; channel_id: string; message_ts: string; thread_ts: string | null } | null> {
        if (!supabase) return null;

        // Get pending Slack requests from the last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: pending } = await supabase
            .from('slack_requests')
            .select('id, requester_name, channel_id, message_ts, thread_ts, items_requested, created_at')
            .eq('status', 'pending')
            .gte('created_at', sevenDaysAgo.toISOString())
            .order('created_at', { ascending: false });

        if (!pending?.length) return null;

        // Score each pending request by item name similarity
        const amazonItemNames = orderData.items.map(i => i.name.toLowerCase());

        let bestMatch: typeof pending[0] | null = null;
        let bestScore = 0;

        for (const req of pending) {
            const requestedItems = (req.items_requested || []).map((i: string) => i.toLowerCase());
            let score = 0;

            for (const requested of requestedItems) {
                for (const amazonItem of amazonItemNames) {
                    // Check if the requested item name appears in the Amazon item name
                    if (amazonItem.includes(requested) || requested.includes(amazonItem)) {
                        score += 10; // Strong match
                    } else {
                        // Word-level overlap
                        const requestedWords = requested.split(/\s+/).filter(w => w.length > 2);
                        const amazonWords = amazonItem.split(/\s+/).filter(w => w.length > 2);
                        const overlap = requestedWords.filter(w => amazonWords.some(aw => aw.includes(w)));
                        score += overlap.length * 3;
                    }
                }
            }

            // Recency bonus: requests from today score higher
            const ageHours = (Date.now() - new Date(req.created_at).getTime()) / (1000 * 60 * 60);
            if (ageHours < 24) score += 2;
            if (ageHours < 4) score += 3;

            if (score > bestScore) {
                bestScore = score;
                bestMatch = req;
            }
        }

        // Require a minimum score to avoid false matches
        if (bestScore < 3) return null;

        return bestMatch;
    }

    /**
     * Handle a shipping update for an already-matched order.
     */
    private async handleShippingUpdate(requestId: string, orderData: AmazonOrderData): Promise<void> {
        const supabase = createClient();
        if (!supabase) return;

        const updates: Record<string, any> = { status: 'shipped' };
        if (orderData.trackingNumber) updates.tracking_number = orderData.trackingNumber;
        if (orderData.carrier) updates.carrier = orderData.carrier;
        if (orderData.estimatedDelivery) {
            updates.estimated_delivery = this.parseDeliveryDate(orderData.estimatedDelivery);
        }

        await supabase.from('slack_requests').update(updates).eq('id', requestId);

        // Get the request details for Telegram notification
        const { data: req } = await supabase
            .from('slack_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (req) {
            await this.notifyTelegramShipping(orderData, req);
        }

        console.log(`[AmazonOrderParser] Shipping update for order #${orderData.orderId}`);
    }

    /**
     * Send a Telegram notification for a new Amazon order.
     * DECISION(2026-03-19): Will reviews on Telegram. No auto-Slack notification.
     * If matched to a Slack request, include /notify command for manual approval.
     */
    private async notifyTelegram(
        order: AmazonOrderData,
        match: { id: string; requester_name: string } | null
    ): Promise<void> {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) return;

        const itemList = order.items
            .map(i => `  ${i.quantity}x ${i.name}${i.price ? ` ($${i.price.toFixed(2)})` : ''}`)
            .join('\n');

        let message = `Amazon Order Detected\n\n`;
        message += `Order: ${order.orderId}\n`;
        if (order.total) message += `Total: $${order.total.toFixed(2)}\n`;
        if (order.estimatedDelivery) message += `Delivery: ${order.estimatedDelivery}\n`;
        message += `\nItems:\n${itemList}\n`;

        if (match) {
            message += `\nMatched to Slack request from ${match.requester_name}`;
            message += `\nApprove Slack notification: /notify ${match.id}`;
        } else {
            message += `\nNo matching Slack request found (Amazon direct purchase)`;
        }

        if (order.trackingNumber) {
            message += `\nTracking: ${order.trackingNumber} (${order.carrier || 'Unknown'})`;
        }

        try {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
            });
        } catch (err: any) {
            console.error(`[AmazonOrderParser] Telegram notification failed:`, err.message);
        }
    }

    /**
     * Send a Telegram notification for a shipping update.
     * Includes /notify command for Will to approve sending to the Slack requester.
     */
    private async notifyTelegramShipping(
        order: AmazonOrderData,
        request: any
    ): Promise<void> {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) return;

        let message = `Amazon Order Shipped\n\n`;
        message += `Order: ${order.orderId}\n`;
        if (order.trackingNumber) message += `Tracking: ${order.trackingNumber} (${order.carrier || 'Unknown'})\n`;
        if (order.estimatedDelivery) message += `ETA: ${order.estimatedDelivery}\n`;

        if (request.requester_name && request.requester_name !== 'Amazon Direct') {
            message += `\nRequested by: ${request.requester_name}`;
            message += `\nApprove Slack notification: /notify ${request.id}`;
        }

        try {
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: message,
            });
        } catch (err: any) {
            console.error(`[AmazonOrderParser] Telegram shipping notification failed:`, err.message);
        }
    }

    /**
     * Attempt to parse a natural language date like "Thursday, March 27" into ISO date.
     */
    private parseDeliveryDate(dateStr: string): string | null {
        try {
            const d = new Date(dateStr);
            if (!isNaN(d.getTime())) {
                return d.toISOString().split('T')[0]; // YYYY-MM-DD
            }

            // Try adding current year
            const withYear = `${dateStr}, ${new Date().getFullYear()}`;
            const d2 = new Date(withYear);
            if (!isNaN(d2.getTime())) {
                return d2.toISOString().split('T')[0];
            }
        } catch { /* fall through */ }

        return null;
    }
}
