/**
 * @file    src/lib/purchasing/po-thread-clock.ts
 * @purpose Split a BuildASoil PO email thread into hold vs fulfill.
 *          Sold-out / backorder wait is not lead time. Fulfill lead is
 *          restock message → ship message. Silent threads are not holds.
 * @author  Hermia
 * @created 2026-09-24
 * @deps    none
 * @env     none
 */

/** One message already pulled off a PO thread. */
export interface ThreadClockMessage {
    /** ISO timestamp. */
    at: string;
    /** True when the sender is us (bill.selee / ap / finale noreply on our behalf). */
    fromUs: boolean;
    text: string;
}

/** Clock stamped onto a PO so send→receive is not used as lead. */
export interface PoThreadClock {
    hold: boolean;
    excludeFromLeadPlan: boolean;
    /** YYYY-MM-DD of the vendor sold-out / backorder reply. */
    holdStartedAt: string | null;
    /** YYYY-MM-DD the vendor said the goods were actually available. */
    availableAt: string | null;
    /** YYYY-MM-DD the vendor said it shipped. */
    shippedAt: string | null;
    /** Days from available to ship. Null when either side is missing. */
    fulfillLeadDays: number | null;
    /** Short vendor sentence that opened the hold. */
    snippet: string;
}

const PO_SUBJECT_RE = /BuildASoil PO\s*#\s*(\d+)/i;
const HOLD_RE = /\b(?:temporarily\s+)?sold\s+out\b|\bout\s+of\s+stock\b|\bback[\s-]?order(?:ed)?\b/i;
const AVAILABLE_RE = /\b(?:fully\s+restocked|we(?:'re| are)\s+(?:fully\s+)?restocked|back\s+in\s+stock|now\s+in\s+stock|stock\s+has\s+arrived)\b/i;
const FUTURE_RESTOCK_RE = /\b(?:as\s+soon\s+as|when|once)\b[\s\S]{0,40}\brestock/i;
const SHIP_RE = /\b(?:shipping\s+today|shipped\s+today|ships\s+today|order\s+is\s+shipping|your\s+order\s+is\s+shipping)\b/i;

function dayOf(iso: string): string {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return iso.slice(0, 10);
    return t.toISOString().slice(0, 10);
}

function daySpan(startDay: string | null, endDay: string | null): number | null {
    if (!startDay || !endDay) return null;
    const a = new Date(`${startDay}T00:00:00Z`).getTime();
    const b = new Date(`${endDay}T00:00:00Z`).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Strip tags and the entities Gmail leaves in stored bodies.
 * "sold out" split by markup must still match.
 */
export function plainThreadText(text: string): string {
    return text
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ")
        .trim();
}

/** PO number from `BuildASoil PO # 125126 - Vendor - date`, including Re: replies. */
export function poNumberFromSubject(subject: string | null | undefined): string | null {
    if (!subject) return null;
    const match = subject.match(PO_SUBJECT_RE);
    return match ? match[1] : null;
}

/** Our send, or Finale sending on our behalf, never opens a hold. */
export function isOurSender(from: string | null | undefined): boolean {
    const value = (from || "").toLowerCase();
    return value.includes("buildasoil.com") || value.includes("finaleinventory.com");
}

const NOT_A_HOLD_RE = /(?:don'?t|do not|never)\s+want[\s\S]{0,80}back[\s-]?order/i;
const QUOTE_CUT_RE = /\bOn\s+\w.{0,160}\bwrote:|\bFrom:\s+Bill Selee\b/i;

/**
 * Vendor's own words. Quoted replies (our chase, their quote of us) are not a hold.
 */
export function vendorOwnText(text: string): string {
    const plain = plainThreadText(text);
    const cut = plain.search(QUOTE_CUT_RE);
    if (cut >= 40) return plain.slice(0, cut).trim();
    return plain;
}

function isHoldText(text: string): boolean {
    if (NOT_A_HOLD_RE.test(text)) return false;
    return HOLD_RE.test(text);
}

function firstSentence(text: string, re: RegExp): string {
    const flat = text.replace(/\s+/g, " ").trim();
    const idx = flat.search(re);
    if (idx < 0) return flat.slice(0, 140);
    const start = Math.max(0, flat.lastIndexOf(".", idx) + 1);
    const endStop = flat.indexOf(".", idx);
    const end = endStop === -1 ? Math.min(flat.length, idx + 140) : endStop + 1;
    return flat.slice(start, end).trim().slice(0, 180);
}

/**
 * Read hold / restock / ship off vendor messages on a PO thread.
 * Our own mail never opens a hold and never counts as available.
 *
 * @param messages Chronological thread messages. Order is sorted here.
 * @returns Clock. `excludeFromLeadPlan` is true only when the vendor said they could not fill.
 */
export function readPoThreadClock(messages: ThreadClockMessage[]): PoThreadClock {
    const ordered = [...messages].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const vendor = ordered.filter((m) => !m.fromUs && m.text.trim().length > 0);

    let holdStartedAt: string | null = null;
    let snippet = "";
    let availableAt: string | null = null;
    let shippedAt: string | null = null;

    for (const msg of vendor) {
        const text = vendorOwnText(msg.text);
        const day = dayOf(msg.at);
        if (!holdStartedAt && isHoldText(text)) {
            holdStartedAt = day;
            snippet = firstSentence(text, HOLD_RE);
        }
        const futurePromise = FUTURE_RESTOCK_RE.test(text) && !/\bfully\s+restocked\b/i.test(text);
        if (!availableAt && AVAILABLE_RE.test(text) && !futurePromise) {
            availableAt = day;
        }
        if (!shippedAt && SHIP_RE.test(text)) {
            shippedAt = day;
        }
    }

    const hold = holdStartedAt != null;
    return {
        hold,
        excludeFromLeadPlan: hold,
        holdStartedAt,
        availableAt,
        shippedAt,
        fulfillLeadDays: daySpan(availableAt, shippedAt),
        snippet,
    };
}

/** Columns written onto purchase_orders when the vendor could not fill. */
export function holdStampRow(
    poNumber: string,
    clock: PoThreadClock,
    stampedAt = new Date().toISOString(),
): Record<string, string | number | boolean | null> | null {
    if (!clock.excludeFromLeadPlan) return null;
    return {
        po_number: poNumber,
        thread_hold: true,
        thread_hold_started_at: clock.holdStartedAt,
        thread_available_at: clock.availableAt,
        thread_shipped_at: clock.shippedAt,
        thread_fulfill_lead_days: clock.fulfillLeadDays,
        thread_hold_snippet: clock.snippet.slice(0, 180),
        thread_clock_at: stampedAt,
        updated_at: stampedAt,
    };
}

/**
 * Mark a receipt sample when its PO thread was a stockout hold.
 * Samples with no matching stamp are unchanged.
 */
export function applyHoldStamp<T extends { orderId?: string; holdExcluded?: boolean; holdNote?: string }>(
    sample: T,
    stamp: { snippet: string } | undefined,
): T {
    if (!sample.orderId || !stamp) return sample;
    const note = stamp.snippet
        ? `PO ${sample.orderId} stockout: ${stamp.snippet}`
        : `PO ${sample.orderId} stockout hold excluded`;
    return { ...sample, holdExcluded: true, holdNote: note.slice(0, 200) };
}
