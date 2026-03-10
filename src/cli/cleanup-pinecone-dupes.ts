/**
 * @file    cleanup-pinecone-dupes.ts
 * @purpose One-time cleanup: remove duplicate seed records from aria-memory
 *          namespace and optionally flush orphaned default namespace records.
 * @author  Will / Antigravity
 * @created 2026-03-09
 * @updated 2026-03-09
 * @deps    @pinecone-database/pinecone, dotenv
 * @env     PINECONE_API_KEY, PINECONE_INDEX, PINECONE_MEMORY_HOST
 */

import { Pinecone } from '@pinecone-database/pinecone';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function cleanup() {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) {
        console.error('❌ PINECONE_API_KEY missing');
        return;
    }

    const pc = new Pinecone({ apiKey });
    const indexName = process.env.PINECONE_INDEX || 'gravity-memory';
    const indexHost = process.env.PINECONE_MEMORY_HOST;
    const index = indexHost ? pc.index(indexName, indexHost) : pc.index(indexName);

    // ── 1. Clean duplicates in aria-memory namespace ──────
    console.log('\n🧹 Step 1: Cleaning duplicate seeds in aria-memory...');
    const ariaMemory = index.namespace('aria-memory');

    // List all vectors in batches 
    let allIds: string[] = [];
    let paginationToken: string | undefined;

    do {
        const opts: any = { limit: 100 };
        if (paginationToken) opts.paginationToken = paginationToken;
        const result = await ariaMemory.listPaginated(opts);
        const ids = (result.vectors || []).map((v: any) => v.id);
        allIds.push(...ids);
        paginationToken = result.pagination?.next;
    } while (paginationToken);

    console.log(`  Found ${allIds.length} total vectors in aria-memory`);

    // Identify seed duplicates: pattern is {category}-{timestamp}-{random}
    // Keep only the newest of each content group. We'll fetch metadata to identify dupes.
    const fetchBatchSize = 100;
    const duplicateIds: string[] = [];

    // Group by content fingerprint
    const contentGroups = new Map<string, { id: string; storedAt: string }[]>();

    for (let i = 0; i < allIds.length; i += fetchBatchSize) {
        const batch = allIds.slice(i, i + fetchBatchSize);
        const result = await ariaMemory.fetch(batch);

        for (const [id, record] of Object.entries(result.records || {})) {
            if (!record?.metadata) continue;
            const meta = record.metadata as Record<string, any>;
            const content = (meta.content as string) || '';
            // Use first 80 chars of content as group key
            const key = `${meta.category}::${content.slice(0, 80)}`;

            if (!contentGroups.has(key)) contentGroups.set(key, []);
            contentGroups.get(key)!.push({
                id,
                storedAt: (meta.stored_at as string) || '',
            });
        }
    }

    // For each group with > 1 record, keep the newest, mark the rest for deletion
    for (const [key, records] of contentGroups) {
        if (records.length <= 1) continue;

        // Sort by stored_at descending, keep the first (newest)
        records.sort((a, b) => b.storedAt.localeCompare(a.storedAt));
        const dupes = records.slice(1).map(r => r.id);
        duplicateIds.push(...dupes);
        console.log(`  Group "${key.slice(0, 60)}..." — ${records.length} records, deleting ${dupes.length} dupes`);
    }

    if (duplicateIds.length > 0) {
        // Delete in batches of 100
        for (let i = 0; i < duplicateIds.length; i += 100) {
            const batch = duplicateIds.slice(i, i + 100);
            await ariaMemory.deleteMany(batch);
        }
        console.log(`  ✅ Deleted ${duplicateIds.length} duplicate records from aria-memory`);
    } else {
        console.log('  ✅ No duplicates found in aria-memory');
    }

    // ── 2. Clean orphaned default namespace ──────────────
    console.log('\n🧹 Step 2: Checking orphaned records in default namespace...');
    const defaultNs = index.namespace('');

    // Get stats first
    const stats = await index.describeIndexStats();
    const defaultCount = stats.namespaces?.['']?.recordCount || 0;
    console.log(`  Default namespace has ${defaultCount} records`);

    if (defaultCount > 0) {
        // List and delete all records in default namespace
        let deletedTotal = 0;
        let nextToken: string | undefined;

        do {
            const opts: any = { limit: 100 };
            if (nextToken) opts.paginationToken = nextToken;
            const result = await defaultNs.listPaginated(opts);
            const ids = (result.vectors || []).map((v: any) => v.id);

            if (ids.length > 0) {
                await defaultNs.deleteMany(ids);
                deletedTotal += ids.length;
                console.log(`  Deleted batch of ${ids.length} (total: ${deletedTotal})`);
            }

            nextToken = result.pagination?.next;
        } while (nextToken);

        console.log(`  ✅ Deleted ${deletedTotal} orphaned records from default namespace`);
    } else {
        console.log('  ✅ No orphaned records in default namespace');
    }

    // ── 3. Verify final state ────────────────────────────
    console.log('\n📊 Final state:');
    const finalStats = await index.describeIndexStats();
    console.log(JSON.stringify(finalStats, null, 2));
}

cleanup().catch(err => {
    console.error('❌ Cleanup failed:', err.message);
    process.exit(1);
});
