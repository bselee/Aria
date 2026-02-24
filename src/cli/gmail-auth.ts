/**
 * @file    gmail-auth.ts
 * @purpose Interactive Gmail OAuth2 authorization flow with multi-account support.
 *          Opens browser, user signs in, pastes redirect URL, token is saved.
 * @author  Will / Antigravity
 * @created 2026-02-24
 * @updated 2026-02-24
 * @deps    dotenv, google-auth-library
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
 * 
 * Usage:
 *   npx tsx src/cli/gmail-auth.ts              # Auth "default" account
 *   npx tsx src/cli/gmail-auth.ts purchasing    # Auth "purchasing" account
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as readline from 'readline';
import { getAuthUrl, exchangeCodeAndSave, SCOPES } from '../lib/gmail/auth';

const accountId = process.argv[2] || 'default';

console.log(`\n📧 Gmail OAuth2 Setup — Account: "${accountId}"\n`);
console.log(`Scopes requested:`);
SCOPES.forEach(s => console.log(`  ✅ ${s}`));
console.log();

const authUrl = getAuthUrl(accountId);
console.log(`1. Open this URL in your browser:\n`);
console.log(`   ${authUrl}\n`);
console.log(`2. Sign in with the Gmail account you want to authorize.`);
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
        await exchangeCodeAndSave(code, accountId);

        console.log(`\n✅ Gmail account "${accountId}" is now authorized!`);
        console.log(`   Token saved to: token-${accountId}.json`);
        console.log(`\n   You can now use this account in Aria.`);

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
