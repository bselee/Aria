/**
 * @file    tracking-service.test.ts
 * @purpose Unit tests for carrier tracking detection, URL generation, and status parsing.
 * @author  Will / Antigravity
 * @created 2026-03-19
 * @updated 2026-03-19
 */

import { describe, it, expect } from 'vitest';
import {
    detectCarrier,
    extractTrackingNumber,
    carrierUrl,
    parseTrackingContent,
    TRACKING_PATTERNS,
    detectLTLCarrier,
} from './tracking-service';

describe('detectCarrier', () => {
    it('should detect UPS tracking numbers', () => {
        expect(detectCarrier('1Z999AA10123456784')).toBe('ups');
    });
    it('should detect FedEx 12-digit numbers', () => {
        expect(detectCarrier('123456789012')).toBe('fedex');
    });
    it('should detect FedEx 15-digit numbers', () => {
        expect(detectCarrier('123456789012345')).toBe('fedex');
    });
    it('should detect USPS numbers', () => {
        expect(detectCarrier('94001234567890123456789012')).toBe('usps');
    });
    it('should return null for unrecognized format', () => {
        expect(detectCarrier('XXXX')).toBeNull();
    });
});

describe('carrierUrl', () => {
    it('should build UPS URL', () => {
        const url = carrierUrl('1Z999AA10123456784');
        expect(url).toContain('ups.com');
        expect(url).toContain('1Z999AA10123456784');
    });
    it('should build FedEx URL for numeric tracking', () => {
        const url = carrierUrl('123456789012');
        expect(url).toContain('fedex.com');
    });
    it('should handle LTL carrier:::number format', () => {
        const url = carrierUrl('Old Dominion:::1234567');
        expect(url).toContain('odfl.com');
        expect(url).toContain('1234567');
    });
    it('should fallback to parcelsapp for unknown LTL carrier', () => {
        const url = carrierUrl('Unknown Freight:::9999999');
        expect(url).toContain('parcelsapp.com');
    });
});

describe('parseTrackingContent', () => {
    it('should detect delivered status', () => {
        const result = parseTrackingContent('Package delivered on March 15, 2026');
        expect(result?.category).toBe('delivered');
    });
    it('should detect out for delivery', () => {
        const result = parseTrackingContent('Your package is out for delivery');
        expect(result?.category).toBe('out_for_delivery');
    });
    it('should detect in-transit with ETA', () => {
        const result = parseTrackingContent('Estimated delivery: March 20, 2026');
        expect(result?.category).toBe('in_transit');
        expect(result?.display).toContain('March 20');
    });
    it('should detect exception', () => {
        const result = parseTrackingContent('Delivery exception reported');
        expect(result?.category).toBe('exception');
    });
    it('should return null for unparseable content', () => {
        expect(parseTrackingContent('lorem ipsum dolor sit amet')).toBeNull();
    });
});

describe('detectLTLCarrier', () => {
    it('should detect Old Dominion', () => {
        expect(detectLTLCarrier('shipped via old dominion freight')).toBe('Old Dominion');
    });
    it('should detect XPO', () => {
        expect(detectLTLCarrier('XPO Logistics tracking')).toBe('XPO Logistics');
    });
    it('should return null for unknown carrier', () => {
        expect(detectLTLCarrier('random text about shipping')).toBeNull();
    });
});

describe('extractTrackingNumber', () => {
    it('should extract UPS tracking from text', () => {
        const result = extractTrackingNumber('Your tracking: 1Z999AA10123456784 has shipped');
        expect(result).toBe('1Z999AA10123456784');
    });
    it('should extract FedEx tracking from text', () => {
        const result = extractTrackingNumber('Tracking #: 123456789012');
        expect(result).toContain('123456789012');
    });
    it('should return null for text with no tracking number', () => {
        expect(extractTrackingNumber('No tracking info here')).toBeNull();
    });
});

describe('TRACKING_PATTERNS', () => {
    it('should export all required patterns', () => {
        expect(TRACKING_PATTERNS.ups).toBeInstanceOf(RegExp);
        expect(TRACKING_PATTERNS.fedex).toBeInstanceOf(RegExp);
        expect(TRACKING_PATTERNS.usps).toBeInstanceOf(RegExp);
        expect(TRACKING_PATTERNS.dhl).toBeInstanceOf(RegExp);
    });
});
