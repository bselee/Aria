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

interface HumanReviewEvent extends EmailBaseEvent {
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

interface DraftGradeFailureEvent {
    gmailMessageId: string;
    fromEmail: string;
    subject: string;
    score: number;
    failures: string[];
    rejectedDraft: string;
    reason: string;
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

/** Draft prepared for Bill to review/edit/send — not auto-sent. */
export async function recordEmailDraftPrepared(event: AutoReplyEvent & { kind: string; draftId?: string | null; firstName?: string | null }): Promise<void> {
    await recordFeedback({
        category: "engagement",
        eventType: "email_draft_prepared",
        agentSource: "acknowledgement-agent",
        subjectType: "message",
        subjectId: event.gmailMessageId,
        prediction: {
            action: "draft",
            kind: event.kind,
            threadId: event.threadId ?? null,
            replyBody: event.replyBody,
            draftId: event.draftId ?? null,
            firstName: event.firstName ?? null,
        },
        actualOutcome: {
            fromEmail: event.fromEmail,
            subject: event.subject,
        },
        contextData: {
            inbox: "default",
            autoSend: false,
        },
    });
}

export async function recordHumanReviewRequired(event: HumanReviewEvent): Promise<void> {
    await recordFeedback({
        category: "correction",
        eventType: "email_human_review_required",
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

/**
 * A drafted vendor reply failed the grade gate and was replaced by the warm
 * template. Log the failure details + the rejected draft so bad drafts are
 * queryable in feedback_events instead of vanishing silently.
 */
export async function recordDraftGradeFailure(event: DraftGradeFailureEvent): Promise<void> {
    await recordFeedback({
        category: "correction",
        eventType: "email_draft_grade_failed",
        agentSource: "vendor-opportunity",
        subjectType: "message",
        subjectId: event.gmailMessageId,
        prediction: {
            action: "draft",
            score: event.score,
            failures: event.failures,
            rejectedDraft: event.rejectedDraft,
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
