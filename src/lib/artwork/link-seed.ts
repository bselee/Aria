/**
 * @file    src/lib/artwork/link-seed.ts
 * @purpose Curated artwork-sheet-SKU → Finale bag/label component-SKU pairs.
 *          The sheet's Sku column is a Finale SKU (FG level); these rows name
 *          the packaging component that consumes that art. Verified against
 *          the purchasing scan cache and finale_sku_cache on 2026-10-28.
 *          Pairs not listed here are resolved at sync time via Finale BOM
 *          discovery (getBillOfMaterials) or left unlinked and logged.
 * @author  Hermia
 * @created 2026-10-28
 * @deps    none
 * @env     none
 */

export interface ArtworkLinkSeed {
    /** Finale bag/label component SKU (e.g. BAV1LBBAG). */
    componentSku: string;
    /** Sheet Sku column value (Finale FG SKU, e.g. BAV103). */
    artworkSku: string;
    vendor: string;
    note?: string;
}

/**
 * Curated links. Both sides are Finale SKUs. Gaps (QUE103 kilo, GA/AG bottle
 * labels, CWP03/05/07, BAF01/02, BBV105, GnarBar04/09, EM labels, BASLight)
 * fall through to BOM discovery.
 */
export const ARTWORK_LINK_SEED: ArtworkLinkSeed[] = [
    // BuildAVeg printed bags (Colorful)
    { componentSku: 'BAV1LBBAG', artworkSku: 'BAV103', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'BAV5LBBAG', artworkSku: 'BAV102', vendor: 'Colorful Packaging Ltd' },
    // BuildABloom printed bags (Colorful)
    { componentSku: 'BBV101BAG', artworkSku: 'BBV101', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'BBV102BAG', artworkSku: 'BBV102', vendor: 'Colorful Packaging Ltd' },
    // BuildAFlower printed bags (Colorful)
    { componentSku: 'BAF00BAG', artworkSku: 'BAF00', vendor: 'Colorful Packaging Ltd' },
    // Craft Blend printed bags + label (Colorful / Axiom)
    { componentSku: 'CRAFT1BAG', artworkSku: 'Craft1', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'CRAFT10BAG', artworkSku: 'Craft10', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'CRAFT4L', artworkSku: 'Craft4', vendor: 'Axiom Print' },
    // GnarBar printed bags (Colorful)
    { componentSku: 'GnarBar01BAG', artworkSku: 'Gnarbar01', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'GnarBar02BAG', artworkSku: 'Gnarbar02', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'GnarBar06BAG', artworkSku: 'Gnarbar06', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'GnarBar07BAG', artworkSku: 'Gnarbar07', vendor: 'Colorful Packaging Ltd' },
    // Big 6 printed bags (Colorful)
    { componentSku: 'BIG6100GBAG', artworkSku: 'BASTM-102', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'BIG6300GBAG', artworkSku: 'BASTM-103', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'BIG61KGBAG', artworkSku: 'BASTM-104', vendor: 'Colorful Packaging Ltd' },
    // Que20: 2oz printed bag (Colorful), 8oz label (Axiom)
    { componentSku: 'QUE215BAG', artworkSku: 'QUE105', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'QUE214', artworkSku: 'QUE104', vendor: 'Axiom Print' },
    // Pumice labels (Axiom)
    { componentSku: 'PU104L', artworkSku: 'PU104', vendor: 'Axiom Print' },
    { componentSku: 'PU105L', artworkSku: 'PU105', vendor: 'Axiom Print' },
    // Kashi Gold labels (Axiom)
    { componentSku: 'KGD104L', artworkSku: 'KGD104', vendor: 'Axiom Print' },
    { componentSku: 'KGD103L', artworkSku: 'KGD103', vendor: 'Axiom Print' },
    // Coconut Water Powder printed bags (Colorful)
    { componentSku: 'CWP01BAG', artworkSku: 'CWP01', vendor: 'Colorful Packaging Ltd' },
    { componentSku: 'CWP02BAG', artworkSku: 'CWP02', vendor: 'Colorful Packaging Ltd' },
    // 3.0 soil poly bag (Colorful)
    { componentSku: '3.0BAGCP', artworkSku: 'LOSOLY3', vendor: 'Colorful Packaging Ltd', note: '25L poly bag for 1 Cu Ft 3.0 soil' },
];
