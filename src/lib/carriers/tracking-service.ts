/**
 * @file    tracking-service.ts
 * @purpose Carrier tracking detection, URL generation, and status retrieval.
 *          Supports UPS, FedEx (direct API), USPS, DHL, EasyPost, and LTL freight
 *          carriers (Old Dominion, XPO, Saia, Estes, R&L, Dayton, etc.)
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 * @deps    @easypost/api
 * @env     FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, EASYPOST_API_KEY
 */

import EasyPostClient from '@easypost/api';

// ──────────────────────────────────────────────────
// TRACKING PATTERNS
// ──────────────────────────────────────────────────

export const TRACKING_PATTERNS = {
    ups: /\b1Z[0-9A-Z]{16}\b/i,
    // FedEx: 12-digit express, 15-digit ground, or 96XXXXXXXXXXXXXXXXXX (20-digit SmartPost)
    fedex: /\b(96\d{18}|\d{15}|\d{12})\b/,
    usps: /\b(94|92|93|95)\d{20}\b/,
    dhl: /\bJD\d{18}\b/i,
    // generic: require '#' or ':' separator — prevents "tracking information" false matches
    // keyword is non-capturing (?:...) so match[1] is always the tracking number
    generic: /\b(?:tracking|track|waybill)\s*[#:]\s*([0-9][0-9A-Z]{9,24})\b/i,
    // LTL freight identifiers — whitespace required after keyword
    pro: /\bPRO[\s\-]+#?\s*([0-9]{7,15})\b/i,
    bol: /\b(?:BOL[\s\-]+#?\s*|Bill\s+of\s+Lading\s+#?\s*)([0-9][0-9A-Z]{5,24})\b/i,
};

// ──────────────────────────────────────────────────
// LTL CARRIER DETECTION
// ──────────────────────────────────────────────────

// Ordered by specificity (most specific first)
const LTL_CARRIER_KEYWORDS: [RegExp, string][] = [
    [/\bold\s+dominion\s+freight\b/i, 'Old Dominion'],
    [/\bold\s+dominion\b/i, 'Old Dominion'],
    [/\bodfl\b/i, 'Old Dominion'],
    [/\bdayton\s+freight\b/i, 'Dayton Freight'],
    [/\bfedex\s+freight\b/i, 'FedEx Freight'],
    [/\br\s*&\s*l\s+carriers?\b/i, 'R&L Carriers'],
    [/\brl\s+carriers?\b/i, 'R&L Carriers'],
    [/\bxpo\s+logistics\b/i, 'XPO Logistics'],
    [/\bxpo\b/i, 'XPO Logistics'],
    [/\btforce\s+freight\b/i, 'TForce Freight'],
    [/\bups\s+freight\b/i, 'TForce Freight'],
    [/\byrc\s+freight\b/i, 'YRC Freight'],
    [/\byellow\s+freight\b/i, 'Yellow Freight'],
    [/\bcentral\s+transport\b/i, 'Central Transport'],
    [/\babf\s+freight\b/i, 'ABF Freight'],
    [/\barcbest\b/i, 'ArcBest'],
    [/\bestes\s+express\b/i, 'Estes'],
    [/\bestes\b/i, 'Estes'],
    [/\bsaia\b/i, 'Saia'],
];

/**
 * Detect an LTL freight carrier name from free-form text.
 *
 * @param   text  - Body text to search for carrier keywords
 * @returns Canonical carrier name if found, null otherwise
 */
export function detectLTLCarrier(text: string): string | null {
    for (const [pattern, name] of LTL_CARRIER_KEYWORDS) {
        if (pattern.test(text)) return name;
    }
    return null;
}

// ──────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────

export type TrackingCategory = 'delivered' | 'out_for_delivery' | 'in_transit' | 'exception';

export interface TrackingStatus {
    category: TrackingCategory;
    display: string;
    public_url?: string;
}

// ──────────────────────────────────────────────────
// LTL DIRECT LINKS
// ──────────────────────────────────────────────────

const LTL_DIRECT_LINKS: Record<string, string> = {
    'Old Dominion Freight Line': 'https://www.odfl.com/trace/Trace.jsp?pro={PRO}',
    'Old Dominion': 'https://www.odfl.com/trace/Trace.jsp?pro={PRO}',
    'Saia': 'https://www.saia.com/tracking?pro={PRO}',
    'Estes': 'https://www.estes-express.com/tracking?pro={PRO}',
    'R&L Carriers': 'https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro={PRO}',
    'XPO Logistics': 'https://app.xpo.com/track/pro/{PRO}',
    'Dayton Freight': 'https://www.daytonfreight.com/tracking/?pro={PRO}',
    'FedEx Freight': 'https://www.fedex.com/fedextrack/?tracknumbers={PRO}',
    'UPS Freight': 'https://www.tforcefreight.com/ltl/apps/Tracking?type=P&HAWB={PRO}',
    'TForce Freight': 'https://www.tforcefreight.com/ltl/apps/Tracking?type=P&HAWB={PRO}',
    'YRC Freight': 'https://my.yrc.com/tools/track/shipments?referenceNumber={PRO}',
    'Yellow Freight': 'https://my.yrc.com/tools/track/shipments?referenceNumber={PRO}',
    'Central Transport': 'https://www.centraltransport.com/forms/tracking.aspx?pro={PRO}',
    'ABF Freight': 'https://arcb.com/tools/tracking.html?pro={PRO}',
    'ArcBest': 'https://arcb.com/tools/tracking.html?pro={PRO}',
};

// ──────────────────────────────────────────────────
// URL GENERATION
// ──────────────────────────────────────────────────

/**
 * Build a public tracking URL for a given tracking number.
 * Handles LTL (Carrier:::PRO) format, UPS, USPS, DHL, FedEx, and generic fallback.
 *
 * @param   trackingNumber  - Raw tracking number or Carrier:::Number for LTL
 * @returns Public URL for tracking the shipment
 */
export function carrierUrl(trackingNumber: string): string {
    // Check if it's an LLM-encoded string (Carrier:::Number)
    if (trackingNumber.includes(':::')) {
        const [carrierName, actualNumber] = trackingNumber.split(':::', 2);

        // Find a matching LTL direct link if available
        const knownCarrier = Object.keys(LTL_DIRECT_LINKS).find(k =>
            carrierName.toLowerCase().includes(k.toLowerCase())
        );

        if (knownCarrier) {
            return LTL_DIRECT_LINKS[knownCarrier].replace('{PRO}', encodeURIComponent(actualNumber));
        }

        // Fallback for an unknown LTL carrier that we still scraped
        return `https://parcelsapp.com/en/tracking/${actualNumber}`;
    }

    if (/^1Z/i.test(trackingNumber)) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    if (/^(94|92|93|95)/.test(trackingNumber)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
    if (/^JD/i.test(trackingNumber)) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${trackingNumber}`;
    if (/\b(96\d{18}|\d{15}|\d{12})\b/.test(trackingNumber)) return `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`;
    // Fallback for PRO, BOL, or generic
    return `https://parcelsapp.com/en/tracking/${trackingNumber}`;
}

// ──────────────────────────────────────────────────
// STATUS PARSING
// ──────────────────────────────────────────────────

/**
 * Parse delivery status from carrier page markdown using regex — no LLM.
 *
 * @param   content  - Raw text content from a carrier tracking page
 * @returns Parsed tracking status or null if not parseable
 */
export function parseTrackingContent(content: string): TrackingStatus | null {
    // Delivered — check first; most definitive
    const deliveredDate = content.match(
        /delivered\s+(?:on\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (deliveredDate) return { category: 'delivered', display: `Delivered ${deliveredDate[1]}` };
    if (/\bdelivered\b/i.test(content)) return { category: 'delivered', display: 'Delivered' };

    // Out for delivery
    if (/out\s+for\s+delivery/i.test(content))
        return { category: 'out_for_delivery', display: 'Out for delivery' };

    // Exception / delay
    if (/\bexception\b|\bdelay(ed)?\b|unable to deliver/i.test(content))
        return { category: 'exception', display: 'Delivery exception' };

    // Estimated / scheduled / expected delivery date — optional day-of-week prefix handled
    const eta = content.match(
        /(?:estimated|scheduled|expected)\s+delivery[:\s]+(?:[A-Z][a-z]+,\s+)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i
    );
    if (eta) return { category: 'in_transit', display: `Expected ${eta[1]}` };

    // "by end of day <date>"
    const eod = content.match(/by\s+end\s+of\s+(?:business\s+)?day[,\s]+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i);
    if (eod) return { category: 'in_transit', display: `Expected by ${eod[1]}` };

    // Generic in-transit signals
    if (/in\s+transit|on\s+the\s+way|picked\s+up|departed/i.test(content))
        return { category: 'in_transit', display: 'In transit' };

    return null;
}

// ──────────────────────────────────────────────────
// CARRIER DETECTION (new public API)
// ──────────────────────────────────────────────────

/**
 * Detect the carrier from a tracking number based on format.
 *
 * @param   trackingNumber  - Raw tracking number string
 * @returns Lowercase carrier slug ('ups', 'fedex', 'usps', 'dhl') or null
 */
export function detectCarrier(trackingNumber: string): string | null {
    if (TRACKING_PATTERNS.ups.test(trackingNumber)) return 'ups';
    if (/^(94|92|93|95)\d{20,}$/.test(trackingNumber)) return 'usps';
    if (TRACKING_PATTERNS.dhl.test(trackingNumber)) return 'dhl';
    // FedEx: 12-digit, 15-digit, or 96-prefix (20-digit SmartPost)
    if (/^\d{12}$/.test(trackingNumber) || /^\d{15}$/.test(trackingNumber) || /^96\d{18,20}$/.test(trackingNumber)) return 'fedex';
    return null;
}

/**
 * Extract the first tracking number found in a body of text.
 *
 * @param   text  - Free-form text to search
 * @returns The first tracking number found, or null
 */
export function extractTrackingNumber(text: string): string | null {
    // Check each pattern in priority order
    const upsMatch = text.match(TRACKING_PATTERNS.ups);
    if (upsMatch) return upsMatch[0];

    const uspsMatch = text.match(TRACKING_PATTERNS.usps);
    if (uspsMatch) return uspsMatch[0];

    const dhlMatch = text.match(TRACKING_PATTERNS.dhl);
    if (dhlMatch) return dhlMatch[0];

    const fedexMatch = text.match(TRACKING_PATTERNS.fedex);
    if (fedexMatch) return fedexMatch[0];

    const genericMatch = text.match(TRACKING_PATTERNS.generic);
    if (genericMatch) return genericMatch[1]; // captured group

    const proMatch = text.match(TRACKING_PATTERNS.pro);
    if (proMatch) return proMatch[1];

    const bolMatch = text.match(TRACKING_PATTERNS.bol);
    if (bolMatch) return bolMatch[1];

    return null;
}

// ──────────────────────────────────────────────────
// FEDEX DIRECT API
// ──────────────────────────────────────────────────

// FedEx OAuth token cache — avoid re-authing on every call (tokens last 1h)
let _fedexToken: string | null = null;
let _fedexTokenExpiry = 0;

/**
 * Detect if a tracking number looks like FedEx format.
 * 12-digit, 15-digit, 20-digit, or 96-prefix numbers.
 */
export function isFedExNumber(num: string): boolean {
    return /^\d{12}$/.test(num) || /^\d{15}$/.test(num) || /^96\d{18,20}$/.test(num) || /^\d{20}$/.test(num);
}

/**
 * Track a FedEx shipment directly via FedEx Track API (free with account credentials).
 * No per-call cost — uses BuildASoil's own FedEx developer account.
 *
 * @param   trackingNumber  - FedEx tracking number
 * @returns Tracking status or null if unavailable
 */
export async function getFedExTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    const clientId = process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    try {
        // Refresh OAuth token if expired
        if (!_fedexToken || Date.now() >= _fedexTokenExpiry) {
            const authRes = await fetch('https://apis.fedex.com/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(),
            });
            if (!authRes.ok) throw new Error(`FedEx auth ${authRes.status}: ${await authRes.text()}`);
            const auth = await authRes.json() as { access_token: string; expires_in: number };
            _fedexToken = auth.access_token;
            _fedexTokenExpiry = Date.now() + (auth.expires_in - 60) * 1000; // 60s buffer
        }

        const trackRes = await fetch('https://apis.fedex.com/track/v1/trackingnumbers', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${_fedexToken}`,
                'X-locale': 'en_US',
            },
            body: JSON.stringify({
                trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
                includeDetailedScans: false,
            }),
        });

        if (!trackRes.ok) throw new Error(`FedEx track ${trackRes.status}: ${await trackRes.text()}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await trackRes.json() as any;

        const result = data?.output?.completeTrackResults?.[0]?.trackResults?.[0];
        if (!result) return null;

        const statusCode: string = result.latestStatusDetail?.code ?? '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dates: any[] = result.dateAndTimes ?? [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const deliveredEntry = dates.find((d: any) => d.type === 'ACTUAL_DELIVERY');
        const estEntry = result.estimatedDeliveryTimeWindow?.window?.ends;

        switch (statusCode) {
            case 'DL': {
                let display = 'Delivered';
                if (deliveredEntry?.dateTime) {
                    const d = new Date(deliveredEntry.dateTime);
                    display = `Delivered ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                }
                return { category: 'delivered', display, public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            }
            case 'OD':
                return { category: 'out_for_delivery', display: 'Out for delivery', public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            case 'DE':
                return { category: 'exception', display: 'Delivery exception', public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            default: {
                let display = 'In transit';
                if (estEntry) {
                    const e = new Date(estEntry);
                    display = `Expected ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                }
                return { category: 'in_transit', display, public_url: `https://www.fedex.com/apps/fedextrack/?tracknumbers=${trackingNumber}` };
            }
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[tracking-api] FedEx direct track failed for ${trackingNumber}: ${message}`);
        return null;
    }
}

// ──────────────────────────────────────────────────
// LTL TRACKING
// ──────────────────────────────────────────────────

/**
 * Fetch tracking status directly from LTL carrier website.
 * Returns null if tracking fails or carrier is unknown.
 *
 * @param   trackingNumber  - Must be "CarrierName:::PRO#" format
 * @returns Tracking status or null
 */
export async function getLTLTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    // trackingNumber must be "CarrierName:::PRO#" format
    if (!trackingNumber.includes(':::')) return null;
    const url = carrierUrl(trackingNumber);
    // parcelsapp fallback means unknown carrier — skip fetch
    if (url.includes('parcelsapp.com')) return null;

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const html = await res.text();
        // Strip HTML tags, collapse whitespace
        const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ');
        const parsed = parseTrackingContent(text);
        if (parsed) return { ...parsed, public_url: url };
    } catch {
        // Timeout, network error, JS-only page — silently ignore, link is still clickable
    }
    return null;
}

// ──────────────────────────────────────────────────
// UNIFIED TRACKING STATUS
// ──────────────────────────────────────────────────

/**
 * Get tracking status for any tracking number.
 * Routes to the appropriate carrier API based on number format:
 * - LTL (:::) → carrier page fetch (free)
 * - FedEx → direct FedEx API (free with credentials)
 * - Everything else → EasyPost API
 *
 * @param   trackingNumber  - Raw tracking number or Carrier:::PRO for LTL
 * @returns Tracking status or null if unavailable
 */
export async function getTrackingStatus(trackingNumber: string): Promise<TrackingStatus | null> {
    const rawNumber = trackingNumber.includes(':::') ? trackingNumber.split(':::', 2)[1] : trackingNumber;

    // LTL (:::) — try carrier page fetch first (free, no credentials)
    if (trackingNumber.includes(':::')) {
        return getLTLTrackingStatus(trackingNumber);
    }

    // Parcel FedEx — direct FedEx API (free with account credentials)
    if (isFedExNumber(rawNumber)) {
        return getFedExTrackingStatus(rawNumber);
    }

    const apiKey = process.env.EASYPOST_API_KEY;
    if (!apiKey) return null;

    try {
        const client = new EasyPostClient(apiKey);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reqParam: any = { tracking_code: trackingNumber };

        const tracker = await client.Tracker.create(reqParam);

        // EasyPost statuses: unknown, pre_transit, in_transit, out_for_delivery, delivered,
        // available_for_pickup, return_to_sender, failure, cancelled, error
        switch (tracker.status) {
            case 'delivered': {
                let dDisplay = 'Delivered';
                if (tracker.updated_at) {
                    const d = new Date(tracker.updated_at);
                    dDisplay = `Delivered ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                }
                return { category: 'delivered', display: dDisplay, public_url: tracker.public_url };
            }
            case 'out_for_delivery':
                return { category: 'out_for_delivery', display: 'Out for delivery', public_url: tracker.public_url };
            case 'failure':
            case 'error':
            case 'return_to_sender':
            case 'cancelled':
                return { category: 'exception', display: 'Delivery exception', public_url: tracker.public_url };
            case 'in_transit':
            case 'pre_transit':
            default: {
                let dDisplay = 'In transit';
                if (tracker.est_delivery_date) {
                    const e = new Date(tracker.est_delivery_date);
                    dDisplay = `Expected ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                }
                return { category: 'in_transit', display: dDisplay, public_url: tracker.public_url };
            }
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        // Suppress billing/insufficient funds errors so it doesn't pollute the logs
        if (message.includes('Insufficient funds')) {
            console.warn(`[tracking-api] EasyPost billing error for ${trackingNumber} — add card to clear.`);
        } else {
            console.warn(`[tracking-api] Failed to track ${trackingNumber}: ${message}`);
        }
        return null;
    }
}

// ──────────────────────────────────────────────────
// EMAIL HELPERS
// ──────────────────────────────────────────────────

/**
 * Build an RFC 2822 raw email string for a vendor follow-up reply.
 * Returns a raw MIME email suitable for Gmail's `users.messages.send` (before base64url encoding).
 *
 * @param   opts           - Email options
 * @param   opts.to        - Recipient email address
 * @param   opts.subject   - Email subject
 * @param   opts.inReplyTo - Message-ID of the message being replied to
 * @param   opts.references - Message-ID references for threading
 * @param   opts.body      - Plain text body content
 * @returns Raw MIME email string
 */
export function buildFollowUpEmail(opts: {
    to: string;
    subject: string;
    inReplyTo: string;
    references: string;
    body: string;
}): string {
    const lines = [
        `From: bill.selee@buildasoil.com`,
        `To: ${opts.to}`,
        `Subject: ${opts.subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=UTF-8`,
    ];
    if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) lines.push(`References: ${opts.references}`);
    lines.push('', opts.body);
    return lines.join('\r\n');
}
