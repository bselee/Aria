/**
 * @file    utils.ts
 * @purpose Shared intelligence utilities for tracking extraction and correlation.
 * @author  Aria (Antigravity)
 * @created 2026-03-19
 * @updated 2026-05-21
 * @deps    src/lib/carriers/tracking-service.ts
 */

import {
    TRACKING_PATTERNS as CENTRAL_TRACKING_PATTERNS,
    extractTrackingNumbers as extractTrackingNumbersCentral
} from "../carriers/tracking-service";

export const TRACKING_PATTERNS = CENTRAL_TRACKING_PATTERNS;

/**
 * Extracts tracking numbers from a string.
 * DECISION(2026-05-21): Proxied to central tracking-service implementation to eliminate duplication.
 */
export function extractTrackingNumbers(text: string): string[] {
    const found = extractTrackingNumbersCentral(text);
    return found.map(item => item.trackingNumber);
}
