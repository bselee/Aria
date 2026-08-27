/**
 * @file    tracking-service.test.ts
 * @purpose Unit tests for carrier detection, URL generation, and status parsing.
 *          Tests pure functions only — no network calls.
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 */

import { describe, it, expect } from 'vitest';
import {
    detectCarrier,
    extractTrackingNumbers,
    carrierUrl,
    parseTrackingContent,
    detectLTLCarrier,
    pageMentionsTrackingNumber,
    isFedExNumber,
    buildFollowUpEmail,
    TRACKING_PATTERNS,
} from './tracking-service';

const REAL_VENDOR_EMAILS = {
    thirstyEarthUpsShipstation: `
Dear Jeremy Silva,

Thank you for your order from Thirsty Earth! We wanted to let you know that your order (#19457) was shipped via UPS, UPS Ground Saver on 3/30/2026.

Track Your Shipment: 1ZJ74F69YW54289607
`,
    thirstyEarthFedexShipstation: `
Dear Jeremy Silva,

Thank you for your order from Thirsty Earth! We wanted to let you know that your order (#19457) was shipped via FedEx, FedEx Ground on 4/1/2026.

Track Your Shipment: 8051904063
`,
    organiShieldUspsShipstation: `
Dear Bill Selee,

Thank you for your order from OrganiShield! We wanted to let you know that your order (#18580) was shipped via USPS, USPS Ground Advantage on 3/31/2026.

Track Your Shipment: 9434650106151053145623
`,
    autopotQuickbooksInvoice: `
Your invoice is ready!

23371057

Here's your invoice! Thank you for your prompt payment.

23371057 UPS - 1Z22YV580360436423

This charge may appear as Organic Rescue LLC on your bank or CC statement.
`,
};

// ──────────────────────────────────────────────────
// detectCarrier
// ──────────────────────────────────────────────────

describe('detectCarrier', () => {
    it('should detect UPS tracking numbers (1Z prefix)', () => {
        expect(detectCarrier('1Z999AA10123456784')).toBe('ups');
    });

    it('should detect UPS case-insensitively', () => {
        expect(detectCarrier('1z999aa10123456784')).toBe('ups');
    });

    it('should detect USPS tracking numbers (94 prefix)', () => {
        expect(detectCarrier('9400111899223456789012')).toBe('usps');
    });

    it('should detect USPS tracking numbers (92 prefix)', () => {
        expect(detectCarrier('9200111899223456789012')).toBe('usps');
    });

    it('should detect DHL tracking numbers (JD prefix)', () => {
        expect(detectCarrier('JD012345678901234567')).toBe('dhl');
    });

    it('should return null for unrecognized format', () => {
        expect(detectCarrier('XXXX')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(detectCarrier('')).toBeNull();
    });
});

// ──────────────────────────────────────────────────
// isFedExNumber
// ──────────────────────────────────────────────────

describe('isFedExNumber', () => {
    it('should match 12-digit FedEx express numbers', () => {
        expect(isFedExNumber('123456789012')).toBe(true);
    });

    it('should match 15-digit FedEx ground numbers', () => {
        expect(isFedExNumber('123456789012345')).toBe(true);
    });

    it('should match 96-prefix SmartPost numbers', () => {
        expect(isFedExNumber('96123456789012345678')).toBe(true);
    });

    it('should match 20-digit numbers', () => {
        expect(isFedExNumber('12345678901234567890')).toBe(true);
    });

    it('should not match short numbers', () => {
        expect(isFedExNumber('12345')).toBe(false);
    });

    it('should not match alphanumeric strings', () => {
        expect(isFedExNumber('1Z999AA10123')).toBe(false);
    });
});

// ──────────────────────────────────────────────────
// carrierUrl
// ──────────────────────────────────────────────────

describe('carrierUrl', () => {
    it('should build UPS URL for 1Z-prefixed tracking', () => {
        const url = carrierUrl('1Z999AA10123456784');
        expect(url).toContain('ups.com');
        expect(url).toContain('1Z999AA10123456784');
    });

    it('should build USPS URL for 94-prefixed tracking', () => {
        const url = carrierUrl('9400111899223456789012');
        expect(url).toContain('usps.com');
    });

    it('should build DHL URL for JD-prefixed tracking', () => {
        const url = carrierUrl('JD012345678901234567');
        expect(url).toContain('dhl.com');
    });

    it('should build FedEx URL for numeric tracking', () => {
        const url = carrierUrl('123456789012');
        expect(url).toContain('fedex.com');
    });

    it('should handle LTL carrier:::number format for Old Dominion', () => {
        const url = carrierUrl('Old Dominion:::1234567');
        expect(url).toContain('odfl.com');
        expect(url).toContain('1234567');
    });

    it('should handle LTL carrier:::number format for Saia', () => {
        const url = carrierUrl('Saia:::9876543');
        expect(url).toContain('saia.com');
        expect(url).toContain('9876543');
    });

    it('should handle LTL carrier:::number format for XPO', () => {
        const url = carrierUrl('XPO Logistics:::5555555');
        expect(url).toContain('xpo.com');
    });

    it('should fallback to parcelsapp for unknown LTL carrier', () => {
        const url = carrierUrl('Unknown Freight:::9999999');
        expect(url).toContain('parcelsapp.com');
    });

    it('should fallback to parcelsapp for generic numbers', () => {
        const url = carrierUrl('ABCDE12345');
        expect(url).toContain('parcelsapp.com');
    });

    it('should URL-encode PRO numbers in LTL links', () => {
        const url = carrierUrl('Old Dominion:::123 456');
        expect(url).toContain('123%20456');
    });
});

// ──────────────────────────────────────────────────
// parseTrackingContent
// ──────────────────────────────────────────────────

describe('parseTrackingContent', () => {
    it('should detect delivered status with date', () => {
        const result = parseTrackingContent('Package delivered on March 15, 2026');
        expect(result?.category).toBe('delivered');
        expect(result?.display).toContain('March 15');
    });

    it('should detect delivered status without date', () => {
        const result = parseTrackingContent('Your package has been delivered');
        expect(result?.category).toBe('delivered');
        expect(result?.display).toBe('Delivered');
    });

    it('should detect out for delivery', () => {
        const result = parseTrackingContent('Your package is out for delivery');
        expect(result?.category).toBe('out_for_delivery');
    });

    it('should detect delivery exception', () => {
        const result = parseTrackingContent('Delivery exception reported');
        expect(result?.category).toBe('exception');
    });

    it('should detect delay as exception', () => {
        const result = parseTrackingContent('Your shipment has been delayed');
        expect(result?.category).toBe('exception');
    });

    it('should detect in-transit with estimated delivery', () => {
        const result = parseTrackingContent('Estimated delivery: March 20, 2026');
        expect(result?.category).toBe('in_transit');
        expect(result?.display).toContain('March 20');
    });

    it('should detect scheduled delivery date', () => {
        const result = parseTrackingContent('Scheduled delivery: April 1, 2026');
        expect(result?.category).toBe('in_transit');
        expect(result?.display).toContain('April 1');
    });

    it('should detect by-end-of-day delivery', () => {
        const result = parseTrackingContent('by end of day, March 25, 2026');
        expect(result?.category).toBe('in_transit');
        expect(result?.display).toContain('March 25');
    });

    it('should detect generic in-transit signals', () => {
        expect(parseTrackingContent('Package is in transit')?.category).toBe('in_transit');
        expect(parseTrackingContent('Shipment picked up by carrier')?.category).toBe('in_transit');
        expect(parseTrackingContent('Departed facility')?.category).toBe('in_transit');
    });

    it('should return null for unparseable content', () => {
        expect(parseTrackingContent('lorem ipsum dolor sit amet')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(parseTrackingContent('')).toBeNull();
    });
});

// ──────────────────────────────────────────────────
// detectLTLCarrier
// ──────────────────────────────────────────────────

describe('detectLTLCarrier', () => {
    it('should detect Old Dominion (full name)', () => {
        expect(detectLTLCarrier('shipped via old dominion freight')).toBe('Old Dominion');
    });

    it('should detect Old Dominion (abbreviation)', () => {
        expect(detectLTLCarrier('ODFL tracking number')).toBe('Old Dominion');
    });

    it('should detect XPO Logistics', () => {
        expect(detectLTLCarrier('XPO Logistics tracking')).toBe('XPO Logistics');
    });

    it('should detect Saia', () => {
        expect(detectLTLCarrier('Saia freight pickup')).toBe('Saia');
    });

    it('should detect Estes', () => {
        expect(detectLTLCarrier('Estes Express delivery')).toBe('Estes');
    });

    it('should detect R&L Carriers', () => {
        expect(detectLTLCarrier('R&L Carriers shipment')).toBe('R&L Carriers');
    });

    it('should detect FedEx Freight (not confused with parcel FedEx)', () => {
        expect(detectLTLCarrier('FedEx Freight LTL')).toBe('FedEx Freight');
    });

    it('should detect TForce (formerly UPS Freight)', () => {
        expect(detectLTLCarrier('TForce Freight delivery')).toBe('TForce Freight');
    });

    it('should return null for unknown carrier', () => {
        expect(detectLTLCarrier('random text about shipping')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(detectLTLCarrier('')).toBeNull();
    });
});

// ──────────────────────────────────────────────────
// extractTrackingNumbers
// ──────────────────────────────────────────────────

describe('extractTrackingNumbers', () => {
    it('should extract UPS tracking number from text', () => {
        const results = extractTrackingNumbers('Your tracking number is 1Z999AA10123456784');
        expect(results.some(r => r.carrier === 'ups')).toBe(true);
    });

    it('should extract multiple tracking numbers from text', () => {
        const text = 'UPS: 1Z999AA10123456784, USPS: 9400111899223456789012';
        const results = extractTrackingNumbers(text);
        expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should not produce duplicates', () => {
        const text = 'tracking: 1Z999AA10123456784 and again 1Z999AA10123456784';
        const results = extractTrackingNumbers(text);
        const ups = results.filter(r => r.trackingNumber === '1Z999AA10123456784');
        expect(ups.length).toBe(1);
    });

    it('should extract generic tracking with # separator', () => {
        const results = extractTrackingNumbers('tracking #1234567890123');
        expect(results.some(r => r.carrier === 'generic')).toBe(true);
    });

    it('should return empty array for text with no tracking numbers', () => {
        expect(extractTrackingNumbers('no tracking here')).toEqual([]);
    });

    // HERMIA(2026-08-20): regression for Ferticell PO 125211 — Logan Hausherr
    // sent carrier + PRO only as an ODFL trace URL. Before urlPro the extractor
    // returned [] and the PO sat with zero tracking despite a perfect vendor ack.
    it('extracts an ODFL PRO from a carrier trace URL in the email body', () => {
        const text =
            'We shipped PO#125211 yesterday with Old Dominion. You can track your shipment here : ' +
            'https://www.odfl.com/us/en/tools/trace-track-ltl-freight.html?proNumbers=78088240060.';
        const results = extractTrackingNumbers(text);
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ carrier: 'urlPro', trackingNumber: '78088240060' }),
            ]),
        );
    });

    it('extracts tracking numbers from FedEx / UPS / USPS tracking URLs', () => {
        expect(
            extractTrackingNumbers('https://www.fedex.com/fedextrack/?tracknumbers=794657123456')
                .some(r => r.trackingNumber === '794657123456'),
        ).toBe(true);
        expect(
            extractTrackingNumbers('https://www.ups.com/track?tracknum=1Z22YV580360436423')
                .some(r => r.trackingNumber === '1Z22YV580360436423'),
        ).toBe(true);
        expect(
            extractTrackingNumbers(
                'https://tools.usps.com/go/TrackConfirmAction?tLabels=9434650106151053145623',
            ).some(r => r.trackingNumber === '9434650106151053145623'),
        ).toBe(true);
    });

    it('extracts the real UPS tracking number from a Thirsty Earth ShipStation email', () => {
        const results = extractTrackingNumbers(REAL_VENDOR_EMAILS.thirstyEarthUpsShipstation);
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    carrier: 'ups',
                    trackingNumber: '1ZJ74F69YW54289607',
                }),
            ]),
        );
    });

    it('extracts the real USPS tracking number from an OrganiShield ShipStation email', () => {
        const results = extractTrackingNumbers(REAL_VENDOR_EMAILS.organiShieldUspsShipstation);
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    carrier: 'usps',
                    trackingNumber: '9434650106151053145623',
                }),
            ]),
        );
    });

    it('extracts the real UPS tracking number embedded inside an AutoPot QuickBooks invoice email', () => {
        const results = extractTrackingNumbers(REAL_VENDOR_EMAILS.autopotQuickbooksInvoice);
        expect(results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    carrier: 'ups',
                    trackingNumber: '1Z22YV580360436423',
                }),
            ]),
        );
    });

    it('extracts PRO NUMBER from BOL-style invoice text', () => {
        const bolText = `
BILL OF LADING
Shipper: BuildASoil
PRO NUMBER: 714736261
Carrier: AAA Cooper Transport
Freight collect
PO #125100
`;
        const results = extractTrackingNumbers(bolText);
        expect(results.some((r) => r.trackingNumber === '714736261' && (r.carrier === 'pro' || r.carrier === 'bol'))).toBe(true);
        expect(detectLTLCarrier(bolText)).toBe('AAA Cooper');
    });

    // WS1 (2026-08-05) additions — LTL/FTL BOL extraction paths that scanned-BOL
    // vision OCR feeds into. These are the shapes the Tracking Board needs to
    // surface PRO numbers as `Carrier:::PRO` encoded rows.
    it('extracts BOL number from "BILL OF LADING NUMBER:" label', () => {
        const bolText = `
BILL OF LADING NUMBER: 1234567890123
Old Dominion Freight Line
Shipper: BuildASoil
`;
        const results = extractTrackingNumbers(bolText);
        expect(results.some((r) => r.trackingNumber === '1234567890123' && r.carrier === 'bol')).toBe(true);
        expect(detectLTLCarrier(bolText)).toBe('Old Dominion');
    });

    it('extracts LTL PRO with account suffix (AAA Cooper-71473626-1 format)', () => {
        const results = extractTrackingNumbers('AAA Cooper-71473626-1');
        expect(results.some((r) => r.carrier === 'ltlPro' && r.trackingNumber === '71473626-1')).toBe(true);
    });

    it('extracts PRO# after an LTL carrier name (Estes)', () => {
        const results = extractTrackingNumbers('Shipped via Estes PRO# 1234567890, 4 pallets, freight collect');
        expect(results.some((r) => r.trackingNumber === '1234567890' && r.carrier === 'pro')).toBe(true);
        expect(detectLTLCarrier('Shipped via Estes PRO# 1234567890')).toBe('Estes');
    });

    it('keeps a PRO number extracted from scanned-BOL vision text with its LTL carrier', () => {
        // Simulates bol-ocr vision output: PRO + LTL carrier name both present,
        // so the ingest encodes "AAA Cooper:::714736261" for the direct tracking URL.
        const visionOcrText = `
BILL OF LADING
Shipper: BuildASoil
PRO NUMBER: 714736261
Carrier: AAA Cooper Transport
`;
        const results = extractTrackingNumbers(visionOcrText);
        const proHit = results.find((r) => r.trackingNumber === '714736261');
        expect(proHit).toBeDefined();
        expect(proHit!.carrier === 'pro' || proHit!.carrier === 'bol').toBe(true);
        expect(detectLTLCarrier(visionOcrText)).toBe('AAA Cooper');
    });

    it('does not treat bare invoice numbers as FedEx without shipping context', () => {
        const invoiceOnly = `
Invoice 123456789012
Amount due $420.00
Subtotal $400.00
Qty 10 Unit price 40.00
`;
        const results = extractTrackingNumbers(invoiceOnly);
        expect(results.every((r) => r.carrier !== 'fedex' || r.trackingNumber !== '123456789012')).toBe(true);
    });

    it('keeps bare FedEx digits when Track Your Shipment context is present', () => {
        const results = extractTrackingNumbers(REAL_VENDOR_EMAILS.thirstyEarthFedexShipstation);
        expect(results.some((r) => r.trackingNumber === '8051904063')).toBe(true);
    });

    it('captures both real Thirsty Earth shipment variants from separate fulfillment emails', () => {
        const upsResults = extractTrackingNumbers(REAL_VENDOR_EMAILS.thirstyEarthUpsShipstation);
        const fedexResults = extractTrackingNumbers(REAL_VENDOR_EMAILS.thirstyEarthFedexShipstation);

        expect(upsResults.some((result) => result.trackingNumber === '1ZJ74F69YW54289607')).toBe(true);
        expect(fedexResults.some((result) => result.trackingNumber === '8051904063')).toBe(true);
    });
});

// ──────────────────────────────────────────────────
// buildFollowUpEmail
// ──────────────────────────────────────────────────

describe('buildFollowUpEmail', () => {
    it('should build a valid MIME email', () => {
        const raw = buildFollowUpEmail({
            to: 'vendor@example.com',
            subject: 'Re: PO #12345',
            inReplyTo: '<msg123@example.com>',
            references: '<msg000@example.com>',
            body: 'Hello, checking on this order.',
        });
        expect(raw).toContain('To: vendor@example.com');
        expect(raw).toContain('Subject: Re: PO #12345');
        expect(raw).toContain('In-Reply-To: <msg123@example.com>');
        expect(raw).toContain('References: <msg000@example.com>');
        expect(raw).toContain('Hello, checking on this order.');
        expect(raw).toContain('MIME-Version: 1.0');
    });

    it('should omit In-Reply-To when empty', () => {
        const raw = buildFollowUpEmail({
            to: 'vendor@example.com',
            subject: 'New PO',
            inReplyTo: '',
            references: '',
            body: 'New order.',
        });
        expect(raw).not.toContain('In-Reply-To');
        expect(raw).not.toContain('References');
    });
});

// ──────────────────────────────────────────────────
// TRACKING_PATTERNS export
// ──────────────────────────────────────────────────

describe('TRACKING_PATTERNS', () => {
    it('should export all expected carrier patterns', () => {
        expect(TRACKING_PATTERNS).toHaveProperty('ups');
        expect(TRACKING_PATTERNS).toHaveProperty('fedex');
        expect(TRACKING_PATTERNS).toHaveProperty('usps');
        expect(TRACKING_PATTERNS).toHaveProperty('dhl');
        expect(TRACKING_PATTERNS).toHaveProperty('generic');
        expect(TRACKING_PATTERNS).toHaveProperty('pro');
        expect(TRACKING_PATTERNS).toHaveProperty('bol');
    });

    it('should match UPS pattern', () => {
        expect(TRACKING_PATTERNS.ups.test('1Z999AA10123456784')).toBe(true);
    });

    it('should match PRO pattern', () => {
        expect(TRACKING_PATTERNS.pro.test('PRO #1234567890')).toBe(true);
    });

    describe('oakharbor pattern precision', () => {
        it('should match valid Oak Harbor tracking numbers with keywords', () => {
            const pattern = TRACKING_PATTERNS.oakharbor;
            
            expect(pattern.test('Oak Harbor 12345678')).toBe(true);
            expect(pattern.test('Oak Harbor Freight Lines: PRO# 12345678')).toBe(true);
            expect(pattern.test('Oak Harbor PRO-12345678')).toBe(true);
            expect(pattern.test('OAKH-12345678')).toBe(true);
            expect(pattern.test('OAKH PRO 12345678')).toBe(true);
            expect(pattern.test('Oak Harbor Freight Lines 123456789012')).toBe(true);
        });

        it('should NOT match standalone 8-12 digit numbers or other labels', () => {
            const pattern = TRACKING_PATTERNS.oakharbor;
            
            expect(pattern.test('12345678')).toBe(false);
            expect(pattern.test('123456789012')).toBe(false);
            expect(pattern.test('Invoice # 12345678')).toBe(false);
            expect(pattern.test('Phone 3031234567')).toBe(false);
            expect(pattern.test('QTY: 12345678')).toBe(false);
        });
        
        it('should capture the exact tracking digits', () => {
            const pattern = new RegExp(TRACKING_PATTERNS.oakharbor.source, 'i');
            
            const match1 = 'Oak Harbor 12345678'.match(pattern);
            expect(match1).not.toBeNull();
            expect(match1![1]).toBe('12345678');

            const match2 = 'Oak Harbor Freight Lines: PRO# 9876543210'.match(pattern);
            expect(match2).not.toBeNull();
            expect(match2![1]).toBe('9876543210');

            const match3 = 'OAKH PRO 1701387444'.match(pattern);
            expect(match3).not.toBeNull();
            expect(match3![1]).toBe('1701387444');
        });
    });

    describe('trk pattern (TRK#/TRACK# fallback)', () => {
        it('should match TRK# followed by a tracking number', () => {
            expect(TRACKING_PATTERNS.trk.test('TRK# 8051904063')).toBe(true);
        });

        it('should match TRK# without space (e.g. TRK#8051904063)', () => {
            expect(TRACKING_PATTERNS.trk.test('TRK#8051904063')).toBe(true);
        });

        it('should match TRACK# prefix', () => {
            expect(TRACKING_PATTERNS.trk.test('TRACK# ABC123456789')).toBe(true);
        });

        it('should match TRK: (colon separator)', () => {
            expect(TRACKING_PATTERNS.trk.test('TRK: XF1234567890')).toBe(true);
        });

        it('should match TRK with space only (no #)', () => {
            expect(TRACKING_PATTERNS.trk.test('TRK 123456789012345')).toBe(true);
        });

        it('should capture the tracking number in group 1', () => {
            const pattern = new RegExp(TRACKING_PATTERNS.trk.source, 'i');
            const m = 'TRK# 8051904063'.match(pattern);
            expect(m).not.toBeNull();
            expect(m![1]).toBe('8051904063');
        });

        it('should not match numbers shorter than 8 digits', () => {
            expect(TRACKING_PATTERNS.trk.test('TRK# 12345')).toBe(false);
        });

        it('should not match TRK when part of another word', () => {
            expect(TRACKING_PATTERNS.trk.test('intrk 12345678')).toBe(false);
        });
    });
});

// ──────────────────────────────────────────────────
// pageMentionsTrackingNumber (LTL proof-of-shipment guard)
// ──────────────────────────────────────────────────

describe('pageMentionsTrackingNumber', () => {
    // HERMIA(2026-08-20): ODFL renders tracking client-side. The server HTML is
    // page chrome whose notification-preferences block literally contains the
    // words "Out for Delivery" and "Delivered", so parseTrackingContent reported
    // Ferticell PO 125211's in-transit LTL shipment as DELIVERED. This guard is
    // what stops a JS shell from fabricating a delivery.
    const odflShellChrome =
        'Tracking Notifications Appointment Set/Confirmed Email On Off Text On Off ' +
        'Out for Delivery Email On Off Text On Off Returned to Dock Email On Off ' +
        'Delivered Email On Off Text On Off Email Address Required';

    it('rejects a JS-shell page that never rendered the PRO', () => {
        expect(pageMentionsTrackingNumber(odflShellChrome, '78088240060')).toBe(false);
    });

    it('accepts a page that renders the PRO verbatim', () => {
        expect(
            pageMentionsTrackingNumber(`PRO 78088240060 Delivered Aug 21, 2026`, '78088240060'),
        ).toBe(true);
    });

    it('accepts a PRO formatted with separators by the carrier', () => {
        expect(pageMentionsTrackingNumber('PRO 780-882-40060 In Transit', '78088240060')).toBe(true);
    });

    it('rejects an unusably short tracking number', () => {
        expect(pageMentionsTrackingNumber('12345 Delivered', '12345')).toBe(false);
    });
});
