/**
 * @file    src/cli/bootstrap-memory.ts
 * @purpose Pre-embed all seeded memories with OpenAI and store in local SQLite.
 *          Run once before killing Pinecone. Replaces the export/import
 *          pipeline since embedding spaces are incompatible.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    dotenv, ../lib/intelligence/memory, ../lib/intelligence/vendor-memory
 *
 * Usage:
 *   node --import tsx src/cli/bootstrap-memory.ts
 *
 * Populates aria-local.db memory_vectors with:
 *   - 8 seeded memories (vendor patterns, preferences, processes)
 *   - 6 seeded vendor patterns (ULINE, Colorful, Axiom, AAA Cooper, default, Toyota)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { seedMemories, getMemoryStats } from "../lib/intelligence/memory";
import { seedKnownVendorPatterns } from "../lib/intelligence/vendor-memory";
import { countVectors } from "../lib/storage/memory-store";

async function main() {
    console.log("\n🧠 Memory Bootstrap\n");
    console.log("Embedding provider: OpenAI text-embedding-3-small (1024d)");
    console.log("Target: aria-local.db memory_vectors table\n");

    // Verify OpenAI key
    if (!process.env.OPENAI_API_KEY) {
        console.error("❌ OPENAI_API_KEY not set in .env.local");
        console.error("   Embedding requires OpenAI API key.");
        process.exit(1);
    }

    // Step 1: Seed general memories
    console.log("📝 Seeding general memories (preferences, vendor patterns, processes)...");
    try {
        await seedMemories();
    } catch (err: any) {
        console.error(`   ⚠️ seedMemories failed: ${err.message}`);
    }

    // Step 2: Seed vendor patterns
    console.log("\n📋 Seeding vendor document patterns...");
    try {
        await seedKnownVendorPatterns();
    } catch (err: any) {
        console.error(`   ⚠️ seedKnownVendorPatterns failed: ${err.message}`);
    }

    // Step 3: Verify
    console.log("\n📊 Verification:");
    const ns = ["aria-memory", "vendor-memory"];
    let total = 0;
    for (const n of ns) {
        const c = countVectors(n);
        console.log(`   ${n.padEnd(20)} ${c} vectors`);
        total += c;
    }
    console.log(`   ${"".padEnd(20)} ${total} total`);

    if (total > 0) {
        console.log(`\n✅ Memory bootstrapped successfully.`);
        console.log(`   Aria's local memory is ready. Pinecone can be disabled.`);
        console.log(`\n   Next steps:`);
        console.log(`   1. npm uninstall @pinecone-database/pinecone`);
        console.log(`   2. Remove PINECONE_API_KEY, PINECONE_INDEX, PINECONE_MEMORY_HOST from .env.local`);
        console.log(`   3. npm run ship:bot\n`);
    } else {
        console.error(`\n❌ Bootstrap failed — 0 vectors stored. Check embedding.ts for errors.\n`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error("\n❌ Bootstrap failed:", err);
    process.exit(1);
});
