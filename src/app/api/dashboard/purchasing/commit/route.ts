import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';
import {
    storePendingPOSend,
    getPendingPOSend,
    lookupVendorOrderEmail,
    retrySendEmail,
} from '@/lib/purchasing/po-sender';
import { executePOSendAction } from '@/lib/copilot/actions';
import { invalidatePurchasingCaches } from '@/lib/purchasing/cache';

/**
 * POST /api/dashboard/purchasing/commit
 *
 * Two-step:
 *   action=review  → fetch PO details + vendor email, store pending, return review data
 *   action=send    → commit in Finale + send email (requires sendId from review step)
 *   action=cancel  → discard pending, PO stays as draft
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { action } = body;

        if (action === 'review') {
            const { orderId } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

            const client = new FinaleClient();
            const review = await client.getDraftPOForReview(orderId);

            if (!review.canCommit) {
                return NextResponse.json(
                    { error: `PO #${orderId} is not in draft status — cannot commit` },
                    { status: 409 }
                );
            }

            // Hard-stop: any zero-qty line means the draft is malformed
            const zeroQtyLines = review.items.filter(i => !i.quantity || i.quantity === 0);
            if (zeroQtyLines.length > 0) {
                return NextResponse.json(
                    { error: 'Draft has lines with qty=0; fix in Finale before sending' },
                    { status: 400 }
                );
            }

            const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);
            const sendId = await storePendingPOSend(orderId, review, email, source, {
                channel: 'dashboard',
            });

            // Soft warnings — UI surfaces but does not block
            const warnings: string[] = [];
            if (review.total < 10) warnings.push(`total $${review.total.toFixed(2)} below $10 — confirm before sending`);
            if (!email) warnings.push('no vendor email on file');

            return NextResponse.json({
                review,
                email,
                emailSource: source,
                sendId,
                ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
            });

        } else if (action === 'send') {
            const { sendId } = body;
            if (!sendId) return NextResponse.json({ error: 'sendId required' }, { status: 400 });

            const pending = await getPendingPOSend(sendId);
            if (!pending) {
                return NextResponse.json(
                    { error: 'Send session expired or not found — start a new review' },
                    { status: 404 }
                );
            }

            const result = await executePOSendAction({
                sendId,
                triggeredBy: 'dashboard',
                skipEmail: body.skipEmail || false,
            });

            // DECISION(2026-05-19, Will): once the PO is committed in Finale, the
            // affected SKUs must drop out of the Ordering panel ("If PO is generated
            // no more ordering"). getPurchasingIntelligence already skips items with
            // any open ORDER_LOCKED PO — but the dashboard reads from a 30-min
            // module cache. Invalidate it here so the next GET (which the panel
            // fires via load(true)) actually re-fetches and the row disappears.
            if (result.status !== 'failed') {
                invalidatePurchasingCaches();
            }

            // Bubble verification to top-level so dashboard doesn't need to dig into details
            const verification = (result as any)?.details?.verification ?? null;
            return NextResponse.json(
                { ...result, ...(verification ? { verification } : {}) },
                { status: result.status === 'failed' ? 404 : 200 },
            );

        } else if (action === 'retry-email') {
            const { sendId } = body;
            if (!sendId) return NextResponse.json({ error: 'sendId required' }, { status: 400 });
            try {
                const result = await retrySendEmail(sendId, 'dashboard');
                if (result.emailSent) invalidatePurchasingCaches();
                return NextResponse.json({
                    status: result.emailSent ? 'success' : 'partial_success',
                    userMessage: result.emailSent
                        ? `PO #${result.orderId} emailed to ${result.sentTo} via ${result.emailVia === 'gmail-fallback' ? 'Gmail fallback' : 'Finale native'}`
                        : `Retry failed for PO #${result.orderId}: ${result.emailError}`,
                    details: result,
                });
            } catch (err: any) {
                return NextResponse.json({ status: 'failed', error: err.message }, { status: 400 });
            }

        } else if (action === 'cancel') {
            const { sendId } = body;
            if (sendId) {
                const { expirePendingPOSend } = await import('@/lib/purchasing/po-sender');
                await expirePendingPOSend(sendId);
            }
            return NextResponse.json({ cancelled: true });

        } else {
            return NextResponse.json({ error: 'action must be review | send | cancel' }, { status: 400 });
        }
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
