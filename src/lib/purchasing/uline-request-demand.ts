import fs from "fs";
import path from "path";

import { buildProductCatalog, type RawRequestsData } from "@/lib/purchases/assessor";
import { FuzzyMatcher } from "@/lib/scraping/fuzzy-matcher";
import type { UlineDemandItem } from "@/lib/purchasing/uline-flow";

function parseRequestQty(value: string | null | undefined): number {
    const numeric = Number(String(value ?? "").replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) return 1;
    return Math.max(1, Math.round(numeric));
}

export async function loadPendingUlineRequestDemand(): Promise<UlineDemandItem[]> {
    const requestsPath = path.resolve(process.cwd(), "purchase-requests.json");
    if (!fs.existsSync(requestsPath)) {
        return [];
    }

    const raw = JSON.parse(fs.readFileSync(requestsPath, "utf-8")) as RawRequestsData;
    const pending = (raw.requests || []).filter(request => request.status === "Pending");
    if (pending.length === 0) {
        return [];
    }

    const catalog = await buildProductCatalog();
    const matcher = new FuzzyMatcher(catalog.products);
    const matches: UlineDemandItem[] = [];

    for (const request of pending) {
        const match = matcher.match(request.details || "");
        if (!match) continue;
        if (!(match.product.vendor || "").toLowerCase().includes("uline")) continue;

        matches.push({
            sku: match.product.sku.trim().toUpperCase(),
            description: match.product.name || request.details,
            requiredQty: parseRequestQty(request.quantity),
            sources: ["request"],
        });
    }

    return matches;
}
