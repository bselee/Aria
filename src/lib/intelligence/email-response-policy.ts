/**
 * @file    src/lib/intelligence/email-response-policy.ts
 * @purpose Canonical reply policy for bill.selee@ inbox.
 *          DECISION(2026-08-05): Never auto-send to humans on reviewable mail.
 *          Drafts are prepared for Bill to read/edit/send. Auto-send caused the
 *          BioChar miss ("Received, thank you!" on a pricing + call offer).
 *
 * Policy matrix (DECISION 2026-08-11):
 *   ARCHIVE          — promo / system / marketplace noise. No reply.
 *   SILENT           — routine PO/tracking/FYI, already-replied, noreply.
 *                      Leave visible; no draft (Bill deletes boilerplate).
 *   DRAFT_ROUTINE    — unused. Routine no longer drafts.
 *   DRAFT_OPPORTUNITY— Pricing, TDS, inquiry response, call offer. Needs Response
 *                      + email_needs_response task. NO draft (Bill 2026-11-03:
 *                      canned drafts cost more to delete than they save).
 *   ESCALATE_HUMAN   — Questions / problems / conversation needing Bill.
 *                      Needs Response + task. NO draft stub.
 *   INVOICE          — Paid CC invoice → nightshift. No vendor reply.
 *
 * @author  Hermia
 * @created 2026-08-05
 */

import {
    composeSimpleThanks,
    extractReplyFirstName,
    formatSignedDraft,
    isSimpleVendorConfirmation,
} from "./email-draft-voice";

// Re-export for acknowledgement-agent and tests
export { isSimpleVendorConfirmation, composeSimpleThanks };

export type EmailResponseAction =
    | "ARCHIVE"
    | "SILENT"
    | "DRAFT_ROUTINE"
    | "DRAFT_OPPORTUNITY"
    | "ESCALATE_HUMAN"
    | "INVOICE";

export interface ResponsePolicyInput {
    intent:
        | "ROUTINE_INFO"
        | "REQUIRES_HUMAN"
        | "PROMOTIONAL"
        | "INLINE_INVOICE"
        | "VENDOR_OPPORTUNITY"
        | string;
    isNoReply?: boolean;
    isMarketplace?: boolean;
    isPurchaseThread?: boolean;
    alreadyRepliedThisBatch?: boolean;
    buildasoilAlreadyRepliedInThread?: boolean;
    isActiveConversation?: boolean;
}

export interface ResponsePolicyResult {
    action: EmailResponseAction;
    /** Never true for human-facing reviewable mail after 2026-08-05 */
    allowAutoSend: boolean;
    createDraft: boolean;
    openResponseTask: boolean;
    leaveInInbox: boolean;
    labels: string[];
    reason: string;
}

/**
 * Pure policy resolver — no I/O.
 */
export function resolveEmailResponsePolicy(input: ResponsePolicyInput): ResponsePolicyResult {
    const intent = input.intent;

    if (intent === "PROMOTIONAL") {
        return {
            action: "ARCHIVE",
            allowAutoSend: false,
            createDraft: false,
            openResponseTask: false,
            leaveInInbox: false,
            labels: [],
            reason: "promotional",
        };
    }

    if (intent === "INLINE_INVOICE") {
        return {
            action: "INVOICE",
            allowAutoSend: false,
            createDraft: false,
            openResponseTask: false,
            leaveInInbox: true,
            labels: [],
            reason: "paid_invoice_pipeline",
        };
    }

    if (intent === "VENDOR_OPPORTUNITY") {
        // DECISION(2026-11-03, Bill): draft replies feel canned and deleting them
        // costs more time than they save. No reply drafts anywhere. Needs Response
        // + task still surface the email for Bill.
        return {
            action: "DRAFT_OPPORTUNITY",
            allowAutoSend: false,
            createDraft: false,
            openResponseTask: true,
            leaveInInbox: true,
            labels: ["Needs Response"],
            reason: "vendor_opportunity_review_no_draft",
        };
    }

    if (intent === "REQUIRES_HUMAN") {
        // History: the Aug-19 Tanner/CYC miss showed a task-only branch is invisible
        // (no draft, task write swallowed), so 2026-09-30 mandated a reviewable draft.
        // DECISION(2026-11-03, Bill): drafts reversed — they are canned and deleting
        // them costs more time than they save. The no-op risk is closed at the task
        // write instead: recordHumanReviewRequired failure now errors loudly in the
        // caller. Needs Response label + task remain the surface Bill actually reads.
        return {
            action: "ESCALATE_HUMAN",
            allowAutoSend: false,
            createDraft: false,
            openResponseTask: true,
            leaveInInbox: true,
            labels: ["Needs Response"],
            reason: "human_review_required_no_draft",
        };
    }

    // ROUTINE_INFO and fallbacks
    if (
        input.isNoReply
        || input.isMarketplace
        || input.alreadyRepliedThisBatch
        || input.buildasoilAlreadyRepliedInThread
        || input.isActiveConversation
    ) {
        return {
            action: "SILENT",
            allowAutoSend: false,
            createDraft: false,
            openResponseTask: false,
            leaveInInbox: true,
            labels: [],
            reason: input.isMarketplace
                ? "marketplace_status"
                : input.isNoReply
                ? "noreply"
                : "already_in_conversation",
        };
    }

    // PO / tracking / FYI — silent. Drafting "Thanks for the update" made more
    // work (delete drafts) than Bill replying himself.
    return {
        action: "SILENT",
        allowAutoSend: false,
        createDraft: false,
        openResponseTask: false,
        leaveInInbox: true,
        labels: [],
        reason: input.isPurchaseThread ? "po_or_tracking_silent" : "routine_silent",
    };
}

/**
 * Short routine drafts — professional, specific enough to not look robotic,
 * soft enough that Bill can send as-is on clean acks.
 */
export function composeRoutineDraftBody(args: {
    from: string;
    subject: string;
    bodyText?: string;
}): string {
    // Light vendor confirms → Bill-style "Thanks!" only
    if (isSimpleVendorConfirmation({ subject: args.subject, bodyText: args.bodyText })) {
        return composeSimpleThanks({ from: args.from, bodyText: args.bodyText });
    }

    const first = extractReplyFirstName(args.from, args.bodyText);
    const text = `${args.subject}
${args.bodyText || ""}`.toLowerCase();

    let core = "Thanks for the update.";
    if (/eta|ship(?:ping|s|ped)?|deliver/i.test(text)) {
        core = "Thanks for the shipping update.";
    } else if (/po|purchase order|order conf?irm/i.test(text)) {
        core = "Thanks for confirming.";
    } else if (/tracking|pro\s*#|bol/i.test(text)) {
        core = "Thanks for the tracking info.";
    }

    return formatSignedDraft(first, [core]);
}

/**
 * Only when we truly owe a human answer. Still no Gmail-duplicate signature.
 * Prefer "Thanks!" if the inbound was just a confirmation (misclassified).
 */
export function composeHumanEscalationDraftStub(args: {
    from: string;
    subject: string;
    bodyText?: string;
}): string {
    if (isSimpleVendorConfirmation({ subject: args.subject, bodyText: args.bodyText })) {
        return composeSimpleThanks({ from: args.from, bodyText: args.bodyText });
    }
    const first = extractReplyFirstName(args.from, args.bodyText);
    // Bill often just says thanks and handles offline — avoid fake "looking into this"
    // when we don't know the question. Keep it open and short.
    return formatSignedDraft(first, ["Thanks — I'll follow up shortly."]);
}
