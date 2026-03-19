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
    isFedExNumber,
    buildFollowUpEmail,
    TRACKING_PATTERNS,
} from './tracking-service';

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
});
