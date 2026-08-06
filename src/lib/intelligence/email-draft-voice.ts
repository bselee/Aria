/**
 * @file    src/lib/intelligence/email-draft-voice.ts
 * @purpose Bill Selee / BuildASoil purchasing email voice — rules, templates,
 *          and a grade gate so cold robotic drafts never leave the factory.
 *
 * DECISION(2026-08-06): Megan @ North American Kelp received a brilliant
 * vendor email (traceability, videos, prior tests, sample offer). Aria drafted
 * "Traceability details and COA received… follow up if useful" — wrong on facts
 * (she said NO typical COA), cold, and dismissive. Fix is rules + grade, not
 * more brevity-at-all-costs.
 *
 * Voice (from Bill corrections):
 *  - Warm, not unbusinesslike
 *  - No over-explaining
 *  - Acknowledge real help specifically
 *  - Never invent attachments / COA / certs they didn't give
 *  - Greeting + short body + clean sign-off (not one jammed line)
 *  - Soft close without "if useful" / chatbot dismissiveness
 *
 * Learning path:
 *  1. Grade every draft (0–100). Fail → template rewrite.
 *  2. recordEmailDraftPrepared already logs drafts; when Bill heavily edits
 *     before send, feedback-loop can promote gold samples (future few-shot).
 *
 * @author  Hermia
 * @created 2026-08-06
 * @deps    none (pure)
 */

/** LLM system block — keep tight; examples beat adjectives. */
export const BILL_VENDOR_REPLY_VOICE = `You write Gmail reply drafts as Bill Selee, purchasing, BuildASoil (organic soils / amendments).

VOICE
- Warm professional buyer. Human. Not a ticket bot.
- Short: usually 2–4 short sentences after the greeting. Not a monologue.
- Acknowledge the SPECIFIC help they gave (traceability system, videos, lot codes, pricing, sample offer) — 1 phrase each, not a paraphrase of their whole email.
- Be accurate: only mention COA / OMRI / certs / PDFs they actually provided or offered. If they said they do NOT offer a COA, do not say "COA received".
- No commitment to buy, MOQ, volumes, or a call time unless they asked a direct yes/no and you must stall politely.
- No "Received, thank you." alone. No "follow up if useful" (sounds dismissive). Prefer "we'll review and follow up" or "I'll take a look and get back to you."
- If they offered a sample and it is low-risk, Bill can accept lightly ("a sample would be welcome").
- Plain text only.

FORMAT (exactly)
Hi {FirstName},

{body}

Bill
BuildASoil Purchasing

Never put the signature on the same line as the body. Always blank line before Bill.`;

export const SIGN_OFF = ["Bill", "BuildASoil Purchasing"] as const;

export interface DraftGrade {
    score: number; // 0–100
    pass: boolean;
    failures: string[];
    warnings: string[];
}

const FAIL_THRESHOLD = 70;

/**
 * Grade a draft against Bill voice + factual fidelity to the inbound email.
 * Failures drop score hard; pass requires score >= 70 and zero hard failures.
 */
export function gradeVendorReplyDraft(args: {
    draftBody: string;
    inboundFrom: string;
    inboundSubject: string;
    inboundBody: string;
}): DraftGrade {
    const draft = (args.draftBody || "").trim();
    const inbound = `${args.inboundSubject}\n${args.inboundBody || ""}`;
    const failures: string[] = [];
    const warnings: string[] = [];
    let score = 100;

    if (!draft) {
        return { score: 0, pass: false, failures: ["empty_draft"], warnings: [] };
    }

    // Structure
    if (!/^Hi\s+\S+/i.test(draft)) {
        failures.push("missing_greeting");
        score -= 25;
    }
    if (!/\nBill\s*\nBuildASoil Purchasing\s*$/i.test(draft) && !/\nBill\nBuildASoil Purchasing/i.test(draft)) {
        // allow slight trailing whitespace
        if (!/Bill[\s\S]*BuildASoil Purchasing/i.test(draft)) {
            failures.push("missing_signoff");
            score -= 20;
        } else {
            warnings.push("signoff_format_loose");
            score -= 8;
        }
    }
    // Signature jammed onto body line
    if (/[a-z0-9]\s+Bill\s*\/\s*BuildASoil/i.test(draft) || /useful\.\s*Bill/i.test(draft)) {
        failures.push("jammed_signoff");
        score -= 20;
    }

    // Cold / dismissive patterns
    if (/\bfollow up if useful\b/i.test(draft) || /\bif needed\b/i.test(draft) && /\bfollow up if\b/i.test(draft)) {
        failures.push("dismissive_close");
        score -= 25;
    }
    if (/^received,?\s*thank you\.?$/im.test(draft.replace(/\n/g, " ").trim())) {
        failures.push("bare_thanks");
        score -= 40;
    }
    if (/\bwe('ll| will) review and compare with our current source\b/i.test(draft) && draft.split(/\s+/).length < 40) {
        // generic compare line without personal ack is weak, not always fail
        warnings.push("generic_compare_close");
        score -= 10;
    }

    // Factual fidelity — COA
    const inboundDeniesCoa =
        /\bdo not typically offer (a )?COA\b/i.test(inbound)
        || /\bno COA\b/i.test(inbound)
        || /\bwe do not (?:typically )?(?:offer|provide) (?:a )?COA\b/i.test(inbound)
        || /\bwithout a COA\b/i.test(inbound);
    const draftClaimsCoa =
        /\bCOA received\b/i.test(draft)
        || /\breceived (?:the )?COA\b/i.test(draft)
        || /\bCOA (?:and|\/) /i.test(draft) && /\breceived\b/i.test(draft);
    if (inboundDeniesCoa && draftClaimsCoa) {
        failures.push("false_coa_claim");
        score -= 40;
    }
    // Claimed COA received but inbound never mentions COA attachment/sending
    if (
        draftClaimsCoa
        && !/\bCOA\b/i.test(inbound)
        && !/\bcertificate of analysis\b/i.test(inbound)
    ) {
        failures.push("invented_coa");
        score -= 30;
    }

    // Invented cert pile
    for (const cert of ["OMRI", "IBI", "USDA"]) {
        if (new RegExp(`\\b${cert}\\b`, "i").test(draft) && !new RegExp(`\\b${cert}\\b`, "i").test(inbound)) {
            warnings.push(`invented_cert_${cert}`);
            score -= 12;
        }
    }

    // Warmth / acknowledgement for substantial vendor help
    const inboundIsSubstantive =
        inbound.length > 400
        || /\btraceability\b/i.test(inbound)
        || /\bsample\b/i.test(inbound)
        || /\byoutube\.com\b/i.test(inbound)
        || /\bvideo\b/i.test(inbound);
    if (inboundIsSubstantive) {
        const thanks = /\bthanks\b|\bthank you\b|\bappreciate\b/i.test(draft);
        if (!thanks) {
            failures.push("no_thanks_on_substantive");
            score -= 15;
        }
        // Should nod at something concrete when they poured effort in
        const concrete =
            /\btraceab/i.test(draft)
            || /\bvideo/i.test(draft)
            || /\blot\b/i.test(draft)
            || /\bsample/i.test(draft)
            || /\btest(?:ing)? results?\b/i.test(draft)
            || /\bpric/i.test(draft)
            || /\btech sheet/i.test(draft)
            || /\bhavenst|harvest/i.test(draft);
        if (!concrete) {
            warnings.push("no_concrete_ack");
            score -= 12;
        }
    }

    // Length bands
    const words = draft.split(/\s+/).filter(Boolean).length;
    if (words < 12) {
        failures.push("too_short");
        score -= 20;
    }
    if (words > 120) {
        warnings.push("wordy");
        score -= 10;
    }

    score = Math.max(0, Math.min(100, score));
    const pass = score >= FAIL_THRESHOLD && failures.length === 0;
    return { score, pass, failures, warnings };
}

/**
 * Extract first name from From header. Prefers display name ("Megan Bateman <…>").
 */
export function extractReplyFirstName(from: string): string {
    const angle = from.match(/^([^<]+)</);
    if (angle) {
        const display = angle[1].replace(/["']/g, "").trim();
        const first = display.split(/\s+/)[0];
        if (first && first.length > 1 && !/^(info|sales|orders|support|hello|contact|no-?reply)/i.test(first)) {
            return first.charAt(0).toUpperCase() + first.slice(1);
        }
    }
    const named = from.match(/^"?([A-Za-z]+)/);
    if (named && !/^(info|sales|orders|support|hello|contact)$/i.test(named[1])) {
        return named[1];
    }
    const local = from.match(/([a-zA-Z]+)@/);
    if (local) {
        const part = local[1].split(/[._-]/)[0];
        if (part && part.length > 1) {
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }
    }
    return "there";
}

export function formatSignedDraft(firstName: string, bodyParagraphs: string[]): string {
    const body = bodyParagraphs.map((p) => p.trim()).filter(Boolean).join("\n\n");
    return [`Hi ${firstName},`, "", body, "", ...SIGN_OFF].join("\n");
}

/**
 * Deterministic warm draft for vendor commercial / info replies.
 * Accurate to inbound content; used when LLM fails grade or is offline.
 */
export function templateWarmVendorReply(args: {
    from: string;
    subject: string;
    bodyText?: string;
    snippet?: string;
    pdfFilenames?: string[];
}): string {
    const first = extractReplyFirstName(args.from);
    const hay = `${args.subject}\n${args.bodyText || args.snippet || ""}\n${(args.pdfFilenames || []).join(" ")}`;

    const deniesCoa =
        /\bdo not typically offer (a )?COA\b/i.test(hay)
        || /\bwe do not (?:typically )?(?:offer|provide) (?:a )?COA\b/i.test(hay);
    const offersSample = /\bsample\b/i.test(hay);
    const hasVideos = /\byoutube\.com\b|\bvideo\b/i.test(hay);
    const hasTrace = /\btraceab/i.test(hay);
    const hasPricing = /\bpric|tier\s*\d|quote|distributor/i.test(hay);
    const hasTech = /\btech\s*sheet|tds|spec sheet/i.test(hay);
    const hasPriorTests = /\bprior testing\b|\btest results?\b|\blab results?\b/i.test(hay);
    const hasLot = /\blot number|\blot system|\btrace every\b/i.test(hay);

    const thanksBits: string[] = [];
    if (hasTrace || hasLot) thanksBits.push("the traceability detail");
    if (hasVideos) thanksBits.push("the process videos");
    if (hasPricing) thanksBits.push("the pricing");
    if (hasTech) thanksBits.push("the tech sheets");
    if (hasPriorTests) thanksBits.push("the prior testing results");
    if ((args.pdfFilenames || []).length > 0 && thanksBits.length === 0) {
        thanksBits.push("the attachments");
    }
    if (thanksBits.length === 0) thanksBits.push("the detail");

    let thanks: string;
    if (thanksBits.length === 1) {
        thanks = `Thanks for ${thanksBits[0]} — helpful.`;
    } else if (thanksBits.length === 2) {
        thanks = `Thanks for ${thanksBits[0]} and ${thanksBits[1]} — helpful.`;
    } else {
        const last = thanksBits.pop();
        thanks = `Thanks for ${thanksBits.join(", ")}, and ${last} — helpful.`;
    }

    const facts: string[] = [];
    if (deniesCoa && hasPriorTests) {
        facts.push("Noted you don't typically issue a COA for this product; the prior testing results are still useful for our review.");
    } else if (deniesCoa) {
        facts.push("Noted you don't typically issue a COA for this product.");
    }

    const closeParts: string[] = [];
    if (offersSample) {
        closeParts.push("A sample would be welcome if you can send one.");
    }
    closeParts.push("We'll review on our side and follow up.");

    const paragraphs = [thanks, ...facts, closeParts.join(" ")];
    return formatSignedDraft(first, paragraphs);
}
