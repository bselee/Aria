/**
 * @file    src/cli/export-pinecone-data.ts
 * @purpose Export all Pinecone vectors to JSON files for local SQLite import.
 *          One JSON per namespace. Run once before killing Pinecone.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @pinecone-database/pinecone, dotenv
 * @env     PINECONE_API_KEY, PINECONE_INDEX, PINECONE_MEMORY_HOST
 *
 * Usage:
 *   node --import tsx src/cli/export-pinecone-data.ts
 *
 * Outputs JSON files to ./scratch/pinecone-export/<namespace>.json
 * Each file contains: { vectors: [{id, embedding[], metadata, namespace}] }
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { Pinecone } from '@pinecone-database/pinecone';
import * as fs from 'fs';
import * as path from 'path';

const NAMESPACES = ['aria-memory', 'vendor-memory', 'insight-index', 'session-archive'];
const OUTPUT_DIR = path.join(process.cwd(), 'scratch', 'pinecone-export');

async function exportNamespace(
    index: any,
    namespace: string,
): Promise<{ id: string; values: number[]; metadata: Record<string, unknown> }[]> {
    const ns = index.namespace(namespace);
    const allVectors: Array<{ id: string; values: number[]; metadata: Record<string, unknown> }> = [];

    // Pinecone list() returns an async iterator of ID batches
    // We fetch IDs first, then fetch vectors in batches of 100
    console.log(`  Listing vector IDs in namespace '${namespace}'...`);

    let totalIds = 0;
    const idBatches: string[][] = [];
    let currentBatch: string[] = [];

    try {
        const listResponse = ns.list();

        // list() returns { pagination: { next: string }, vectors: string[] }
        // or in newer SDK: async iterable of ID string arrays
        let pagination = listResponse;

        // Handle both SDK versions
        if (typeof pagination[Symbol.asyncIterator] === 'function') {
            // Async iterator version
            for await (const ids of pagination) {
                if (Array.isArray(ids)) {
                    for (const id of ids) {
                        currentBatch.push(id);
                        totalIds++;
                        if (currentBatch.length >= 100) {
                            idBatches.push([...currentBatch]);
                            currentBatch = [];
                        }
                    }
                }
            }
        } else {
            // Paginated version
            let nextCursor: string | undefined;
            do {
                const result = nextCursor ? await ns.listPaginated(nextCursor) : await ns.list();
                const ids = result?.ids || result?.vectors || [];
                for (const id of ids) {
                    currentBatch.push(id as string);
                    totalIds++;
                    if (currentBatch.length >= 100) {
                        idBatches.push([...currentBatch]);
                        currentBatch = [];
                    }
                }
                nextCursor = result?.pagination?.next;
            } while (nextCursor);
        }

        if (currentBatch.length > 0) {
            idBatches.push(currentBatch);
        }
    } catch (err: any) {
        // Fallback: try listing with a prefix of empty string
        console.warn(`  list() failed (${err.message}), trying listPaginated fallback...`);
        try {
            const result = await ns.listPaginated('', { limit: 1000 });
            const ids = result?.ids || [];
            for (const id of ids) {
                currentBatch.push(id as string);
                totalIds++;
                if (currentBatch.length >= 100) {
                    idBatches.push([...currentBatch]);
                    currentBatch = [];
                }
            }
            if (currentBatch.length > 0) idBatches.push(currentBatch);
        } catch (err2: any) {
            console.error(`  listPaginated also failed: ${err2.message}`);
            console.warn(`  Trying stat + fetch-all approach...`);
            // Last resort: stat to get count, then try to fetch by known IDs
            const stats = await index.describeIndexStats();
            const nsStats = stats?.namespaces?.[namespace];
            totalIds = nsStats?.recordCount || nsStats?.vectorCount || 0;
            console.warn(`  Namespace has ~${totalIds} vectors but can't list IDs.`);
            console.warn(`  You'll need to import them manually or add known IDs.`);
            return [];
        }
    }

    console.log(`  Found ${totalIds} vector IDs. Fetching in ${idBatches.length} batches...`);

    // Fetch vectors in batches
    for (let i = 0; i < idBatches.length; i++) {
        const batch = idBatches[i];
        if (batch.length === 0) continue;

        try {
            const result = await ns.fetch(batch);
            const records = result?.records || {};

            for (const [id, record] of Object.entries(records)) {
                const r = record as any;
                if (r.values && Array.isArray(r.values)) {
                    allVectors.push({
                        id,
                        values: r.values,
                        metadata: r.metadata || {},
                    });
                }
            }

            if ((i + 1) % 10 === 0 || i === idBatches.length - 1) {
                process.stdout.write(`  Batch ${i + 1}/${idBatches.length} — ${allVectors.length} vectors fetched\r`);
            }
        } catch (err: any) {
            console.warn(`\n  Batch ${i + 1} fetch failed: ${err.message}`);
            // Retry individual IDs
            for (const id of batch) {
                try {
                    const result = await ns.fetch([id]);
                    const records = result?.records || {};
                    const r = records[id] as any;
                    if (r && r.values) {
                        allVectors.push({ id, values: r.values, metadata: r.metadata || {} });
                    }
                } catch { /* skip individual failures */ }
            }
        }
    }

    console.log(`\n  Fetched ${allVectors.length}/${totalIds} vectors from '${namespace}'.`);
    return allVectors;
}

async function main() {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
        console.error('❌ PINECONE_API_KEY not set in .env.local');
        process.exit(1);
    }

    const indexName = process.env.PINECONE_INDEX || 'gravity-memory';
    const indexHost = process.env.PINECONE_MEMORY_HOST;

    console.log(`\n🌲 Pinecone Export`);
    console.log(`   Index: ${indexName}`);
    console.log(`   Host: ${indexHost || '(control plane)'}`);
    console.log(`   Namespaces: ${NAMESPACES.join(', ')}\n`);

    const pc = new Pinecone({ apiKey });
    const index = indexHost ? pc.index(indexName, indexHost) : pc.index(indexName);

    // Create output directory
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const summary: Record<string, number> = {};

    for (const ns of NAMESPACES) {
        console.log(`\n📦 Exporting namespace: ${ns}`);
        const vectors = await exportNamespace(index, ns);

        if (vectors.length > 0) {
            const outputPath = path.join(OUTPUT_DIR, `${ns}.json`);
            const exportData = {
                exportedAt: new Date().toISOString(),
                namespace: ns,
                indexName,
                vectorCount: vectors.length,
                embeddingDimensions: vectors[0]?.values?.length || 0,
                vectors: vectors.map(v => ({
                    id: v.id,
                    embedding: v.values,
                    metadata: v.metadata,
                })),
            };

            fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
            console.log(`   ✅ Written to ${outputPath} (${vectors.length} vectors, ${vectors[0]?.values?.length}d)`);
            summary[ns] = vectors.length;
        } else {
            console.log(`   ⚠️ No vectors exported for '${ns}'.`);
            summary[ns] = 0;
        }
    }

    console.log(`\n\n📊 Export Summary:`);
    console.log(`   ${'─'.repeat(40)}`);
    let total = 0;
    for (const [ns, count] of Object.entries(summary)) {
        console.log(`   ${ns.padEnd(20)} ${count} vectors`);
        total += count;
    }
    console.log(`   ${'─'.repeat(40)}`);
    console.log(`   ${'TOTAL'.padEnd(20)} ${total} vectors`);
    console.log(`\n📁 Output: ${OUTPUT_DIR}/`);
    console.log(`\nNext step: node --import tsx src/cli/import-memory-vectors.ts\n`);
}

main().catch(err => {
    console.error('❌ Export failed:', err);
    process.exit(1);
});
