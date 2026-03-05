import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';
import {
    storePendingPOSend,
    getPendingPOSend,
    lookupVendorOrderEmail,
    commitAndSendPO,
} from '@/lib/purchasing/po-sender';

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

            const { email, source } = await lookupVendorOrderEmail(review.vendorName, review.vendorPartyId);
            const sendId = email ? storePendingPOSend(orderId, review, email, source) : null;

            return NextResponse.json({ review, email, emailSource: source, sendId });

        } else if (action === 'send') {
            const { sendId } = body;
            if (!sendId) return NextResponse.json({ error: 'sendId required' }, { status: 400 });

            const pending = getPendingPOSend(sendId);
            if (!pending) {
                return NextResponse.json(
                    { error: 'Send session expired or not found — start a new review' },
                    { status: 404 }
                );
            }

            const result = await commitAndSendPO(sendId, 'dashboard');
            return NextResponse.json(result);

        } else if (action === 'cancel') {
            const { sendId } = body;
            if (sendId) {
                const { expirePendingPOSend } = await import('@/lib/purchasing/po-sender');
                expirePendingPOSend(sendId);
            }
            return NextResponse.json({ cancelled: true });

        } else {
            return NextResponse.json({ error: 'action must be review | send | cancel' }, { status: 400 });
        }
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
