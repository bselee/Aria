import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const apiBase = 'https://app.finaleinventory.com';
const ap = process.env.FINALE_ACCOUNT_PATH || 'buildasoilorganics';
const auth = 'Basic ' + Buffer.from(
    `${process.env.FINALE_API_KEY}:${process.env.FINALE_API_SECRET}`
).toString('base64');

async function test() {
    // Try REST product listing
    console.log('=== REST: /api/product (list) ===');
    const res = await fetch(`${apiBase}/${ap}/api/product`, {
        headers: { Authorization: auth },
    });
    if (res.ok) {
        const data = await res.json();
        // The REST product list returns an object with productUrl array
        if (data.productUrl) {
            console.log(`Got ${data.productUrl.length} product URLs`);
            // Extract product IDs from URLs
            const ids = data.productUrl
                .map((url: string) => url.split('/').pop())
                .filter((id: string) => {
                    const lower = id.toLowerCase();
                    return lower.includes('gnarbar') || lower.includes('prb') || lower.includes('problend');
                });
            console.log('Matches:', ids);
        } else {
            console.log('Keys:', Object.keys(data).slice(0, 10));
            console.log('Sample:', JSON.stringify(data).slice(0, 500));
        }
    } else {
        console.log(`Status: ${res.status} ${res.statusText}`);
    }
}

test().catch(console.error);
