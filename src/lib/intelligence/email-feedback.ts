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

interface OverwatchArchiveEvent extends EmailBaseEvent {
    intent: string;
    reason: string;
    state: string;
}

interface OverwatchDraftEvent extends EmailBaseEvent {
    poNumber: string;
    vendorName: string;
    draftId: string;
    followUpCount: number;
    mode: "reply" | "eta_request";
}

interface OverwatchHoldEvent extends EmailBaseEvent {
    state: string;
    reason: string;
    poNumber?: string | null;
    downstreamStatus?: string | null;
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

export async function recordOverwatchArchive(event: OverwatchArchiveEvent): Promise<void> {
    await recordFeedback({
        category: "outcome",
        eventType: "email_overwatch_archived",
        agentSource: "email-overwatch-agent",
        subjectType: "message",
        subjectId: event.gmailMessageId,
        prediction: {
            intent: event.intent,
            state: event.state,
        },
        actualOutcome: {
            fromEmail: event.fromEmail,
            subject: event.subject,
            archived: true,
        },
        contextData: {
            threadId: event.threadId ?? null,
            reason: event.reason,
            inbox: "default",
        },
    });
}

export async function recordOverwatchDraftCreated(event: OverwatchDraftEvent): Promise<void> {
    await recordFeedback({
        category: "prediction",
        eventType: "email_overwatch_follow_up_draft",
        agentSource: "email-overwatch-agent",
        subjectType: "po",
        subjectId: event.poNumber,
        prediction: {
            draftId: event.draftId,
            followUpCount: event.followUpCount,
            mode: event.mode,
            threadId: event.threadId ?? null,
        },
        actualOutcome: {
            vendorName: event.vendorName,
            fromEmail: event.fromEmail,
            subject: event.subject,
        },
        contextData: {
            gmailMessageId: event.gmailMessageId,
            inbox: "default",
        },
    });
}

export async function recordOverwatchHeld(event: OverwatchHoldEvent): Promise<void> {
    await recordFeedback({
        category: "correction",
        eventType: "email_overwatch_human_review_required",
        agentSource: "email-overwatch-agent",
        subjectType: event.poNumber ? "po" : "message",
        subjectId: event.poNumber || event.gmailMessageId,
        prediction: {
            state: event.state,
            threadId: event.threadId ?? null,
        },
        actualOutcome: {
            fromEmail: event.fromEmail,
            subject: event.subject,
            downstreamStatus: event.downstreamStatus || null,
        },
        contextData: {
            reason: event.reason,
            inbox: "default",
        },
    });
}
