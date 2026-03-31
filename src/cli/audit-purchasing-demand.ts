import dotenv from "dotenv";
import path from "path";
import { pathToFileURL } from "url";
import { finaleClient, summarizePurchasingDemandAnomalies } from "../lib/finale/client";

const ENV_CANDIDATES = [
    ".env.local",
    "../.env.local",
    "../../.env.local",
];

function loadEnv() {
    for (const candidate of ENV_CANDIDATES) {
        const resolved = path.resolve(process.cwd(), candidate);
        const result = dotenv.config({ path: resolved });
        if (!result.error) return;
    }
}

function readFlag(argv: string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    return argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
    return argv.includes(name);
}

export async function runPurchasingDemandAudit(argv = process.argv.slice(2)) {
    loadEnv();

    const daysBack = Math.min(365, Math.max(30, parseInt(readFlag(argv, "--days-back") ?? "90", 10) || 90));
    const limit = Math.min(200, Math.max(1, parseInt(readFlag(argv, "--limit") ?? "25", 10) || 25));
    const vendorFilter = readFlag(argv, "--vendor")?.trim().toLowerCase();
    const skuFilter = readFlag(argv, "--sku")
        ?.split(",")
        .map(sku => sku.trim().toUpperCase())
        .filter(Boolean) ?? [];
    const json = hasFlag(argv, "--json");

    const groups = skuFilter.length > 0
        ? await finaleClient.getPurchasingIntelligenceForSkus(skuFilter, daysBack)
        : await finaleClient.getPurchasingIntelligence(daysBack);
    const filteredGroups = vendorFilter
        ? groups.filter(group => group.vendorName.toLowerCase().includes(vendorFilter))
        : groups;
    const anomalies = summarizePurchasingDemandAnomalies(filteredGroups);
    const top = anomalies.slice(0, limit);

    if (json) {
        console.log(JSON.stringify({
            daysBack,
            vendorFilter: vendorFilter ?? null,
            skuFilter: skuFilter.length > 0 ? skuFilter : null,
            groupsScanned: filteredGroups.length,
            anomalyCount: anomalies.length,
            anomalies: top,
        }, null, 2));
        return;
    }

    console.log(`Purchasing demand anomaly audit (${daysBack}d)`);
    if (vendorFilter) console.log(`Vendor filter: ${vendorFilter}`);
    if (skuFilter.length > 0) console.log(`SKU filter: ${skuFilter.join(", ")}`);
    console.log(`Groups scanned: ${filteredGroups.length}`);
    console.log(`Anomalies found: ${anomalies.length}`);

    if (top.length === 0) {
        console.log("No anomalous Finale demand signals detected.");
        return;
    }

    console.log("");
    for (const item of top) {
        console.log(
            [
                `${item.vendorName} :: ${item.productId}`,
                `${item.productName}`,
                `Finale ${item.rawDemandVelocity.toFixed(2)}/d vs trusted ${item.trustedDailyRate.toFixed(2)}/d`,
                `sales ${item.salesVelocity.toFixed(2)}/d`,
                `receipts ${item.purchaseVelocity.toFixed(2)}/d`,
                `consumption ${item.finaleConsumptionQty ?? 0}`,
                `Finale reorder ${item.finaleReorderQty ?? 0}`,
                `suggested ${item.suggestedQty}`,
                `ratio ${item.anomalyRatio.toFixed(1)}x`,
            ].join(" | "),
        );
    }
}

const entryArg = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;

if (entryArg === import.meta.url) {
    runPurchasingDemandAudit().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
