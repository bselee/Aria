/**
 * @file    src/lib/intelligence/vendor-opportunity.ts
 * @purpose Detect vendor sales / sourcing opportunity emails that must NEVER get
 *          a bare "Received, thank you!" auto-reply. Draft a business-acumen
 *          reply as a Gmail draft and open a response-monitor task for Bill.
 *
 *          Canonical miss: American BioChar (Jessica Kusmiz) 2026-08-04 —
 *          tier-2 pricing + tech sheets + call offer → Aria sent "Received, thank you!"
 *
 * @author  Hermia
 * @created 2026-08-05
 * @deps    ./llm, ./email-draft-voice
 * @updated 2026-08-06 — Bill voice + draft grade gate (Megan kelp incident)
 */

import { z } from "zod";
import { unifiedObjectGeneration } from "./llm";
import {
    BILL_VENDOR_REPLY_VOICE,
    extractReplyFirstName,
    gradeVendorReplyDraft,
    templateWarmVendorReply,
} from "./email-draft-voice";

export interface VendorOpportunityInput {
    from: string;
    subject: string;
    snippet?: string | null;
    bodyText?: string | null;
    hasPdf?: boolean;
    pdfFilenames?: string[] | null;
}

export interface VendorOpportunitySignal {
    isOpportunity: boolean;
    reasons: string[];
    /** High-confidence enough to skip LLM and force human/draft path */
    highConfidence: boolean;
}

const OPPORTUNITY_SUBJECT = [
    /\binquir(?:y|ies)\b/i,
    /\bresponse to your\b/i,
    /\bdistributor\b/i,
    /\bpricing\s*(schedule|sheet|list)?\b/i,
    /\bquote\b/i,
    /\bproposal\b/i,
    /\bintroduction\b/i,
    /\bpartnership\b/i,
    /\bsample\s*request\b/i,
    /\bnew\s*product\b/i,
    /\bline\s*card\b/i,
];

const OPPORTUNITY_BODY = [
    /\bschedule a (?:call|meeting|zoom|teams)\b/i,
    /\bwould love to (?:schedule|connect|chat|discuss)\b/i,
    /\blet'?s (?:set up|schedule|jump on) a (?:call|meeting)\b/i,
    /\btier\s*\d+\s*distributor\b/i,
    /\bdistributor pricing\b/i,
    /\bpricing schedule\b/i,
    /\bprice list\b/i,
    /\btech(?:nical)?\s*sheet/i,
    /\bproduct\s*data\s*sheet\b/i,
    /\bspec(?:ification)?\s*sheet/i,
    /\bomri\s*list/i,
    /\bibi\s*cert/i,
    /\busda\s*bio.?preferred\b/i,
    /\battached (?:our |the )?(?:pricing|quote|schedule|tech|tds|sds|coa)\b/i,
    /\bi have attached\b/i,
    /\bplease find attached\b/i,
    /\bvolume pricing\b/i,
    /\bmoq\b/i,
    /\bminimum order\b/i,
    /\bsample kit\b/i,
    /\bfactory direct\b/i,
];

const OPERATIONAL_OVERRIDE = [
    /\binvoice\b/i,
    /\bpayment request\b/i,
    /\bpast due\b/i,
    /\btracking\b/i,
    /\border confirmation\b/i,
    /\bshipped\b/i,
    /\bdelivered\b/i,
    /\bbuildasoil\s+po\s*#?\s*\d+/i,
    /\bpurchase order\b/i,
    /\bpo\s*#?\s*\d{5,6}\b/i,
];

/**
 * Pure detector — no I/O. Used by ACK agent before auto-thanks.
 */
export function detectVendorOpportunity(input: VendorOpportunityInput): VendorOpportunitySignal {
    const subject = input.subject || "";
    const body = `${input.snippet || ""}\n${input.bodyText || ""}`;
    const haystack = `${subject}\n${body}`;
    const reasons: string[] = [];

    // Operational PO/invoice threads win — not a sales opportunity path
    if (OPERATIONAL_OVERRIDE.some((re) => re.test(haystack))) {
        return { isOpportunity: false, reasons: ["operational_override"], highConfidence: false };
    }

    let score = 0;

    for (const re of OPPORTUNITY_SUBJECT) {
        if (re.test(subject)) {
            score += 2;
            reasons.push(`subject:${re.source.slice(0, 40)}`);
        }
    }

    for (const re of OPPORTUNITY_BODY) {
        if (re.test(body)) {
            score += 1;
            reasons.push(`body:${re.source.slice(0, 40)}`);
        }
    }

    if (input.hasPdf) {
        score += 1;
        reasons.push("has_pdf");
    }

    const pdfNames = (input.pdfFilenames || []).join(" ").toLowerCase();
    if (/(pric|quote|tds|tech|spec|coa|sds|omri)/i.test(pdfNames)) {
        score += 2;
        reasons.push("pdf_name_commercial");
    }

    // "response to your X inquiry" alone is enough with any commercial signal
    const inquiryResponse = /\bresponse to your\b/i.test(subject) || /\binquir/i.test(subject);
    if (inquiryResponse && score >= 2) {
        return { isOpportunity: true, reasons, highConfidence: true };
    }

    if (score >= 3) {
        return { isOpportunity: true, reasons, highConfidence: score >= 5 };
    }

    return { isOpportunity: false, reasons, highConfidence: false };
}

const DraftSchema = z.object({
    draftBody: z.string().min(40).max(2000),
    summaryForBill: z.string().min(10).max(400),
    nextAction: z.string().min(5).max(200),
});

export type OpportunityDraft = z.infer<typeof DraftSchema>;

/**
 * Build a business-acumen draft reply. LLM first; grade gate; template fallback.
 * Never auto-sends — caller creates a Gmail draft for Bill to edit/send.
 *
 * DECISION(2026-08-06): Brevity-only prompts produced cold wrong drafts
 * (e.g. "COA received" when vendor said no COA). Grade + warm template.
 */
export async function composeOpportunityDraft(input: VendorOpportunityInput): Promise<OpportunityDraft> {
    const from = input.from;
    const subject = input.subject;
    const body = (input.bodyText || input.snippet || "").slice(0, 4000);
    const pdfs = (input.pdfFilenames || []).join(", ");
    const inboundBody = input.bodyText || input.snippet || "";

    try {
        const res = await unifiedObjectGeneration({
            system: BILL_VENDOR_REPLY_VOICE,
            prompt: `Draft a reply to this vendor email.

From: ${from}
Subject: ${subject}
Attachments: ${pdfs || "(none listed)"}

Email:
${body}

Return JSON:
- draftBody: full plain-text reply including Hi/Name and Bill sign-off on separate lines
- summaryForBill: one line for Bill's task hub
- nextAction: imperative next step for Bill

Be factually accurate to the email. Do not invent a COA or certs.`,
            schema: DraftSchema,
            schemaName: "VendorOpportunityDraft",
            tier: "free",
            maxTokens: 400,
        });

        const parsed = DraftSchema.parse(res);
        const grade = gradeVendorReplyDraft({
            draftBody: parsed.draftBody,
            inboundFrom: from,
            inboundSubject: subject,
            inboundBody,
        });

        if (!grade.pass) {
            console.warn(
                `[vendor-opportunity] Draft failed grade score=${grade.score} failures=${grade.failures.join(",") || "—"} → warm template`,
            );
            return templateOpportunityDraft(input);
        }

        if (grade.warnings.length > 0) {
            console.log(`[vendor-opportunity] Draft grade=${grade.score} warnings=${grade.warnings.join(",")}`);
        }

        return parsed;
    } catch (err: any) {
        console.warn(`[vendor-opportunity] compose failed: ${err?.message || err} → warm template`);
        return templateOpportunityDraft(input);
    }
}

/** Deterministic warm fallback — accurate, human, Bill-shaped. */
export function templateOpportunityDraft(input: VendorOpportunityInput): OpportunityDraft {
    const draftBody = templateWarmVendorReply({
        from: input.from,
        subject: input.subject,
        bodyText: input.bodyText || undefined,
        snippet: input.snippet || undefined,
        pdfFilenames: input.pdfFilenames || undefined,
    });

    const hay = `${input.subject}\n${input.bodyText || input.snippet || ""}`;
    const bits: string[] = [];
    if (/pric|tier\s*\d|quote/i.test(hay)) bits.push("pricing");
    if (/tech\s*sheet|tds|spec/i.test(hay)) bits.push("tech sheets");
    if (/traceab|lot number|lot system/i.test(hay)) bits.push("traceability");
    if (/video|youtube/i.test(hay)) bits.push("videos");
    if (/sample/i.test(hay)) bits.push("sample offer");
    if (/prior testing|test results|lab results/i.test(hay)) bits.push("test results");
    if (/omri|ibi|cert/i.test(hay) && !/do not typically offer/i.test(hay)) bits.push("certs");
    const what = bits.length > 0 ? bits.join(" + ") : "vendor materials";

    return {
        draftBody,
        summaryForBill: `${extractReplyFirstName(input.from)} (${input.from}) — ${what} on "${input.subject.slice(0, 55)}"`,
        nextAction: bits.includes("sample offer")
            ? "Review draft, confirm sample request OK, then send."
            : "Review draft vs current supplier, edit if needed, send.",
    };
}

/**
 * Build MIME raw for a reply draft in-thread.
 */
export function buildReplyDraftRaw(args: {
    to: string;
    from: string;
    subject: string;
    inReplyTo?: string | null;
    bodyText: string;
}): string {
    const subject = /^re:/i.test(args.subject) ? args.subject : `Re: ${args.subject}`;
    const parts = [
        `To: ${args.to}`,
        `From: ${args.from}`,
        `Subject: ${subject}`,
        ...(args.inReplyTo
            ? [`In-Reply-To: ${args.inReplyTo}`, `References: ${args.inReplyTo}`]
            : []),
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset="UTF-8"`,
        ``,
        args.bodyText,
    ];
    return Buffer.from(parts.join("\r\n")).toString("base64url");
}
