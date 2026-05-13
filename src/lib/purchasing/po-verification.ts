/**
 * @file    po-verification.ts
 * @purpose Shared types + helpers for the Draft PO → Commit → Send verification
 *          chain. Backend (Finale client + route handlers) and frontend
 *          (PurchasingPanel + ActivePurchasesPanel) both consume these shapes.
 */

/** Vendor-learned expected-delivery date attached to a freshly-created draft PO. */
export interface ExpectedDelivery {
    /** ISO YYYY-MM-DD */
    date: string;
    leadTimeDays: number;
    source: 'vendor_median' | 'sku_product' | 'default';
    /** Human-readable, e.g. "14d median · vendor history" */
    label: string;
}

/** Result of re-fetching a just-created draft PO and confirming items landed correctly. */
export interface DraftVerification {
    verified: boolean;
    statusId: string;
    lineCountExpected: number;
    lineCountActual: number;
    totalExpected: number;
    totalActual: number;
    /** Empty array means clean. Each entry is a short reason. */
    mismatches: string[];
}

/** Result of the commit + send flow. */
export interface CommitVerification {
    committed: boolean;
    /** Should be 'ORDER_LOCKED'. Anything else is a problem. */
    finalStatus: string;
    /** Did Finale's send action return success? */
    emailSent: boolean;
    /** Did a post-send re-fetch confirm `lastEmailedAt` updated? */
    emailVerified: boolean;
    lastEmailedAt: string | null;
    /** Empty when everything is clean. */
    issues: string[];
}

/**
 * Compute an expected delivery date from today + leadTimeDays. We add a small
 * 2-day weekend buffer so the date doesn't land on a Saturday/Sunday. UI
 * renders this as "Expected: YYYY-MM-DD".
 */
export function computeExpectedDelivery(input: {
    leadTimeDays: number;
    source: ExpectedDelivery['source'];
    label: string;
    now?: Date;
}): ExpectedDelivery {
    const now = input.now ?? new Date();
    const ms = now.getTime() + input.leadTimeDays * 86_400_000;
    let d = new Date(ms);
    const dow = d.getUTCDay();
    // 0 = Sun, 6 = Sat — bump to Mon
    if (dow === 0) d = new Date(d.getTime() + 86_400_000);
    if (dow === 6) d = new Date(d.getTime() + 2 * 86_400_000);
    return {
        date: d.toISOString().slice(0, 10),
        leadTimeDays: input.leadTimeDays,
        source: input.source,
        label: input.label,
    };
}
