/**
 * @file    src/lib/dash/asset-index.ts
 * @purpose Full asset index of Dash, cross-referenced against known label/bag
 *          SKUs using Dash's folder structure. Each product has its own folder
 *          (e.g. "GnarBar06 - Label Front & Back - 2 lb"). The folder name
 *          IS the correlation — no filename parsing needed.
 *
 *          v2 (2026-06-22): Rewritten to use folder-based matching instead
 *          of filename parsing. Handles 9002 prefixes, spaces, and naming
 *          inconsistencies automatically because we match by folder, not filename.
 *
 * @author  Hermia
 * @created 2026-06-22
 * @deps    src/lib/dash/client.ts
 */

import { type DashAsset, parseDashFilename } from './client';

const DASH_API_BASE = 'https://api-v2.dash.app';
const FOLDER_FIELD_ID = '3d1b8c72-a4eb-4ce2-90ed-640753ddcb91';

export interface ArtworkRegistryEntry {
    finaleSkus: string[];
    productName: string;
    assetType: 'label' | 'bag' | 'other';
    vendor: string;
    axiomJobName?: string;
    /** Dash folder name (the folder IS the correlation) */
    dashFolder?: string;
    /** Assets found in this SKU's folder */
    dashAssets: DashFolderAsset[];
    hasPrintReady: boolean;
    status: 'matched' | 'partial' | 'missing' | 'unverified';
    lastVerified?: string;
}

export interface DashFolderAsset {
    id: string;
    filename: string;
    fileType: string;
    isPrintReady: boolean;
    dateLastModified: string;
}

// ── Master registry — maps Finale SKU → expected Dash folder pattern ──────────
// The folderPattern is matched against actual Dash folder names (case-insensitive).
// A match means "this folder contains the art for this SKU."

interface SkuFolderMapping {
    finaleSkus: string[];
    productName: string;
    assetType: 'label' | 'bag' | 'other';
    vendor: string;
    axiomJobName?: string;
    /** Substring to match against Dash folder names (e.g. "GnarBar06" matches "GnarBar06 - Label Front & Back - 2 lb") */
    folderPattern: string;
}

const SKU_FOLDER_MAP: SkuFolderMapping[] = [
    // ── GnarBar Labels ───────────────────────────────────────────────────
    { finaleSkus: ['GNS11', 'GNS21'], productName: 'GnarBar-Whole 2lb', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GNS11_12', folderPattern: 'GnarBar01' },
    { finaleSkus: ['GNS12', 'GNS22'], productName: 'GnarBar-Whole 6lb', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GNAR BAR 6 lbs', folderPattern: 'GnarBar02' },
    { finaleSkus: ['GNS16', 'GNS06'], productName: 'GnarBar-Milled 2lb', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GnarBar062lbs', folderPattern: 'GnarBar06' },
    { finaleSkus: ['GNS17', 'GNS07'], productName: 'GnarBar-Milled 6lb', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GnarBar07Milled', folderPattern: 'GnarBar07' },

    // ── Organics Alive Labels ────────────────────────────────────────────
    { finaleSkus: ['OAG104LABELFR', 'OAG104LABELBK'], productName: 'FCB Castor Bean 1gal', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'OAG104FRBK', folderPattern: 'OAG104_FCB' },
    { finaleSkus: ['OAG207LABELFR', 'OAG207LABELBK'], productName: 'V-N 10-2-2 Veg 25lb', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'OAG207FRBK', folderPattern: 'OAG207' },
    { finaleSkus: ['OAG211LABELFR', 'OAG211LABELBK'], productName: 'V-TR 4-5-5 Trans 25lb', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'OAG211FRBK', folderPattern: 'OAG211' },
    { finaleSkus: ['OAG110LABELFR', 'OAG110LABELBK'], productName: 'VCal 1gal', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'VCal OA Gallon Labels', folderPattern: 'OAG110_VCal' },
    { finaleSkus: ['OAG109LABELFR', 'OAG109LABELBK'], productName: 'VCal 1pint', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'VCal OA Pint Label', folderPattern: 'OAG109_VCal' },

    // ── Single Labels ────────────────────────────────────────────────────
    { finaleSkus: ['BBL101'], productName: 'BuildASoil Big Label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'BBL101', folderPattern: 'BBL101' },
    { finaleSkus: ['BABL101'], productName: 'BuildASoil Big-ish Label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'BABL101', folderPattern: 'BABL101' },
    { finaleSkus: ['DOM101'], productName: 'Domain product label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'DOM101', folderPattern: 'DOM101' },
    { finaleSkus: ['GBB08'], productName: 'Gnar Bud Butter v8', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GBB08', folderPattern: 'GBB08' },
    { finaleSkus: ['GBB07'], productName: 'Gnar Bud Butter v7', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GBB07', folderPattern: 'GBB07' },
    { finaleSkus: ['BAF00LABEL'], productName: 'BAF00 product label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'BAF00LABEL', folderPattern: 'BAF00' },
    { finaleSkus: ['BAF1G'], productName: 'BAF 1gal label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'BAF1G', folderPattern: 'BAF1G' },
    { finaleSkus: ['KGD104'], productName: 'KGD product label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'KGD104', folderPattern: 'KGD104' },
    { finaleSkus: ['GA105'], productName: 'GA product label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'GA105', folderPattern: 'GA105' },
    { finaleSkus: ['PU105L'], productName: 'Pumice Quart label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'PU105L', folderPattern: 'PU105' },
    { finaleSkus: ['AG111'], productName: 'AG product label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'AG111', folderPattern: 'AG111' },
    { finaleSkus: ['FCB1G'], productName: 'FCB 1gal label', assetType: 'label', vendor: 'Axiom Print', axiomJobName: 'FCB1G', folderPattern: 'FCB' },

    // ── High-volume Labels ───────────────────────────────────────────────
    { finaleSkus: ['CRAFT4'], productName: 'Craft Blend 4lb', assetType: 'label', vendor: 'Axiom Print', folderPattern: 'Craft4 - Label - 44' },
    { finaleSkus: ['CRAFT1'], productName: 'Craft Blend 1 (small)', assetType: 'label', vendor: 'Axiom Print', folderPattern: 'Craft1' },
    { finaleSkus: ['CRAFT10'], productName: 'Craft Blend 10lb', assetType: 'label', vendor: 'Axiom Print', folderPattern: 'Craft10' },
    { finaleSkus: ['CRAFT44'], productName: 'Craft Blend 44lb', assetType: 'label', vendor: 'Axiom Print', folderPattern: 'Craft 44' },

    // ── Bags ─────────────────────────────────────────────────────────────
    { finaleSkus: ['BAV102'], productName: 'BuildAVeg 5lb (alt)', assetType: 'bag', vendor: 'Colorful Packaging', folderPattern: 'BAV102' },
    { finaleSkus: ['BAV103'], productName: 'BuildAVeg 1lb', assetType: 'bag', vendor: 'Colorful Packaging', folderPattern: 'BAV103' },
    { finaleSkus: ['BAF02'], productName: 'B.A.F. 3.0 CuFt', assetType: 'bag', vendor: 'Colorful Packaging', folderPattern: 'BAF02' },
    { finaleSkus: ['QUE105'], productName: 'QUE 2oz', assetType: 'bag', vendor: 'Colorful Packaging', folderPattern: 'QUE105' },
    { finaleSkus: ['WP101'], productName: 'Worm Castings 2gal', assetType: 'bag', vendor: 'Colorful Packaging', folderPattern: 'WP101' },
];

/**
 * Fetch all Dash folders and their assets.
 */
async function fetchDashFolders(token: string): Promise<Map<string, { id: string; assets: DashFolderAsset[] }>> {
    // Step 1: Fetch all assets with their folder metadata
    const allAssets: Array<{ id: string; filename: string; fileType: string; dateLastModified: string; folderIds: string[]; isPrintReady: boolean }> = [];
    let from = 0;
    const pageSize = 200;

    while (true) {
        const resp = await fetch(`${DASH_API_BASE}/asset-searches`, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from, pageSize,
                criterion: { type: 'MATCH_ALL' },
                sorts: [],
            }),
        });
        const data = await resp.json();
        if (!data.results || data.results.length === 0) break;

        for (const wrapper of data.results) {
            const item = wrapper.result || wrapper;
            const file = item.currentAssetFile || item.currentFile || {};
            const filename = file.filename || item.filename || '';
            const fileType = file.fileType || item.fileType || '';
            const parsed = parseDashFilename(filename);
            allAssets.push({
                id: item.id,
                filename,
                fileType,
                dateLastModified: item.dateLastModified || '',
                folderIds: item.metadata?.values?.[FOLDER_FIELD_ID] || [],
                isPrintReady: parsed.isPrintReady || false,
            });
        }
        from += pageSize;
    }

    // Step 2: Collect all unique folder IDs
    const folderIdSet = new Set<string>();
    for (const a of allAssets) {
        for (const fid of a.folderIds) folderIdSet.add(fid);
    }

    // Step 3: Resolve folder names
    const folderNames = new Map<string, string>();
    for (const fid of folderIdSet) {
        try {
            const resp = await fetch(`${DASH_API_BASE}/field-options/${fid}`, {
                headers: { 'Authorization': 'Bearer ' + token },
            });
            if (resp.ok) {
                const data = await resp.json();
                const fo = data.result || data;
                if (fo.value) folderNames.set(fid, fo.value);
            }
        } catch { /* skip unresolvable */ }
    }

    // Step 4: Group assets by folder name
    const folders = new Map<string, { id: string; assets: DashFolderAsset[] }>();
    for (const a of allAssets) {
        for (const fid of a.folderIds) {
            const name = folderNames.get(fid);
            if (!name) continue;
            if (!folders.has(name)) {
                folders.set(name, { id: fid, assets: [] });
            }
            folders.get(name)!.assets.push({
                id: a.id,
                filename: a.filename,
                fileType: a.fileType,
                isPrintReady: a.isPrintReady,
                dateLastModified: a.dateLastModified,
            });
        }
    }

    // Also track assets with no folder
    const noFolder = allAssets.filter(a => a.folderIds.length === 0);
    if (noFolder.length > 0) {
        folders.set('_NO_FOLDER', { id: '', assets: noFolder.map(a => ({
            id: a.id, filename: a.filename, fileType: a.fileType,
            isPrintReady: a.isPrintReady, dateLastModified: a.dateLastModified,
        })) });
    }

    return folders;
}

/**
 * Build the full Dash asset index using folder-based correlation.
 */
export async function buildAssetIndex(
    token: string,
): Promise<{
    registry: ArtworkRegistryEntry[];
    missingFromDash: string[];
    allFolders: Map<string, { id: string; assets: DashFolderAsset[] }>;
    totalAssets: number;
}> {
    const folders = await fetchDashFolders(token);
    const totalAssets = Array.from(folders.values()).reduce((sum, f) => sum + f.assets.length, 0);

    const registry: ArtworkRegistryEntry[] = SKU_FOLDER_MAP.map(mapping => {
        const pattern = mapping.folderPattern.toLowerCase();

        // Find the folder that matches this SKU
        let matchedFolder: string | undefined;
        let matchedAssets: DashFolderAsset[] = [];

        for (const [folderName, folder] of folders) {
            if (folderName.toLowerCase().includes(pattern)) {
                matchedFolder = folderName;
                matchedAssets = folder.assets;
                break;
            }
        }

        const printReady = matchedAssets.filter(a => a.isPrintReady);
        const hasPrintReady = printReady.length > 0;

        let status: 'matched' | 'partial' | 'missing' | 'unverified' = 'missing';
        if (hasPrintReady) {
            status = 'matched';
        } else if (matchedAssets.length > 0) {
            status = 'partial';
        }

        return {
            finaleSkus: mapping.finaleSkus,
            productName: mapping.productName,
            assetType: mapping.assetType,
            vendor: mapping.vendor,
            axiomJobName: mapping.axiomJobName,
            dashFolder: matchedFolder,
            dashAssets: matchedAssets,
            hasPrintReady,
            status,
            lastVerified: new Date().toISOString(),
        };
    });

    const missingFromDash = registry
        .filter(e => e.status === 'missing')
        .map(e => e.finaleSkus[0]);

    return { registry, missingFromDash, allFolders: folders, totalAssets };
}

/**
 * Generate a human-readable correlation report.
 */
export function formatCorrelationReport(index: {
    registry: ArtworkRegistryEntry[];
    missingFromDash: string[];
    allFolders: Map<string, { id: string; assets: DashFolderAsset[] }>;
    totalAssets: number;
}): string {
    const lines: string[] = [];

    lines.push('╔══════════════════════════════════════════════════════════════╗');
    lines.push('║          ARTWORK-TO-SKU CORRELATION REPORT                  ║');
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    lines.push('');
    lines.push(`Total assets in Dash: ${index.totalAssets}`);
    lines.push(`Total folders: ${index.allFolders.size}`);
    lines.push(`Known label/bag SKUs in registry: ${index.registry.length}`);
    lines.push('');

    // Matched
    const matched = index.registry.filter(e => e.status === 'matched');
    if (matched.length > 0) {
        lines.push('── MATCHED ──────────────────────────────────────────────────');
        for (const entry of matched) {
            const skus = entry.finaleSkus.join(' + ');
            lines.push(`  ✓ ${skus.padEnd(20)} ${entry.productName}`);
            if (entry.dashFolder) {
                lines.push(`    Folder: ${entry.dashFolder}`);
                const pr = entry.dashAssets.filter(a => a.isPrintReady);
                lines.push(`    Files: ${pr.length} print-ready, ${entry.dashAssets.length} total`);
                for (const a of pr.slice(0, 2)) {
                    lines.push(`    · ${a.filename.substring(0, 60)}`);
                }
                if (pr.length > 2) lines.push(`    · ... and ${pr.length - 2} more`);
            }
        }
        lines.push('');
    }

    // Partial
    const partial = index.registry.filter(e => e.status === 'partial');
    if (partial.length > 0) {
        lines.push('── PARTIAL ──────────────────────────────────────────────────');
        for (const entry of partial) {
            const skus = entry.finaleSkus.join(' + ');
            lines.push(`  ⚠ ${skus.padEnd(20)} ${entry.productName}`);
            if (entry.dashFolder) {
                lines.push(`    Folder: ${entry.dashFolder}`);
                lines.push(`    Files: ${entry.dashAssets.length} total (none print-ready)`);
                for (const a of entry.dashAssets.slice(0, 2)) {
                    lines.push(`    · ${a.filename.substring(0, 60)}`);
                }
            }
        }
        lines.push('');
    }

    // Missing
    if (index.missingFromDash.length > 0) {
        lines.push('── MISSING FROM DASH ────────────────────────────────────────');
        for (const sku of index.missingFromDash) {
            const entry = index.registry.find(e => e.finaleSkus[0] === sku);
            if (entry) {
                lines.push(`  ✗ ${sku.padEnd(20)} ${entry.productName}`);
                if (entry.axiomJobName) lines.push(`    Axiom job: ${entry.axiomJobName}`);
            }
        }
        lines.push('');
    }

    // Interesting folders (product-related, not misc)
    lines.push('── PRODUCT FOLDERS IN DASH ──────────────────────────────────');
    const productKeywords = ['label', 'bag', 'printed', 'gnarbar', 'craft', 'baf', 'pu',
        'que', 'wp', 'kgd', 'bbl', 'oag', 'cwp', 'bav', 'bbv', 'bastm', 'dls', 'sap',
        'ga1', 'ag1', 'ocb', 'losoly', 'basem5', 'baslight', 'hss', 'prma', 'clvr', 'atf'];
    
    const productFolders: string[] = [];
    for (const [name, folder] of index.allFolders) {
        if (name === '_NO_FOLDER') continue;
        const low = name.toLowerCase();
        if (productKeywords.some(k => low.includes(k))) {
            const pr = folder.assets.filter(a => a.isPrintReady).length;
            productFolders.push(`  ${name} (${folder.assets.length} files, ${pr} print-ready)`);
        }
    }
    productFolders.sort().forEach(l => lines.push(l));
    lines.push('');

    // No-folder assets summary
    const noFolder = index.allFolders.get('_NO_FOLDER');
    if (noFolder && noFolder.assets.length > 0) {
        lines.push(`Note: ${noFolder.assets.length} assets are not in any folder.`);
        lines.push('');
    }

    return lines.join('\n');
}
