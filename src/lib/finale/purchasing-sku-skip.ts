/**
 * @file    purchasing-sku-skip.ts
 * @purpose Skip Finale detail calls for label artwork SKUs that do not exist.
 *          getPurchasingIntelligence was calling /api/product for OAG*LABEL*
 *          rows, getting 404, and doing it again on every scan. Those calls
 *          blocked the bot event loop and starved the morning email screen.
 * @author  Hermia
 * @created 2026-09-23
 */

/**
 * Label artwork ids (OAG207LABELBACK, OAG104LABELFRONT, OAG109LABELFR) are
 * not reorderable products. Finale's reorder report lists them and the
 * product API 404s. Do not call Finale for them.
 *
 * @param sku  Finale product id from the reorder candidate list.
 * @returns    True when the id is label artwork and must be skipped.
 */
export function isMissingLabelArtworkSku(sku: string | null | undefined): boolean {
    if (!sku) return false;
    return /LABEL(?:BACK|FRONT|FR)?$/i.test(sku.trim());
}
