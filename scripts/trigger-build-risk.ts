/**
 * @file    trigger-build-risk.ts
 * @purpose One-shot guardrail: manually run build risk analysis when the
 *          scheduled cron was missed due to Supabase outage.
 * @usage   node --import tsx --env-file=.env.local scripts/trigger-build-risk.ts
 */

// Import using relative paths to avoid tsconfig path alias issues
import { runBuildRiskAnalysis } from "../src/lib/builds/build-risk";
import { saveBuildRiskSnapshot } from "../src/lib/builds/build-risk-logger";

async function main() {
    console.log("[guardrail] Manually triggering build-risk analysis (missed 8am cron due to Supabase outage)...");
    const start = Date.now();
    
    try {
        const results = await runBuildRiskAnalysis(30, (msg) => console.log(`  ${msg}`));
        console.log(`[guardrail] Analysis complete (${results.components ? Object.keys(results.components).length : 0} components) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
        
        await saveBuildRiskSnapshot(results);
        console.log("[guardrail] Build risk snapshot saved to Supabase.");
    } catch (err: any) {
        console.error("[guardrail] Build-risk analysis FAILED:", err.message);
        process.exit(1);
    }
    
    console.log(`[guardrail] Total elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
    process.exit(0);
}

main();