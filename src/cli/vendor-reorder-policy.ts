/**
 * @file    vendor-reorder-policy.ts
 * @purpose Read-only CLI to inspect vendor_reorder_policies rows by party id.
 *          Used to confirm seed values landed correctly and to spot-check a
 *          vendor's resolved policy before debugging a recommendation.
 *
 * Usage:
 *   node --import tsx src/cli/vendor-reorder-policy.ts 10918
 *   node --import tsx src/cli/vendor-reorder-policy.ts 10918 10219 10080
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import { loadVendorReorderPolicies } from "@/lib/purchasing/calibration";

async function main() {
    const ids = process.argv.slice(2);
    if (ids.length === 0) {
        console.error("Usage: node --import tsx src/cli/vendor-reorder-policy.ts <vendorPartyId> [...]");
        process.exit(1);
    }
    const policies = await loadVendorReorderPolicies(ids);
    for (const id of ids) {
        const policy = policies.get(id);
        if (!policy) {
            console.log(`${id}: no vendor reorder policy (uses system defaults)`);
            continue;
        }
        console.log(`${id}: ${policy.vendorName ?? "Unknown"}`);
        console.log(`  lead override: ${policy.leadTimeOverrideDays ?? "default"}d`);
        console.log(`  target cover:  ${policy.targetCoverDays ?? "default"}d`);
        console.log(`  MOQ mode:      ${policy.moqMode}`);
        console.log(`  overbuy review threshold: ${policy.overbuyReviewPct}% or $${policy.overbuyReviewDollars}`);
        if (policy.notes) console.log(`  notes: ${policy.notes}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
