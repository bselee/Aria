import { recordFeedback } from "./feedback-loop";
import type { InvoiceReconcileOutcome } from "./workers/default-inbox-invoice";

interface EmailBaseEvent {
    gmailMessageId: string;
    threadId?: string | null;
    fromEmail: string;
    subject: string;
}

interface AutoReplyEvent extends EmailBaseEvent {
    replyBody: string;
}

interface FollowUpEvent extends EmailBaseEvent {
    reason: string;
}

interface DefaultInboxInvoiceEvent {
    gmailMessageId: string;
    fromEmail: string;
    subject: string;
    outcome: InvoiceReconcileOutcome;
    vendorName: string;
    poNumber: string | null;
    total: number;
    priceUpdates: number;
}

export async function recordSimpleAutoReply(event: AutoReplyEvent): Promise<void> {
    await recordFeedback({
        category: "engagement",
        eventType: "email_auto_reply_sent",
        agentSource: "acknowledgement-agent",
        subjectType: "message",
        subjectId: event.gmailMessageId,
        prediction: {
            action: "reply",
            threadId: event.threadId ?? null,
            replyBody: event.replyBody,
        },
        actualOutcome: {
            fromEmail: event.fromEmail,
            subject: event.subject,
        },
        contextData: {
            inbox: "default",
        },
    });
}

export async function recordHumanFollowUpRequired(event: FollowUpEvent): Promise<void> {
    await recordFeedback({
        category: "correction",
        eventType: "email_follow_up_required",
        agentSource: "acknowledgement-agent",
        subjectType: "message",
        subjectId: event.gmailMessageId,
        prediction: {
            action: "human_review",
            threadId: event.threadId ?? null,
        },
        actualOutcome: {
            fromEmail: event.fromEmail,
            subject: event.subject,
        },
        contextData: {
            inbox: "default",
            reason: event.reason,
        },
    });
}

export async function recordDefaultInboxInvoiceOutcome(event: DefaultInboxInvoiceEvent): Promise<void> {
    await recordFeedback({
        category: "outcome",
        eventType: `default_inbox_invoice_${event.outcome}`,
        agentSource: "default-inbox-invoice",
        subjectType: "invoice",
        subjectId: event.gmailMessageId,
        prediction: {
            poNumber: event.poNumber,
            vendorName: event.vendorName,
        },
        actualOutcome: {
            outcome: event.outcome,
            total: event.total,
            priceUpdates: event.priceUpdates,
        },
        contextData: {
            fromEmail: event.fromEmail,
            subject: event.subject,
        },
    });
}
