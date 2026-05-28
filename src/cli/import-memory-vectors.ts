/**
 * @file    src/cli/import-memory-vectors.ts
 * @purpose Import Pinecone export JSON into local SQLite memory-store.
 *          Replaces Pinecone vector storage with aria-local.db.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    dotenv, ../lib/storage/memory-store
 *
 * Usage:
 *   node --import tsx src/cli/import-memory-vectors.ts
 *
 * Reads JSON files from ./scratch/pinecone-export/<namespace>.json
 * Expects format from export-pinecone-data.ts output.
 *
 * Verification: run after import to count vectors per namespace.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as fs from 'fs';
import * as path from 'path';
import { upsertVector, countVectors } from '../lib/storage/memory-store';

const IMPORT_DIR = path.join(process.cwd(), 'scratch', 'pinecone-export');

interface ExportVector {
    id: string;
    embedding: number[];
    metadata: Record<string, unknown>;
}

interface ExportData {
    exportedAt: string;
    namespace: string;
    indexName: string;
    vectorCount: number;
    embeddingDimensions: number;
    vectors: ExportVector[];
}

function importNamespace(namespace: string): { imported: number; errors: number } {
    const filePath = path.join(IMPORT_DIR, `${namespace}.json`);

    if (!fs.existsSync(filePath)) {
        console.log(`   ⚠️ No export file found for '${namespace}' at ${filePath}`);
        return { imported: 0, errors: 0 };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: ExportData = JSON.parse(raw);

    console.log(`   Source: ${data.exportedAt} | ${data.vectorCount} vectors | ${data.embeddingDimensions}d`);

    let imported = 0;
    let errors = 0;

    for (const vec of data.vectors) {
        try {
            const embedding = new Float32Array(vec.embedding);
            upsertVector(namespace, vec.id, embedding, vec.metadata);
            imported++;

            if (imported % 50 === 0) {
                process.stdout.write(`   Imported ${imported}/${data.vectorCount}\r`);
            }
        } catch (err: any) {
            errors++;
            if (errors <= 5) {
                console.warn(`   ⚠️ Failed to import ${vec.id}: ${err.message}`);
            }
        }
    }

    const count = countVectors(namespace);
    console.log(`   ✅ Imported ${imported} vectors into '${namespace}' (${errors} errors, ${count} total in store)`);

    return { imported, errors };
}

function main() {
    console.log(`\n🗃️  Memory Vector Import`);
    console.log(`   Source: ${IMPORT_DIR}/\n`);

    if (!fs.existsSync(IMPORT_DIR)) {
        console.error(`   ❌ Import directory not found: ${IMPORT_DIR}`);
        console.log(`   Run: node --import tsx src/cli/export-pinecone-data.ts first.\n`);
        process.exit(1);
    }

    const files = fs.readdirSync(IMPORT_DIR).filter(f => f.endsWith('.json'));

    if (files.length === 0) {
        console.error(`   ❌ No JSON files found in ${IMPORT_DIR}/`);
        console.log(`   Run: node --import tsx src/cli/export-pinecone-data.ts first.\n`);
        process.exit(1);
    }

    const namespaces = files.map(f => f.replace('.json', ''));
    const summary: Record<string, { imported: number; errors: number }> = {};

    for (const ns of namespaces) {
        console.log(`\n📥 Importing: ${ns}`);
        summary[ns] = importNamespace(ns);
    }

    // Verification
    console.log(`\n\n📊 Import Summary:`);
    console.log(`   ${'─'.repeat(50)}`);
    let totalImported = 0;
    let totalErrors = 0;
    for (const [ns, result] of Object.entries(summary)) {
        const count = countVectors(ns);
        console.log(`   ${ns.padEnd(20)} imported: ${result.imported}  errors: ${result.errors}  store: ${count}`);
        totalImported += result.imported;
        totalErrors += result.errors;
    }
    console.log(`   ${'─'.repeat(50)}`);
    console.log(`   ${'TOTAL'.padEnd(20)} imported: ${totalImported}  errors: ${totalErrors}`);

    if (totalErrors > 0) {
        console.log(`\n   ⚠️ ${totalErrors} vectors failed to import. Check warnings above.`);
    }

    console.log(`\n   ✅ Memory is now local. Pinecone can be safely disabled.`);
    console.log(`   Next: swap memory-layer-manager.ts callers, remove @pinecone-database/pinecone\n`);
}

main();
