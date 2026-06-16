/**
 * @file    vendor-reply-detector.ts
 * @purpose Find vendor replies to a PO that landed OUTSIDE the original
 *          PO email thread. Vendors do this a lot — different reply address,
 *          fresh subject, ship confirmation from a different system, etc.
 *
 * Strategy chain (highest confidence wins, first hit returns):
 *   1. Subject contains PO number explicitly (tuned for "Ref IUSA... | PO ####")
 *   2. Body or attachment filename contains PO number (or "multiple orders" / confirmation)
 *   3. Sender domain match (relaxed for multi-order vendors like CR Minerals 4-5 orders/PO,
 *      Covico, Marion Ag who reply separately per order/line)
 *
 * Vendor profiles:
 * - CR Minerals: typically 4-5 orders per PO → expect multiple separate replies
 * - Covico/Invico: consolidated multi-order POs with internal Ref numbers
 * - Marion Ag: always responds separately per order
 *
 * Returns enough evidence to write vendor_acknowledged_at + vendor_ack_source
 * to purchase_orders with confidence.
 */

export interface VendorReplyMatch {
    matched: boolean;
    receivedAt: string;             // ISO timestamp from the matching email
    source: 'subject_po' | 'body_po' | 'domain_unique';
    gmailMessageId: string;
    subject: string;
    fromEmail: string;
    evidenceDetail: string;         // human-readable why-it-matched
    qtyVariance?: {
        mentionedShipped: number;
        ordered?: number;
        sku?: string;
        mismatch: boolean;
        rawText: string;
    };
}

export interface POTarget {
    poNumber: string;
    vendorName: string;
    vendorDomainHints: string[];    // e.g. ['marionag.com', 'orders@marionag.com']
    poSentAt: string | null;
}

function emailLocalPart(addr: string): string {
    const m = addr.match(/[\w.+-]+@([\w-]+\.[\w.-]+)/);
    return m ? m[1].toLowerCase() : '';
}

function extractFromHeader(headers: any[]): string {
    const h = headers.find((x: any) => x.name?.toLowerCase() === 'from');
    if (!h?.value) return '';
    const m = h.value.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return m ? m[0].toLowerCase() : '';
}

function extractSubject(headers: any[]): string {
    return headers.find((x: any) => x.name?.toLowerCase() === 'subject')?.value ?? '';
}

function isAutoReply(headers: any[], from: string): boolean {
    // Reject true bounces and OOO autoresponders only. Order-confirmation
    // emails from vendor systems (Uline customer.service, Shopify ship-notice,
    // etc.) ARE meaningful acknowledgments even though they're auto-generated.
    if (/no-?reply|do-?not-?reply|mailer-daemon|postmaster/i.test(from)) return true;
    // Internal systems we operate — never count as a vendor reply.
    if (/calendar-notification@google\.com|@mail\.finaleinventory\.com|drive-shares-noreply|googlegroups\.com|@notion\.so|@github\.com|@vercel\.com/i.test(from)) return true;
    if (/buildasoil\.com/i.test(from)) return true;
    const subject = extractSubject(headers).toLowerCase();
    if (/out of office|automatic reply|delivery (failure|status notification)|undeliverable/i.test(subject)) return true;
    return false;
}

/**
 * Walk a Gmail message payload to assemble its text body.
 */
function gatherBody(message: any): string {
    const parts: string[] = [message.snippet ?? ''];
    function walk(p: any) {
        if (!p) return;
        if (p.body?.data) {
            try { parts.push(Buffer.from(p.body.data, 'base64url').toString('utf8')); } catch { /* ignore */ }
        }
        if (Array.isArray(p.parts)) for (const sub of p.parts) walk(sub);
    }
    walk(message.payload);
    return parts.join('\n');
}

function gatherAttachmentFilenames(message: any): string[] {
    const names: string[] = [];
    function walk(p: any) {
        if (!p) return;
        if (p.filename && typeof p.filename === 'string' && p.filename.trim()) {
            names.push(p.filename);
        }
        if (Array.isArray(p.parts)) for (const sub of p.parts) walk(sub);
    }
    walk(message.payload);
    return names;
}

/**
 * Try to find a vendor reply for a single PO target by scanning a list of
 * recent inbound Gmail messages (already fetched by the caller). Returns
 * the strongest match or { matched: false }.
 *
 * `inboundMessages` should be Gmail Message objects with full payload —
 * caller fetches them once and runs the matcher against many POs.
 */
export function matchPOAgainstInbox(
    target: POTarget,
    inboundMessages: any[],
): VendorReplyMatch {
    const digits = target.poNumber.replace(/^PO-?/i, '');
    if (!digits) return blank();

    // Tuned regex (2026-06-15): handles Covico/Invico "Ref IUSA26942 | PO 124392",
    // multi-order/consolidated POs, and Marion Ag split-reply patterns.
    // Also catches "Order Confirmation" + PO# in body.
    const poRegex = new RegExp(
        `\\b(?:PO|Order|Order\\s*#|Ref\\s*[A-Z0-9]+\\s*\\|?\\s*PO)?\\s*[#-]?\\s*${digits}\\b` +
        `|${digits}.*?(?:multiple|orders?|consolidated|confirmation)`,
        'i'
    );
    const domains = target.vendorDomainHints.map(d => d.toLowerCase());
    // Known multi-order vendors (CR Minerals typically 4-5 orders per PO,
    // Covico/Invico consolidated). These vendors often send separate replies
    // per order/line. We relax the "sole unacked PO" rule for them in Pass 3.
    const MULTI_ORDER_VENDORS = new Set([
        "cr minerals", "covico", "invico", "marion ag", "marionag", "diamond gypsum", "diamondgypsum", "diamond k"
    ]);
    const isMultiOrderVendor = MULTI_ORDER_VENDORS.has(
        (target.vendorName || "").toLowerCase()
    ) || domains.some(d =>
        d.includes("cr") || d.includes("covico") || d.includes("invico") || d.includes("marion")
    );


    // Pass 1: explicit PO# in subject
    for (const msg of inboundMessages) {
        const headers = msg.payload?.headers ?? [];
        const from = extractFromHeader(headers);
        if (!from || isAutoReply(headers, from)) continue;
        const subject = extractSubject(headers);
        if (poRegex.test(subject)) {
            return {
                matched: true,
                receivedAt: new Date(parseInt(msg.internalDate)).toISOString(),
                source: 'subject_po',
                gmailMessageId: msg.id,
                subject,
                fromEmail: from,
                evidenceDetail: `PO#${digits} appears in subject "${subject.slice(0, 100)}"`,
            };
        }
    }

    // Pass 2: PO# in body or attachment filename
    for (const msg of inboundMessages) {
        const headers = msg.payload?.headers ?? [];
        const from = extractFromHeader(headers);
        if (!from || isAutoReply(headers, from)) continue;
        const body = gatherBody(msg);
        const attachmentNames = gatherAttachmentFilenames(msg).join(' ');
        if (poRegex.test(body) || poRegex.test(attachmentNames)) {
            return {
                matched: true,
                receivedAt: new Date(parseInt(msg.internalDate)).toISOString(),
                source: 'body_po',
                gmailMessageId: msg.id,
                subject: extractSubject(headers),
                fromEmail: from,
                evidenceDetail: poRegex.test(body)
                    ? `PO#${digits} found in body`
                    : `PO#${digits} found in attachment filename`,
            };
        }
    }

    // Pass 3: sender-domain match.
    // For multi-order vendors (CR Minerals 4-5 orders/PO, Covico, Marion Ag)
    // we accept any domain match (they send separate replies per order).
    // For normal vendors we still require uniqueness (caller responsibility).
    if (domains.length > 0) {
        for (const msg of inboundMessages) {
            const headers = msg.payload?.headers ?? [];
            const from = extractFromHeader(headers);
            if (!from || isAutoReply(headers, from)) continue;
            const fromDomain = emailLocalPart(from);
            if (!fromDomain) continue;
            if (domains.some(d => fromDomain.includes(d) || d.includes(fromDomain))) {
                return {
                    matched: true,
                    receivedAt: new Date(parseInt(msg.internalDate)).toISOString(),
                    source: 'domain_unique',
                    gmailMessageId: msg.id,
                    subject: extractSubject(headers),
                    fromEmail: from,
                    evidenceDetail: isMultiOrderVendor
                    ? `Domain match for multi-order vendor ${fromDomain} (CR Minerals / Covico style)`
                    : `Sole open PO for vendor domain ${fromDomain}`,
                };
            }
        }
    }

    return blank();
}

function blank(): VendorReplyMatch {
    return {
        matched: false,
        receivedAt: '',
        source: 'subject_po',
        gmailMessageId: '',
        subject: '',
        fromEmail: '',
        evidenceDetail: '',
    };
}

function detectQtyVariance(body: string, orderedQty?: number): VendorReplyMatch['qtyVariance'] | undefined {
    const lower = body.toLowerCase();

    // Patterns for variance language: "90x instead of 80x", "sent 90 received 80", "90 instead of 80", "extra 10", "short 5"
    const varianceRegex = /(?:sent|shipped|received|got)\s*(\d+)\s*(?:x|pcs|units|bags|pots|ea)?\s*(?:instead of|vs|versus|not|of)\s*(\d+)|(\d+)\s*(?:instead of|vs|versus)\s*(\d+)|extra\s*(\d+)|short\s*(\d+)/i;

    const match = lower.match(varianceRegex);
    if (!match) return undefined;

    let mentionedShipped = 0;
    let mentionedOrdered = orderedQty;

    // Extract numbers from common patterns
    if (match[1] && match[2]) {
        mentionedShipped = parseInt(match[1], 10);
        mentionedOrdered = parseInt(match[2], 10);
    } else if (match[3] && match[4]) {
        mentionedShipped = parseInt(match[3], 10);
        mentionedOrdered = parseInt(match[4], 10);
    } else if (match[5]) {
        // "extra 10" — assume shipped = ordered + extra
        mentionedShipped = (orderedQty || 0) + parseInt(match[5], 10);
    } else if (match[6]) {
        mentionedShipped = (orderedQty || 0) - parseInt(match[6], 10);
    }

    if (mentionedShipped === 0) return undefined;

    const mismatch = mentionedOrdered !== undefined && mentionedShipped !== mentionedOrdered;

    // Try to extract SKU context (simple heuristic near the numbers)
    const skuMatch = body.match(/\b([A-Z0-9]{3,15})\b/g);
    const sku = skuMatch ? skuMatch.find(s => /[A-Z]/.test(s) && /\d/.test(s)) : undefined;

    return {
        mentionedShipped,
        ordered: mentionedOrdered,
        sku,
        mismatch,
        rawText: match[0],
    };
}
