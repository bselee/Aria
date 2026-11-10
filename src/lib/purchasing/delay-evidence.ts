/**
 * @file    delay-evidence.ts
 * @purpose Turn a vendor email thread into an honest, quotable delay note.
 *
 *          The report must never say "no reply" or "no update" — that is a claim
 *          about absence, and it was wrong on every delayed PO checked: North
 *          Mason had replied five times, Rapid Packaging had given a firm ship
 *          date. Extract the vendor's own sentence and cite its date instead.
 *
 * @author  Hermia
 * @created 2026-11-09
 * @deps    none (pure)
 */

/** Language that indicates the vendor is explaining a delay or giving an ETA. */
const DELAY_SIGNAL =
    /\b(delay(s|ed)?|backorder(s|ed)?|back[ -]order(s|ed)?|behind|late|out of stock|unavailable|production issue(s)?|downtime|eta|ship[ -]date|expected|arriving|apolog\w*|on hold|pushed|postpon\w*|short)\b/i;

/** A concrete date or relative commitment, which makes a sentence quotable. */
const DATE_SIGNAL =
    /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|january|february|march|april|may|june|july|august|september|october|november|december|next week|next month|end of (the )?(week|month)|tomorrow)\b/i;

/** Our own outbound mail, which is not evidence of what the vendor said. */
export function isOurOwnSender(from: string): boolean {
    return /buildasoil\.com/i.test(from || "");
}

/** Remove mail-client quote markers and collapse whitespace. */
export function cleanLine(line: string): string {
    return line
        .replace(/^\s*(>+\s*)+/, "")
        .replace(/^\s*(On .+wrote:?|-----Original Message-----)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Remove quoted history so the vendor's own words are all that remain.
 *
 * Vendor replies routinely quote our previous message, and a naive body scan
 * picks our words back up as if the vendor had said them — that is how "Any
 * update on tracking or an ETA?" ended up quoted as a North Mason delay notice.
 *
 * @param body Plain-text email body.
 * @returns The body with quoted lines and the forwarded-message header removed.
 */
export function stripQuotedText(body: string): string {
    const out: string[] = [];
    for (const line of String(body || "").split(/\r?\n/)) {
        if (/^\s*>/.test(line)) continue;
        if (/^\s*On .+wrote:\s*$/i.test(line)) break;
        if (/^\s*-{2,}\s*Original Message/i.test(line)) break;
        if (/^\s*From:\s+.*@/i.test(line) && out.length > 0) break;
        out.push(line);
    }
    return out.join("\n");
}

/**
 * Pull the single most useful delay sentence out of an email body.
 *
 * Scores each sentence: a delay word is required, a concrete date ranks above
 * a bare delay mention, and vendor-apology language breaks ties. Long quoted
 * chains are cleaned first so the sentence reads as a statement, not a quote.
 *
 * @param body Plain-text email body.
 * @returns The best sentence, or null when the mail says nothing about timing.
 */
export function pickDelaySentence(body: string): string | null {
    const sentences = body
        .split(/\n+|(?<=[.!?])\s+/)
        .map(cleanLine)
        .filter((s) => s.length >= 25 && s.length <= 320);

    let best: { score: number; text: string } | null = null;
    for (const s of sentences) {
        if (!DELAY_SIGNAL.test(s)) continue;
        if (/^\[?external email/i.test(s)) continue;
        if (/unsubscribe|view in browser|privacy policy/i.test(s)) continue;
        let score = 1;
        if (DATE_SIGNAL.test(s)) score += 3;
        if (/\b(eta|ship[- ]date|backorder|back order)\b/i.test(s)) score += 2;
        // A stated reason is more useful than an apology: prefer the sentence
        // that says what actually happened over "I am sorry about the delays".
        if (/\b(production|issue(s)?|downtime|machine|equipment|repair|supplier|material|stock)\b/i.test(s)) score += 2;
        if (/^(i am |i'm )?sorry\b/i.test(s) && s.length < 50) score -= 2;
        if (/\b(apolog|sorry)\b/i.test(s) && !DATE_SIGNAL.test(s)) score -= 1;
        // Prefer a sentence that survives with its own subject.
        if (s.length < 40) score -= 1;
        // Ties go to the LATER sentence: a thread often repeats the original
        // estimate and then supersedes it, so the newest statement wins.
        if (!best || score >= best.score) best = { score, text: s };
    }
    return best ? best.text : null;
}

/**
 * Build the report note from an extracted sentence and its email date.
 *
 * Keeps the vendor's wording (shortened) and always cites when they said it, so
 * a reader can find the mail. Never invents a reason.
 *
 * @param sentence Vendor sentence from `pickDelaySentence`.
 * @param sentIso  ISO date of that email.
 * @returns Note such as `Backorder until January 2027 (vendor 8/12)`.
 */
export function formatDelayNote(sentence: string, sentIso: string): string {
    const text = cleanLine(sentence)
        .replace(/^(hi|hello|hey)[^,]*,\s*/i, "")
        // Only strip an apology clause that hands off with "but" — stripping at
        // the first period used to eat the entire sentence, citation and all.
        .replace(/^(i am |i'm )?sorry( to say)?( that)? but\s+/i, "")
        .replace(/^we('ve| have)? (received|placed)[^.]*\.\s*/i, "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();

    const short = text.length > 78 ? `${text.slice(0, 75).trimEnd()}…` : text;
    const capped = short ? short.charAt(0).toUpperCase() + short.slice(1) : short;
    const [, m, d] = sentIso.split("-");
    return `${capped} (vendor ${Number(m)}/${Number(d)})`;
}
