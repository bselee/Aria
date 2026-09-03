/**
 * @file    src/lib/intelligence/email-draft-voice.ts
 * @purpose Bill Selee / BuildASoil purchasing email voice — rules, templates,
 *          and a grade gate so silly drafts never leave the factory.
 *
 * DECISION(2026-08-06) incidents:
 *  1. Megan @ North American Kelp — false "COA received", dismissive close.
 *  2. Cari @ HerbsNOW — simple "Sounds good, invoice when restocked" got
 *     "Hi cs, Thanks — looking into this…" + fake Purchasing signature.
 *     Bill: Gmail already has a signature. He signs off "Thanks!" / "Thank you".
 *
 * Voice (from Bill corrections):
 *  - Warm, businesslike, short
 *  - NO "Bill / BuildASoil Purchasing" block — signature is already in Gmail
 *  - Simple acks: often just "Thanks!" or "Thank you."
 *  - When a greeting is needed: Hi {Name}, then one short line, then Thanks!
 *  - Never invent COA/certs; never "follow up if useful"
 *  - Never "looking into this" on a simple vendor confirmation
 *  - Prefer real first name (display name or body sign-off), never "cs" from cs@
 *
 * @author  Hermia
 * @created 2026-08-06
 * @updated 2026-08-06 — no Gmail-duplicate signature; simple Thanks! closes
 * @deps    none (pure)
 */

/** LLM system block for substantive vendor commercial replies. */
export const BILL_VENDOR_REPLY_VOICE = `You write Gmail reply drafts as Bill Selee, purchasing, BuildASoil.

VOICE
- Warm professional buyer. Human. Not a ticket bot.
- Short. Usually 1–3 short sentences.
- Acknowledge SPECIFIC help (traceability, videos, pricing, sample offer) — brief.
- Be accurate: never claim COA/OMRI/certs they did not give. If they said no COA, say that.
- No buy commitment / MOQ / call time unless stalling a direct question.
- No "follow up if useful". No bare "Received, thank you." alone on substantive mail.
- Sample offers: light accept OK ("a sample would be welcome").
- Plain text only.

FORMAT — CRITICAL
- Do NOT add a signature block. Gmail already appends Bill's signature.
- Do NOT end with "Bill" or "BuildASoil Purchasing".
- Prefer ending with "Thanks!" or "Thank you."
- Optional greeting when you know their first name:
  Hi {FirstName},

  {one or two short sentences}
  Thanks!

- For very short vendor confirmations ("Sounds good", "I'll send the invoice"), the entire draft may be just:
  Thanks!

EXAMPLES (Bill's real style — follow these patterns exactly):

Example 1 — Megan: traceability + videos + sample offer, no COA.
"Hi Megan,
Thanks for the traceability detail and videos — helpful. Noted on the COA. A sample would be welcome if you can send one.
Thanks!"

Example 2 — Cari: "I'll send the invoice as soon as we're restocked."
"Thanks Cari — appreciated."

Example 3 — Jessica: pricing + tech sheets.
"Hi Jessica,
Thanks — pricing and TDS received. We'll compare with current supply and follow up.
Thanks!"
`;

/** @deprecated Kept empty — Bill's Gmail signature is the only sign-off. */
export const SIGN_OFF: readonly string[] = [];

export interface DraftGrade {
    score: number; // 0–100
    pass: boolean;
    failures: string[];
    warnings: string[];
}

const FAIL_THRESHOLD = 70;

/** Local-part / role names that must never become "Hi cs," */
const BAD_GREETING_NAMES = new Set([
    "cs", "info", "sales", "orders", "support", "hello", "contact",
    "admin", "office", "mail", "noreply", "no-reply", "billing", "ap",
    "there", "team", "help", "service",
]);

/**
 * Grade a draft against Bill voice + factual fidelity.
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

    // ── Signature: Gmail already has one — fail if we double it ──
    if (/\bBuildASoil\s+Purchasing\b/i.test(draft) || /\nBill\s*\nBuildASoil/i.test(draft)) {
        failures.push("duplicate_gmail_signature");
        score -= 30;
    }
    if (/Bill\s*\/\s*BuildASoil/i.test(draft)) {
        failures.push("jammed_signoff");
        score -= 25;
    }
    // Lone "Bill" as last non-empty line (signature fragment)
    const lines = draft.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2 && /^Bill\.?$/i.test(lines[lines.length - 1] || "")) {
        failures.push("duplicate_gmail_signature");
        score -= 25;
    }

    // ── Bad greeting from email local-part ──
    const greet = draft.match(/^Hi\s+([A-Za-z0-9._-]+)\s*,/i);
    if (greet && BAD_GREETING_NAMES.has(greet[1].toLowerCase())) {
        failures.push("bad_greeting_name");
        score -= 30;
    }
    if (greet && greet[1].length <= 2 && !/^(ed|al|bo|jo|ty|aj)$/i.test(greet[1])) {
        failures.push("bad_greeting_name");
        score -= 25;
    }

    // ── Dismissive / wrong-tone ──
    if (/\bfollow up if useful\b/i.test(draft)) {
        failures.push("dismissive_close");
        score -= 25;
    }
    if (/^received,?\s*thank you\.?$/im.test(draft.replace(/\n/g, " ").trim())) {
        failures.push("bare_thanks_only_on_empty");
        // only hard-fail if inbound was substantive
        if (inbound.length > 300) score -= 35;
        else score -= 5;
    }

    // "looking into this" on a simple confirmation is nonsense
    const simpleConfirm = isSimpleVendorConfirmation({
        subject: args.inboundSubject,
        bodyText: args.inboundBody,
    });
    if (simpleConfirm && /\blooking into this\b/i.test(draft)) {
        failures.push("wrong_escalation_stub");
        score -= 40;
    }
    if (simpleConfirm && draft.split(/\s+/).length > 25) {
        warnings.push("overlong_for_simple_confirm");
        score -= 15;
    }

    // ── Factual fidelity — COA ──
    const inboundDeniesCoa =
        /\bdo not typically offer (a )?COA\b/i.test(inbound)
        || /\bno COA\b/i.test(inbound)
        || /\bwe do not (?:typically )?(?:offer|provide) (?:a )?COA\b/i.test(inbound);
    const draftClaimsCoa =
        /\bCOA received\b/i.test(draft)
        || /\breceived (?:the )?COA\b/i.test(draft);
    if (inboundDeniesCoa && draftClaimsCoa) {
        failures.push("false_coa_claim");
        score -= 40;
    }
    if (draftClaimsCoa && !/\bCOA\b/i.test(inbound) && !/\bcertificate of analysis\b/i.test(inbound)) {
        failures.push("invented_coa");
        score -= 30;
    }

    for (const cert of ["OMRI", "IBI", "USDA"]) {
        if (new RegExp(`\\b${cert}\\b`, "i").test(draft) && !new RegExp(`\\b${cert}\\b`, "i").test(inbound)) {
            warnings.push(`invented_cert_${cert}`);
            score -= 12;
        }
    }

    // Substantive mail should thank + nod at something concrete
    const inboundIsSubstantive =
        !simpleConfirm
        && (inbound.length > 400
            || /\btraceability\b/i.test(inbound)
            || /\bsample\b/i.test(inbound)
            || /\byoutube\.com\b/i.test(inbound));
    if (inboundIsSubstantive) {
        if (!/\bthanks\b|\bthank you\b|\bappreciate\b/i.test(draft)) {
            failures.push("no_thanks_on_substantive");
            score -= 15;
        }
        const concrete =
            /\btraceab/i.test(draft)
            || /\bvideo/i.test(draft)
            || /\blot\b/i.test(draft)
            || /\bsample/i.test(draft)
            || /\btest(?:ing)? results?\b/i.test(draft)
            || /\bpric/i.test(draft)
            || /\btech sheet/i.test(draft);
        if (!concrete) {
            warnings.push("no_concrete_ack");
            score -= 12;
        }
    }

    const words = draft.split(/\s+/).filter(Boolean).length;
    if (words < 1) {
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
 * True when the vendor is just confirming / closing a thread lightly
 * (not asking a question, not sending pricing packs).
 * Example: "Sounds good! I'll send over an invoice as soon as we're restocked."
 */
export function isSimpleVendorConfirmation(args: {
    subject?: string;
    bodyText?: string | null;
}): boolean {
    const text = `${args.subject || ""}\n${args.bodyText || ""}`.trim();
    if (!text || text.length > 600) return false;

    // Questions → not simple confirm
    if (/\?\s*$/m.test(text) && !/let me know if you have any questions/i.test(text)) {
        // allow trailing "let me know if questions" on longer mails; short mail with ? is a Q
        if (text.length < 280) return false;
    }
    if (/\b(?:can you|could you|please (?:confirm|advise|send|advise)|what is|when will|do you need)\b/i.test(text)
        && text.length < 400) {
        return false;
    }

    // Commercial packets → opportunity path, not simple thanks
    if (/\b(?:tier\s*\d|distributor pric|tech sheet|schedule a call|quote attached)\b/i.test(text)) {
        return false;
    }

    const confirmSignals =
        /\b(?:sounds good|perfect|will do|will send|i('ll| will) send|as soon as we('re| are) restocked|noted|got it|received with thanks|thanks for (?:letting|the update)|order (?:is )?confirmed)\b/i.test(text);

    return confirmSignals;
}

/**
 * Extract first name: display name → body sign-off → never raw local-part junk.
 */
export function extractReplyFirstName(from: string, bodyText?: string | null): string {
    // 1) Display name: "Cari Smith <cs@…>" or "Megan Bateman <…>"
    const angle = from.match(/^([^<]+)</);
    if (angle) {
        const display = angle[1].replace(/["']/g, "").trim();
        const first = display.split(/\s+/)[0];
        if (first && isUsableFirstName(first)) {
            return capitalizeName(first);
        }
    }

    // 2) Body sign-off: "Best regards,\nCari" / "Thanks,\nCari HerbsNOW"
    if (bodyText) {
        const fromBody = extractNameFromSignOff(bodyText);
        if (fromBody) return fromBody;
    }

    // 3) Bare From without brackets — only if it's a real word, not cs@
    const named = from.match(/^"?([A-Za-z]{3,})/);
    if (named && isUsableFirstName(named[1]) && !from.includes("@")) {
        return capitalizeName(named[1]);
    }

    // 4) Local-part only if it looks like a real name (not cs, ap, info)
    const local = from.match(/([a-zA-Z]{3,})@/);
    if (local && isUsableFirstName(local[1]) && !/[0-9]/.test(local[1])) {
        const part = local[1].split(/[._-]/)[0];
        if (part && isUsableFirstName(part) && part.length >= 3) {
            return capitalizeName(part);
        }
    }

    return ""; // empty → no greeting
}

function isUsableFirstName(name: string): boolean {
    const n = name.trim().toLowerCase();
    if (n.length < 2) return false;
    if (BAD_GREETING_NAMES.has(n)) return false;
    if (/^[a-z]{1,2}$/i.test(n) && !/^(ed|al|bo|jo|ty|aj|jp)$/i.test(n)) return false;
    return /^[a-z][a-z'-]+$/i.test(n);
}

function capitalizeName(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * Pull first name from common email closings.
 */
export function extractNameFromSignOff(body: string): string {
    // "Best regards,\nCari" / "Thanks,\nCari\nHerbsNOW"
    const patterns = [
        /(?:best\s+regards|kind\s+regards|regards|thanks|thank\s+you|cheers|sincerely)\s*,?\s*\n+\s*([A-Z][a-z]{1,20})\b/,
        /\n\s*([A-Z][a-z]{2,20})\s*\n\s*[A-Z][A-Za-z0-9 &.-]{2,40}\s*$/, // Name\nCompany at end
    ];
    for (const re of patterns) {
        const m = body.match(re);
        if (m && isUsableFirstName(m[1])) return capitalizeName(m[1]);
    }
    return "";
}

/**
 * Format draft. No signature block, no forced greeting/sign-off wrapper.
 *
 * Bill's actual style for short vendor replies:
 *   Pure ack  → "Thanks Donna"
 *   Content   → "Lisa, I will schedule and you should receive the BOL shortly."
 *
 * No "Hi," newline greeting, no appended "Thanks!" when the body already
 * conveys acknowledgment.
 *
 * - If firstName empty and body is pure thanks → "Thanks!"
 * - If body is a single short line and we have a name → comma format
 * - Longer / substantive body with name → Hi {Name}, newline, body
 */
export function formatSignedDraft(firstName: string, bodyParagraphs: string[]): string {
    const body = bodyParagraphs.map((p) => p.trim()).filter(Boolean).join("\n\n");

    // Pure thanks line, no name → just "Thanks!" or "Thank you."
    if (/^thanks!?$|^thank you\.?$/i.test(body) && !firstName) {
        return /thank you/i.test(body) ? "Thank you." : "Thanks!";
    }

    // Short single-line body with a name → comma format: "Lisa, I will schedule..."
    // Also: pure thanks with name → "Thanks Donna"
    const singleLine = !body.includes("\n") && body.split(/\s+/).length <= 25;
    if (firstName && singleLine) {
        // If body already starts with thanks + name pattern, return as-is
        if (new RegExp(`^(thanks|thank you)\\s+${firstName}`, "i").test(body)) return body;
        // If body is a thanks variant → "Thanks Donna"
        if (/^(thanks!?|thank you\.?)$/i.test(body)) return `Thanks ${firstName}`;
        // Otherwise → "Lisa, I will schedule..."
        return `${firstName}, ${body}`;
    }

    // Longer body, no name → just the body (no forced Thanks! suffix)
    if (!firstName) {
        return body;
    }

    // Longer body with name → "Hi {Name},\n\n{body}"
    // No forced Thanks! suffix — body carries its own close if needed
    return [`Hi ${firstName},`, "", body].join("\n");
}

/** Pure simple ack — Bill's real style for light threads.
 *  "Thanks Donna" not "Hi Donna,\n\nThanks!" */
export function composeSimpleThanks(args?: { from?: string; bodyText?: string | null }): string {
    const name = args?.from ? extractReplyFirstName(args.from, args.bodyText) : "";
    if (name && name.length >= 3) {
        return `Thanks ${name}`;
    }
    return "Thanks!";
}

/**
 * Deterministic warm draft for substantive vendor commercial / info replies.
 * No Gmail-duplicate signature.
 */
export function templateWarmVendorReply(args: {
    from: string;
    subject: string;
    bodyText?: string;
    snippet?: string;
    pdfFilenames?: string[];
}): string {
    const bodyFull = args.bodyText || args.snippet || "";
    const first = extractReplyFirstName(args.from, bodyFull);
    const hay = `${args.subject}\n${bodyFull}\n${(args.pdfFilenames || []).join(" ")}`;

    if (isSimpleVendorConfirmation({ subject: args.subject, bodyText: bodyFull })) {
        return composeSimpleThanks({ from: args.from, bodyText: bodyFull });
    }

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
    if (thanksBits.length === 1) thanks = `Thanks for ${thanksBits[0]} — helpful.`;
    else if (thanksBits.length === 2) thanks = `Thanks for ${thanksBits[0]} and ${thanksBits[1]} — helpful.`;
    else {
        const last = thanksBits.pop();
        thanks = `Thanks for ${thanksBits.join(", ")}, and ${last} — helpful.`;
    }

    const parts: string[] = [thanks];
    if (deniesCoa && hasPriorTests) {
        parts.push("Noted you don't typically issue a COA for this product; the prior testing results are still useful for our review.");
    } else if (deniesCoa) {
        parts.push("Noted you don't typically issue a COA for this product.");
    }
    if (offersSample) {
        parts.push("A sample would be welcome if you can send one.");
    }
    parts.push("We'll review on our side and follow up.");

    return formatSignedDraft(first, parts);
}
