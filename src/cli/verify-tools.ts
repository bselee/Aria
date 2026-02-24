/**
 * @file    verify-tools.ts
 * @purpose Verifies access to Firecrawl (scraping) and Chrome (via Firecrawl).
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const Firecrawl = require('@mendable/firecrawl-js');

async function verifyFirecrawl() {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
        console.error("❌ FIRECRAWL_API_KEY missing.");
        return;
    }

    const app = new Firecrawl.default({ apiKey });

    try {
        console.log("🔍 Testing Firecrawl Scrape (DuckDuckGo)...");
        const scrapeResult = await app.scrapeUrl('https://duckduckgo.com/?q=weather+in+montrose+co', {
            formats: ['markdown'],
        });

        if (scrapeResult.success) {
            console.log("✅ Firecrawl Scrape Success!");
            console.log("📄 Preview of content:", scrapeResult.markdown?.slice(0, 500));
        } else {
            console.error("❌ Firecrawl Scrape Failed:", scrapeResult.error);
        }

    } catch (err: any) {
        console.error("❌ Firecrawl Error:", err.message);
    }
}

verifyFirecrawl();
