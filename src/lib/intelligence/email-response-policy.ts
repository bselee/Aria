/**
 * @file    src/lib/intelligence/email-response-policy.ts
 * @purpose Canonical reply policy for bill.selee@ inbox.
 *          DECISION(2026-08-05): Never auto-send to humans on reviewable mail.
 *          Drafts are prepared for Bill to read/edit/send. Auto-send caused the
 *          BioChar miss ("Received, thank you!" on a pricing + call offer).
 *
 * Policy matrix:
 *   ARCHIVE          — promo / system / marketplace noise. No reply.
 *   SILENT           — already replied in-thread, noreply, active conversation.
 *                      Leave visible or mark read; no draft.
 *   DRAFT_ROUTINE    — PO ack / tracking / order confirm. Short professional draft.
 *                      Bill reviews before send. Leave in inbox.
 *   DRAFT_OPPORTUNITY— Pricing, TDS, inquiry response, call offer. Business draft
 *                      + Needs Response + email_needs_response task.
 *   ESCALATE_HUMAN   — Questions / problems / conversation needing Bill.
 *                      Needs Response + task; optional cautious draft stub.
 *   INVOICE          — Paid CC invoice → nightshift. No vendor reply.
 *
 * @author  Hermia
 * @created 2026-08-05
 */

import { extractReplyFirstName, formatSignedDraft } from "./email-draft-voice";

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
        return {
            action: "DRAFT_OPPORTUNITY",
            allowAutoSend: false,
            createDraft: true,
            openResponseTask: true,
            leaveInInbox: true,
            labels: ["Needs Response", "Draft Ready"],
            reason: "vendor_opportunity_review",
        };
    }

    if (intent === "REQUIRES_HUMAN") {
        return {
            action: "ESCALATE_HUMAN",
            allowAutoSend: false,
            createDraft: true, // cautious stub only — Bill edits heavily
            openResponseTask: true,
            leaveInInbox: true,
            labels: ["Needs Response", "Draft Ready"],
            reason: "human_review_required",
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

    // PO / tracking / order confirm — short draft for Bill to approve, never auto-send.
    // These often carry ETA / qty / freight nuance and need a read before send.
    return {
        action: "DRAFT_ROUTINE",
        allowAutoSend: false,
        createDraft: true,
        openResponseTask: false, // Gmail Drafts + inbox visibility is the surface
        leaveInInbox: true,
        labels: ["Draft Ready"],
        reason: input.isPurchaseThread ? "po_or_tracking_review" : "routine_review",
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
    const first = extractReplyFirstName(args.from);
    const text = `${args.subject}
${args.bodyText || ""}`.toLowerCase();

    let core = "Thanks for the update — noted on our end.";
    if (/eta|ship(?:ping|s|ped)?|deliver/i.test(text)) {
        core = "Thanks for the shipping update — timing noted.";
    } else if (/po|purchase order|order conf?irm/i.test(text)) {
        core = "Thanks for confirming — we have this against the PO.";
    } else if (/tracking|pro\s*#|bol/i.test(text)) {
        core = "Thanks for the tracking info — appreciated.";
    }

    return formatSignedDraft(first, [core]);
}

/**
 * Cautious stub when human must answer a question — never pretends to resolve it.
 */
export function composeHumanEscalationDraftStub(args: {
    from: string;
    subject: string;
}): string {
    const first = extractReplyFirstName(args.from);
    return formatSignedDraft(first, [
        "Thanks for flagging this — looking into it on our side and will follow up shortly.",
    ]);
}

