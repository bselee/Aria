/**
 * @file    vendor-reply-detector.ts
 * @purpose Find vendor replies to a PO that landed OUTSIDE the original
 *          PO email thread. Vendors do this a lot — different reply address,
 *          fresh subject, ship confirmation from a different system, etc.
 *
 * Strategy chain (highest confidence wins, first hit returns):
 *   1. Subject contains PO number explicitly
 *   2. Body or attachment filename contains PO number
 *   3. Sender domain matches vendor + that vendor has exactly one unacked PO
 *      sent within 30 days (date proximity + domain uniqueness)
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

    const poRegex = new RegExp(`\\b(?:PO|Order|Order\\s*#)?\\s*[#-]?\\s*${digits}\\b`, 'i');
    const domains = target.vendorDomainHints.map(d => d.toLowerCase());

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

    // Pass 3: sender-domain unique-PO match. Only valid when this PO is the
    // *only* unacked PO for that vendor in the recent window — the caller
    // is responsible for ensuring `target` is the unique candidate.
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
                    evidenceDetail: `Sole open PO for vendor domain ${fromDomain}`,
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
