#!/usr/bin/env node
/**
 * @file    src/cli/smoke-test-before-restart.ts
 * @purpose Pre-restart smoke test. Compiles + imports critical modules to
 *          catch syntax/transform errors BEFORE `pm2 restart aria-bot`.
 *          Exit 0 = safe to restart. Exit 1 = do NOT restart.
 *
 * @author  Hermia
 * @created 2026-07-09
 * @usage   node --import tsx src/cli/smoke-test-before-restart.ts
 *          (or: npx tsx src/cli/smoke-test-before-restart.ts)
 */

/**
 * Files most likely to be edited and break the bot.
 * These are the same modules checked by the boot health check,
 * but listed as file paths (not @/ aliases) for tsx import.
 */
const SMOKE_TEST_FILES = [
    "@/lib/intelligence/workers/ap-local-forwarder",
    "@/lib/intelligence/workers/ap-forwarder",
    "@/lib/intelligence/workers/ap-identifier",
    "@/lib/intelligence/ap-dedup",
    "@/lib/intelligence/ap-single-forward",
    "@/lib/intelligence/ap/vendor-router",
    "@/lib/storage/local-db",
    "@/lib/gmail/auth",
    "@/lib/supabase",
    "@/lib/finale/client",
    "@/lib/ops/module-health-check",
    "@/cron/runner",
    "@/cron/jobs",
    "@/cli/start-bot",
];

async function main(): Promise<void> {
    console.log("=== Aria Pre-Restart Smoke Test ===\n");
    const { smokeTestCompile } = await import("../lib/ops/module-health-check");

    const failures = await smokeTestCompile(SMOKE_TEST_FILES);

    if (failures.length === 0) {
        console.log(`\n✅ All ${SMOKE_TEST_FILES.length} modules compiled OK — safe to restart.`);
        process.exit(0);
    } else {
        console.error(`\n❌ ${failures.length} module(s) failed to compile:\n`);
        for (const f of failures) {
            console.error(`  ${f.path}: ${f.error.slice(0, 120)}`);
        }
        console.error(`\nDO NOT restart aria-bot — fix the errors above first.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Smoke test runner crashed:", err?.message ?? err);
    process.exit(1);
});
