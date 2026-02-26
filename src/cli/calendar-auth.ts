/**
 * @file    calendar-auth.ts
 * @purpose Interactive Google OAuth2 authorization flow specifically for Calendar.
 *          Opens browser, user signs in, pastes redirect URL, token is saved.
 * @author  Aria
 * @created 2026-02-24
 * @deps    dotenv, google-auth-library
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
 * 
 * Usage:
 *   npx tsx src/cli/calendar-auth.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as readline from 'readline';
import { getCalendarAuthUrl, exchangeCalendarCodeAndSave } from '../lib/google/calendar-auth';

console.log(`\n📅 Google Calendar OAuth2 Setup\n`);

const authUrl = getCalendarAuthUrl();
console.log(`1. Open this URL in your browser:\n`);
console.log(`   ${authUrl}\n`);
console.log(`2. Sign in with the Google Account that CAN read the Soil and MFG calendars.`);
console.log(`3. After granting access, you'll be redirected to a URL.`);
console.log(`4. Copy the ENTIRE redirect URL and paste it below.\n`);
console.log(`   (It will look like: http://localhost?code=4/xxx...&scope=...)\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste redirect URL: ', async (url) => {
    try {
        // Extract the code from the URL
        const urlObj = new URL(url.trim());
        const code = urlObj.searchParams.get('code');

        if (!code) {
            console.error('❌ No authorization code found in URL. Make sure you pasted the full redirect URL.');
            process.exit(1);
        }

        console.log(`\n🔄 Exchanging code for tokens...`);
        await exchangeCalendarCodeAndSave(code);

        console.log(`\n✅ Calendar is now authorized!`);
        console.log(`   Token saved to: calendar-token.json`);
        console.log(`\n   You can now run Phase 1 tests.`);

    } catch (err: any) {
        console.error(`\n❌ Authorization failed: ${err.message}`);
        if (err.message.includes('invalid_grant')) {
            console.log('   The code may have expired. Try the flow again.');
        }
    } finally {
        rl.close();
        process.exit(0);
    }
});
