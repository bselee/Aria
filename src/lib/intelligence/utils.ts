/**
 * @file    utils.ts
 * @purpose Shared intelligence utilities for tracking extraction and correlation.
 */

export const TRACKING_PATTERNS = {
    ups: /1Z[0-9A-Z]{16}/i,
    fedex: /\b\d{12,15}\b/i,
    usps: /\b94\d{20}\b/i,
    generic: /\b(tracking|track|carrier|waybill)\s*[#:]?\s*([0-9A-Z]{10,25})\b/i
};

/**
 * Extracts tracking numbers from a string.
 */
export function extractTrackingNumbers(text: string): string[] {
    const trackingNumbers: string[] = [];
    for (const [carrier, regex] of Object.entries(TRACKING_PATTERNS)) {
        const matches = text.match(new RegExp(regex, 'gi'));
        if (matches) {
            for (const match of matches) {
                // Filter out labels but keep the numbers
                let clean = match;
                if (carrier === 'generic') {
                    const numberOnly = match.match(/[0-9A-Z]{10,25}/i);
                    if (numberOnly) clean = numberOnly[0];
                }
                if (!trackingNumbers.includes(clean)) {
                    trackingNumbers.push(clean);
                }
            }
        }
    }
    return trackingNumbers;
}
