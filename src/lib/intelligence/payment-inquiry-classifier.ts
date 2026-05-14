/**
 * @file    payment-inquiry-classifier.ts
 * @purpose Tri-class rule-based classifier for incoming HUMAN_INTERACTION
 *          emails: is this an automated dunning/system message, a real
 *          human asking about payment status, or general human chatter?
 *
 *          Cheap (no LLM) on purpose — runs on every human-interaction email
 *          and decides whether to:
 *            - automated_noreply    → archive silently
 *            - payment_inquiry      → leave UNREAD + emit flow trigger
 *            - general_human        → existing behavior (mark read, keep in inbox)
 *
 *          Upgrade path: if false-positive/negative rate is high, swap the
 *          internals for a Haiku call without changing the public surface.
 */

export type HumanInquiryClass =
    | "automated_noreply"
    | "payment_inquiry"
    | "general_human";

export interface ClassifyInput {
    from: string;
    subject: string;
    snippet?: string;
    body?: string;
    /** Raw email headers (lowercased name → value). Optional. */
    headers?: Record<string, string>;
}

// ── Automated / no-reply patterns ──────────────────────────────────────────
// Match in `from` field (case-insensitive). Catches the standard machine
// senders that should never need a human reply.
const AUTOMATED_FROM_PATTERNS: RegExp[] = [
    /\bno[-_.]?reply\b/i,
    /\bdo[-_.]?not[-_.]?reply\b/i,
    /\bauto(?:mated|reply|matic)\b/i,
    /\bnotifications?@/i,
    /\bmailer[-_.]?daemon\b/i,
    /\bpostmaster@/i,
];

const AUTOMATED_SUBJECT_PATTERNS: RegExp[] = [
    /\bautomated\b/i,
    /\bdo not reply\b/i,
    /\bautomatic notification\b/i,
];

// ── Payment-inquiry patterns ───────────────────────────────────────────────
// Subject or body language that strongly signals "vendor asking about
// payment / past due / aging / when will I get paid".
const PAYMENT_SUBJECT_PATTERNS: RegExp[] = [
    /\bpast[-_ ]due\b/i,
    /\boverdue\b/i,
    /\bpayment status\b/i,
    /\bpayment reminder\b/i,
    /\binvoice (?:status|reminder|follow[-_ ]?up)\b/i,
    /\baging (?:report|notice)\b/i,
    /\boutstanding balance\b/i,
    /\bremittance\b/i,
    /\bwhen (?:will|can).*pay/i,
];

const PAYMENT_BODY_PATTERNS: RegExp[] = [
    /\bpayment status\b/i,
    /\bpast[-_ ]due\b/i,
    // "when will we get paid", "when can I be paid", etc — uses pa(?:y|id|yment)
    // because /\bpay/ does NOT match "paid" (y vs i mismatch in regex literal).
    /\bwhen (?:will|can) (?:we|you|i)\b.*\bpa(?:y|id|yment)/i,
    /\boutstanding (?:invoice|balance)\b/i,
    /\bplease (?:remit|provide).*\b(?:payment|status)\b/i,
    /\baging report\b/i,
];

function anyMatch(patterns: RegExp[], haystack: string): boolean {
    return patterns.some((re) => re.test(haystack));
}

export function classifyHumanInquiry(input: ClassifyInput): HumanInquiryClass {
    const from = (input.from ?? "").toString();
    const subject = (input.subject ?? "").toString();
    const snippet = (input.snippet ?? "").toString();
    const body = (input.body ?? "").toString();
    const headers = input.headers ?? {};

    // RFC 3834: Auto-Submitted header is the canonical machine-message signal.
    const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
    if (autoSubmitted && autoSubmitted !== "no") {
        return "automated_noreply";
    }

    // From-line / subject heuristics for no-reply senders.
    if (
        anyMatch(AUTOMATED_FROM_PATTERNS, from) ||
        anyMatch(AUTOMATED_SUBJECT_PATTERNS, subject)
    ) {
        return "automated_noreply";
    }

    // Payment-inquiry signals. Subject is the strong signal; body is a
    // secondary check that catches short, low-signal subjects ("question").
    const combinedShort = subject + "\n" + snippet;
    if (
        anyMatch(PAYMENT_SUBJECT_PATTERNS, combinedShort) ||
        anyMatch(PAYMENT_BODY_PATTERNS, body)
    ) {
        return "payment_inquiry";
    }

    return "general_human";
}
