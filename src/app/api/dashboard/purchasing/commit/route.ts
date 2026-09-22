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
 * Whether Aria is allowed to email a purchase order to a vendor.
 *
 * DECISION(2026-09-21, Bill): "only drafts created in Finale for now" — the
 * dashboard must not be able to put a PO in a vendor's inbox. Every
 * vendor-facing send action is gated on this flag; it defaults to OFF, so a
 * missing or unset variable means no sends. Set
 * `NEXT_PUBLIC_ARIA_PO_SEND_ENABLED=true` to re-enable.
 *
 * @returns true only when the flag is explicitly set to "true".
 */
function poSendEnabled(): boolean {
    return process.env.NEXT_PUBLIC_ARIA_PO_SEND_ENABLED === 'true';
}

/**
 * POST /api/dashboard/purchasing/commit
 *
 * Actions:
 *   action=review      → fetch PO details + vendor email, store pending, return review data
 *   action=send        → commit in Finale + send email (requires sendId from review step)
 *   action=send-direct → combined review+send — commits and emails in one call (no modal)
 *   action=cancel      → discard pending send session, PO stays as draft in Finale
 *   action=cancel-draft→ cancel the PO in Finale (ORDER_CREATED → ORDER_CANCELED)
 *
 * Send actions (`send`, `send-direct`, `retry-email`) are refused with 403
 * unless PO sending is explicitly enabled — see poSendEnabled().
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { action } = body;

        // Vendor-facing kill switch — checked before anything touches Finale
        // or Gmail so a disabled system cannot email a vendor by any path.
        if (['send', 'send-direct', 'retry-email'].includes(action) && !poSendEnabled()) {
            return NextResponse.json(
                { error: 'Vendor PO email is disabled (NEXT_PUBLIC_ARIA_PO_SEND_ENABLED). Send from Finale.' },
                { status: 403 },
            );
        }

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

        } else if (action === 'send-direct') {
            // Combined review+send: commits PO and emails vendor in one call.
            // No modal — used ONLY by the explicit Send button.
            //
            // DECISION(2026-09-21, Bill): draft creation must never email a
            // vendor. Ordering builds drafts only; this action is the separate,
            // deliberate send path. confirmSend is required so a stale or
            // accidental send-direct call can never put a PO in a vendor inbox.
            const { orderId, vendorPartyId, confirmSend } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });
            if (confirmSend !== true) {
                return NextResponse.json(
                    { error: 'send-direct requires confirmSend:true — draft creation must not email vendors' },
                    { status: 400 },
                );
            }

            const client = new FinaleClient();
            const review = await client.getDraftPOForReview(orderId);

            if (!review.canCommit) {
                return NextResponse.json({ error: `PO #${orderId} is not in draft status` }, { status: 409 });
            }

            const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);
            if (!email) {
                return NextResponse.json({ error: `No vendor email on file for ${review.vendorName}` }, { status: 400 });
            }

            const sendId = await storePendingPOSend(orderId, review, email, source, { channel: 'dashboard' });
            const result = await executePOSendAction({ sendId, triggeredBy: 'dashboard', skipEmail: false });
            invalidatePurchasingCaches().catch(() => {});

            return NextResponse.json({ status: result.status, userMessage: result.userMessage, details: result.details });

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
                        : `Retry failed for PO #${result.orderId}: ${result.emailError}. Send manually from Finale.`,
                    details: result,
                });
            } catch (err: any) {
                return NextResponse.json({ status: 'failed', error: err.message }, { status: 400 });
            }

        } else if (action === 'cancel-draft') {
            const { sendId, orderId } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

            // Expire the pending send session if one exists
            if (sendId) {
                const { expirePendingPOSend } = await import('@/lib/purchasing/po-sender');
                await expirePendingPOSend(sendId);
            }

            // Cancel the PO in Finale
            const client = new FinaleClient();
            const result = await client.cancelDraftPO(orderId);
            invalidatePurchasingCaches();

            return NextResponse.json({
                cancelled: true,
                orderId,
                finalStatus: result.finalStatus,
            });

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
