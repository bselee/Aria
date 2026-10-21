/**
 * @file    src/cli/build-schedule-report.ts
 * @purpose On-demand forward build/shortfall report. Decoupled from the
 *          continuous purchasing recommendation (which is calendar-free by
 *          default). Run manually: `node --import tsx src/cli/build-schedule-report.ts [daysOut]`
 * @author  Hermia
 * @created 2026-10-06
 * @deps    src/lib/builds/build-risk.ts
 */
import { runBuildRiskAnalysis } from "../lib/builds/build-risk";
import { pathToFileURL } from "url";

async function main() {
    const daysOut = Number(process.argv[2] || 30);
    console.log(`\n=== Build schedule + raw-material shortfalls, next ${daysOut} days ===\n`);

    const report = await runBuildRiskAnalysis(daysOut);

    console.log(`Scheduled builds parsed: ${report.builds.length}`);
    for (const b of report.builds) {
        console.log(`  ${b.buildDate}  ${b.designation.padEnd(4)}  ${b.sku.padEnd(16)} x ${b.quantity}  (conf ${b.confidence})`);
    }

    if (report.unrecognizedSkus.length) {
        console.log(`\nUnrecognized / non-build events: ${report.unrecognizedSkus.length}`);
        for (const u of report.unrecognizedSkus) {
            console.log(`  ${u.sku.padEnd(16)} qty ${u.totalQty}  ${u.earliestDate}`);
        }
    }

    const shortfalls = [...report.components.entries()]
        .map(([sku, d]) => ({ sku, d, short: (d.totalRequiredQty || 0) - ((d.onHand ?? 0) + (d.onOrder ?? 0)) }))
        .filter(x => x.short > 0)
        .sort((a, b) => b.short - a.short);

    console.log(`\nRaw-material shortfalls (need > on-hand + on-order): ${shortfalls.length}`);
    if (!shortfalls.length) {
        console.log("  (none — current stock covers all scheduled builds)");
    }
    for (const x of shortfalls) {
        const d = x.d;
        console.log(
            `  ${x.sku.padEnd(18)} need ${(d.totalRequiredQty || 0).toFixed(0).padStart(8)}  onHand ${(d.onHand ?? 0).toFixed(0).padStart(8)}  onOrder ${(d.onOrder ?? 0).toFixed(0).padStart(8)}  short ${x.short.toFixed(0).padStart(8)}  [${d.riskLevel}]`,
        );
    }

    console.log(`\n${report.criticalCount} critical, ${report.warningCount} warning.`);
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isEntrypoint) {
    main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
}
