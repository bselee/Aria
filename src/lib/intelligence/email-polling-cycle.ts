/**
 * @file    src/lib/intelligence/email-polling-cycle.ts
 * @purpose Ordered multi-inbox email ops cycle. Draft-only ACK replies are a
 *          SIDE EFFECT of stage 2 — they never replace invoice/tracking DB work.
 *
 * Pipeline (every ap-polling tick — 8am / 12pm / 5pm):
 *   1. default-email-pipeline  — Gmail bill.selee@ → email_inbox_queue
 *   2. default-acknowledgement — classify default queue:
 *        • PROMOTIONAL → archive
 *        • INLINE_INVOICE (PAID/CC) → nightshift → vendor_invoices + Finale prices
 *        • ROUTINE / OPPORTUNITY / HUMAN → Gmail DRAFT only (never auto-send)
 *   3. ap-email-pipeline       — Gmail ap@ → email_inbox_queue (source=ap)
 *   4. ap-identifier           — unpaid invoices → ap_inbox_queue (PENDING_FORWARD)
 *                                paid-on-AP blocked from Bill.com; dropship handled
 *   5. ap-forwarder            — ap_inbox_queue → Bill.com (+ local-forwarder in cron)
 *
 * Separate crons (NOT this cycle — still both inboxes):
 *   • email-tracking-ingest (every 2h) — tracking # + PO → shipments table
 *   • carrier-poll — live carrier status / ETAs on those shipments
 *   • po-purchase-sync — Finale PO mirror for invoice↔PO matching
 *
 * Paid vs unpaid rule:
 *   bill.selee@  → treat as already paid (CC) → never Bill.com
 *   ap@          → treat as AP payable → Bill.com after identify
 *
 * @author  Hermia
 * @updated 2026-08-05
 */

export interface EmailPollingCycleDeps {
    emailIngestionDefault: {
        run: () => Promise<void>;
    };
    acknowledgementAgent: {
        processUnreadEmails: () => Promise<void>;
    };
    emailIngestionAP: {
        run: () => Promise<void>;
    };
    apIdentifier: {
        identifyAndQueue: () => Promise<void>;
    };
    apForwarder: {
        processPendingForwards: () => Promise<void>;
    };
    onStageSuccess?: (stage: string) => Promise<void> | void;
}

async function runEmailStage(
    stageName: string,
    work: () => Promise<void>,
    onSuccess?: (stage: string) => Promise<void> | void,
): Promise<void> {
    try {
        await work();
        await onSuccess?.(stageName);
    } catch (err: any) {
        console.error(`[EmailPollingCycle] ${stageName} failed: ${err.message}`);
    }
}

/**
 * Run the full multi-inbox email ops cycle.
 * Failures in one stage are logged; later stages still run.
 */
export async function runEmailPollingCycle(deps: EmailPollingCycleDeps): Promise<void> {
    await runEmailStage("default-email-pipeline", () => deps.emailIngestionDefault.run(), deps.onStageSuccess);
    await runEmailStage("default-acknowledgement", () => deps.acknowledgementAgent.processUnreadEmails(), deps.onStageSuccess);
    await runEmailStage("ap-email-pipeline", () => deps.emailIngestionAP.run(), deps.onStageSuccess);
    await runEmailStage("ap-identifier", () => deps.apIdentifier.identifyAndQueue(), deps.onStageSuccess);
    await runEmailStage("ap-forwarder", () => deps.apForwarder.processPendingForwards(), deps.onStageSuccess);
}
