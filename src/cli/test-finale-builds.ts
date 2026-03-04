/**
 * @file    test-finale-builds.ts
 * @purpose Probe the Finale API to discover the build/manufacturing order endpoint.
 *          Run this once after deploy to verify getRecentlyCompletedBuilds() works.
 *
 * Usage:
 *   node --import tsx src/cli/test-finale-builds.ts
 */

import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local' });

import { FinaleClient } from '../lib/finale/client';

const ACCOUNT = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
const BASE_URL = process.env.FINALE_BASE_URL || 'https://app.finaleinventory.com';
const API_KEY = process.env.FINALE_API_KEY || '';
const API_SECRET = process.env.FINALE_API_SECRET || '';
const AUTH = `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64')}`;

async function probe(label: string, url: string, options: RequestInit = {}) {
    console.log(`\n🔍 [${label}]`);
    console.log(`   → ${url}`);
    try {
        const res = await fetch(url, {
            ...options,
            headers: { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
        });
        console.log(`   ← HTTP ${res.status} ${res.statusText}`);
        const text = await res.text();
        try {
            const json = JSON.parse(text);
            console.log('   ← Body (first 500 chars):', JSON.stringify(json).slice(0, 500));
        } catch {
            console.log('   ← Raw (first 500 chars):', text.slice(0, 500));
        }
    } catch (err: any) {
        console.log(`   ← Error: ${err.message}`);
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('Finale Build Order Endpoint Discovery');
    console.log('='.repeat(60));

    // REST probes
    await probe('REST /api/build (list)', `${BASE_URL}/${ACCOUNT}/api/build`);
    await probe('REST /api/build?statusId=COMPLETE', `${BASE_URL}/${ACCOUNT}/api/build?statusId=COMPLETE&limit=10`);
    await probe('REST /api/buildorder', `${BASE_URL}/${ACCOUNT}/api/buildorder`);
    await probe('REST /api/manufacture', `${BASE_URL}/${ACCOUNT}/api/manufacture`);

    // GraphQL probes
    const gqlUrl = `${BASE_URL}/${ACCOUNT}/api/graphql`;

    await probe('GraphQL buildOrderViewConnection', gqlUrl, {
        method: 'POST',
        body: JSON.stringify({
            query: `{ buildOrderViewConnection(first: 5) { edges { node { orderId productId quantity completionDate statusId } } } }`
        }),
    });

    await probe('GraphQL buildViewConnection', gqlUrl, {
        method: 'POST',
        body: JSON.stringify({
            query: `{ buildViewConnection(first: 5) { edges { node { orderId productId quantity completionDate statusId } } } }`
        }),
    });

    // Also test the high-level method
    console.log('\n' + '='.repeat(60));
    console.log('Testing FinaleClient.getRecentlyCompletedBuilds()');
    console.log('='.repeat(60));
    const finale = new FinaleClient();
    const since = new Date();
    since.setDate(since.getDate() - 365); // Wide window to find any completed builds
    const builds = await finale.getRecentlyCompletedBuilds(since);
    console.log(`\nResult: ${builds.length} completed builds found in last 365 days`);
    if (builds.length > 0) {
        console.log('Sample:', JSON.stringify(builds.slice(0, 3), null, 2));
    }

    console.log('\n✅ Probe complete. Review output above to identify the working endpoint.');
    console.log('   Update getRecentlyCompletedBuilds() in client.ts with the correct field names.');
}

main().catch(console.error);
