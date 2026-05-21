/**
 * @file    resolver.ts
 * @purpose Resolves and correlates DASH artwork assets with Finale SKUs and spec dimensions.
 * @author  Will
 * @created 2026-05-20
 * @updated 2026-05-20
 * @deps    none
 */

export interface DashAsset {
    name: string;
    type: "pdf" | "png" | "ai" | "jpg" | "other";
    addedAt: string;
    url: string;
    skuMatch: string;
    sizeMatch?: string;
    side: "front" | "back" | "both" | "wrap" | "unknown";
    productName: string;
    isPrintReady: boolean;
}

// Seed index representing the exact physical files from the user's DASH folder screenshot.
const SEED_DASH_ASSETS: Omit<DashAsset, "skuMatch" | "sizeMatch" | "side" | "productName" | "isPrintReady">[] = [
    {
        name: "SAP02_Fornt Label_10082024.png",
        type: "png",
        addedAt: "2 hours ago",
        url: "https://buildasoil.dash.app/browse/all/SAP02_Fornt_Label_10082024.png",
    },
    {
        name: "SAP02_Back Label_10082024.png",
        type: "png",
        addedAt: "2 hours ago",
        url: "https://buildasoil.dash.app/browse/all/SAP02_Back_Label_10082024.png",
    },
    {
        name: "BAS Light_PrintReady_8.5x11.pdf",
        type: "pdf",
        addedAt: "27 days ago",
        url: "https://buildasoil.dash.app/browse/all/BAS_Light_PrintReady_8.5x11.pdf",
    },
    {
        name: "BuildASoil Potting Soil Recipe_8.5x11.pdf",
        type: "pdf",
        addedAt: "27 days ago",
        url: "https://buildasoil.dash.app/browse/all/BuildASoil_Potting_Soil_Recipe_8.5x11.pdf",
    },
    {
        name: "BAF02_CuFt_8.5x11.png",
        type: "png",
        addedAt: "1 month ago",
        url: "https://buildasoil.dash.app/browse/all/BAF02_CuFt_8.5x11.png",
    },
    {
        name: "BAF01_Half CuFt_Label_7.5x10.pdf",
        type: "pdf",
        addedAt: "1 month ago",
        url: "https://buildasoil.dash.app/browse/all/BAF01_Half_CuFt_Label_7.5x10.pdf",
    },
    {
        name: "BBL101_7.5x10_Print Ready.pdf",
        type: "pdf",
        addedAt: "4 months ago",
        url: "https://buildasoil.dash.app/browse/all/BBL101_7.5x10_Print_Ready.pdf",
    },
    {
        name: "AC111_Half Gallon_4.25w x 4.5.ai",
        type: "ai",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/AC111_Half_Gallon_4.25w_x_4.5.ai",
    },
    {
        name: "AC111_Half Gallon_4.25w x 4.5.pdf",
        type: "pdf",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/AC111_Half_Gallon_4.25w_x_4.5.pdf",
    },
    {
        name: "GnarBar07_6lbs_7x8.75_Label.pdf",
        type: "pdf",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/GnarBar07_6lbs_7x8.75_Label.pdf",
    },
    {
        name: "GnarBar07_6lbs_7x8.75_label.ai",
        type: "ai",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/GnarBar07_6lbs_7x8.75_label.ai",
    },
    {
        name: "GnarBar07_6lbs_7x8.75_Front.ai",
        type: "ai",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/GnarBar07_6lbs_7x8.75_Front.ai",
    },
    {
        name: "GnarBar07_6lbs_7x8.75_Front.pdf",
        type: "pdf",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/GnarBar07_6lbs_7x8.75_Front.pdf",
    },
    {
        name: "GnarBar06_2lbs_5x6_Label_Bag.ai",
        type: "ai",
        addedAt: "6 months ago",
        url: "https://buildasoil.dash.app/browse/all/GnarBar06_2lbs_5x6_Label_Bag.ai",
    },
];

/**
 * Parses a physical DASH asset file name to extract structural print metadata.
 *
 * @param   fileName - Raw physical filename of the DASH asset
 * @returns Parsed metadata segments
 */
export function parseDashFileName(fileName: string): {
    sku: string;
    productName: string;
    dimensions: string | undefined;
    side: "front" | "back" | "both" | "wrap" | "unknown";
    isPrintReady: boolean;
} {
    const base = fileName.substring(0, fileName.lastIndexOf(".")) || fileName;
    const lower = base.toLowerCase();

    // 1. Resolve SKU (First segment separated by underscores or hyphens)
    const parts = base.split(/[_-]/);
    const sku = parts[0] ? parts[0].trim().toUpperCase() : "UNKNOWN";

    // 2. Resolve Print Ready status
    const isPrintReady = lower.includes("printready") || lower.includes("print ready") || lower.includes("print_ready");

    // 3. Resolve Front/Back side
    let side: "front" | "back" | "both" | "wrap" | "unknown" = "unknown";
    if (lower.includes("front") || lower.includes("fornt")) {
        side = "front";
    } else if (lower.includes("back")) {
        side = "back";
    } else if (lower.includes("wrap")) {
        side = "wrap";
    } else if (lower.includes("both")) {
        side = "both";
    }

    // 4. Resolve Dimensions/Size (e.g. 8.5x11, 7.5x10, 4.25w x 4.5, 7x8.75, 5x6)
    let dimensions: string | undefined = undefined;
    const dimMatch = base.match(/(\d+(?:\.\d+)?[a-z]?\s*[x×]\s*\d+(?:\.\d+)?[a-z]?)/i);
    if (dimMatch) {
        dimensions = dimMatch[1].toLowerCase().replace(/\s+/g, "");
    }

    // 5. Resolve Product Name / Description segment
    let productName = base;
    if (parts.length > 1) {
        // Exclude first segment if it's the SKU
        const nameParts = parts[0].toUpperCase() === sku ? parts.slice(1) : parts;
        // Filter out dimensions and date/print ready flags to clean the name
        productName = nameParts
            .filter(part => {
                const p = part.toLowerCase();
                return (
                    !p.match(/^\d{8}$/) && // filter date patterns like 10082024
                    !p.match(/^(\d+(?:\.\d+)?x\d+(?:\.\d+)?|\d+(?:\.\d+)?w)$/) &&
                    !p.includes("printready") &&
                    !p.includes("print ready")
                );
            })
            .join(" ")
            .trim();
    }

    return {
        sku,
        productName: productName || sku,
        dimensions,
        side,
        isPrintReady,
    };
}

/**
 * Queries the DASH asset digital library for a specific SKU.
 *
 * @param   sku - The target Finale SKU to match against
 * @returns Array of matching DASH assets with fully parsed metadata
 */
export function resolveDashAssets(sku: string): DashAsset[] {
    if (!sku || typeof sku !== "string") return [];

    const targetSku = sku.trim().toUpperCase();

    return SEED_DASH_ASSETS.map(asset => {
        const parsed = parseDashFileName(asset.name);
        return {
            ...asset,
            skuMatch: parsed.sku,
            sizeMatch: parsed.dimensions,
            side: parsed.side,
            productName: parsed.productName,
            isPrintReady: parsed.isPrintReady,
        } as DashAsset;
    }).filter(asset => {
        // Match exact SKU or partial prefix match
        const lowerSku = asset.skuMatch.toLowerCase();
        const lowerTarget = targetSku.toLowerCase();
        return lowerSku === lowerTarget || lowerSku.startsWith(lowerTarget) || lowerTarget.startsWith(lowerSku);
    });
}

/**
 * Validates that physical asset dimensions are congruent with approved spec dimensions.
 *
 * @param   assetDim - Raw dimensions parsed from physical file (e.g. 7.5x10, 8.5x11)
 * @param   specDim  - Approved spec dimensions (e.g. 7.5" x 10", 8.5x11)
 * @returns Congruency status (true if matched, false if mismatch)
 */
export function isDimensionCongruent(assetDim: string | undefined, specDim: string | null | undefined): boolean {
    if (!assetDim || !specDim) return true; // Fail-safe: if missing dimension tags, allow manual verification

    const cleanAsset = assetDim.toLowerCase().replace(/[^0-9.x]/g, "");
    const cleanSpec = specDim.toLowerCase().replace(/[^0-9.x]/g, "").replace(/\s+/g, "");

    // Direct match check (e.g. "8.5x11" === "8.5x11")
    if (cleanAsset === cleanSpec) return true;

    // Coordinate invert match check (e.g. "11x8.5" vs "8.5x11" representing landscape/portrait variation)
    const specParts = cleanSpec.split("x");
    if (specParts.length === 2) {
        const invertedSpec = `${specParts[1]}x${specParts[0]}`;
        if (cleanAsset === invertedSpec) return true;
    }

    return false;
}
