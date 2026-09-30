/**
 * @file    drive-auth.ts
 * @purpose Google OAuth2 flow for Drive + Apps Script (delete old Apps Script
 *          artifacts: backup Docs, standalone scripts, and bound script projects).
 *          Saves token to drive-token.json.
 * @author  Aria
 * @created 2026-09-30
 * @deps    dotenv, @googleapis/gmail, ../lib/google/google-oauth
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 *
 * Usage:
 *   node --import tsx src/cli/drive-auth.ts            # print consent URL, exit
 *   node --import tsx src/cli/drive-auth.ts <code|url> # exchange code, save token
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import * as path from 'path';
import { auth as gmailAuth } from '@googleapis/gmail';
import {
    getGoogleAuthUrl,
    exchangeGoogleCodeAndSave,
    type GoogleOAuthConfig,
} from '../lib/google/google-oauth';

const SCOPES = [
    'https://www.googleapis.com/auth/drive',             // read + delete Drive files
    'https://www.googleapis.com/auth/script.projects',   // list + delete Apps Script projects
];

const DRIVE_OAUTH_CONFIG: GoogleOAuthConfig = {
    authModule: gmailAuth,
    scopes: SCOPES,
    getTokenPath: () => path.join(process.cwd(), 'drive-token.json'),
    label: 'Drive/Apps Script',
    authCommand: () => 'node --import tsx src/cli/drive-auth.ts',
};

const arg = process.argv[2];

if (!arg) {
    const authUrl = getGoogleAuthUrl(DRIVE_OAUTH_CONFIG);
    console.log(`\n1. Open this URL in your browser:\n\n   ${authUrl}\n`);
    console.log(`2. Sign in with the Google Account that OWNS the old Apps Scripts + Docs.`);
    console.log(`3. Approve, then copy the ENTIRE redirect URL and run:\n`);
    console.log(`   node --import tsx src/cli/drive-auth.ts "<REDIRECT_URL>"\n`);
    process.exit(0);
}

// Exchange mode — arg is either a raw code or a full redirect URL
(async () => {
    try {
        const code = arg.includes('code=') ? new URL(arg).searchParams.get('code') : arg;
        if (!code) {
            console.error('❌ No authorization code found in the argument.');
            process.exit(1);
        }
        await exchangeGoogleCodeAndSave(DRIVE_OAUTH_CONFIG, code);
        console.log('\n✅ Drive/Apps Script authorized. Token saved to drive-token.json');
    } catch (e: any) {
        console.error('\n❌ Authorization failed: ' + e.message);
    }
    process.exit(0);
})();
