/** Run the build-risk analysis manually and persist a fresh snapshot.
 *  node --import tsx src/cli/trigger-build-risk.ts
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { runBuildRiskAnalysis } from "@/lib/builds/build-risk";
import { saveBuildRiskSnapshot } from "@/lib/builds/build-risk-logger";

async function main() {
    console.log("Running build-risk analysis…");
    const results = await runBuildRiskAnalysis();
    console.log(`Saving snapshot (components=${Object.keys(results.components ?? {}).length}, builds=${results.builds?.length ?? 0})…`);
    await saveBuildRiskSnapshot(results);
    console.log("✅ snapshot saved");
    process.exit(0);
}
main().catch(e => { console.error("err:", e?.message ?? e); process.exit(1); });
