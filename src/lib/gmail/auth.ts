/**
 * @file    auth.ts
 * @purpose Multi-account Gmail OAuth2 client with per-account token storage.
 *          Supports multiple Gmail accounts (e.g., "default", "purchasing").
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-02-24
 * @deps    google-auth-library
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 */

import { OAuth2Client } from "google-auth-library";
import * as fs from 'fs';
import * as path from 'path';

// DECISION(2026-02-24): Each account gets its own token file (token-{accountId}.json)
// so we can auth multiple Gmail accounts. "default" maps to "token-default.json".
// The old "token.json" is still supported as a fallback for backward compatibility.

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.settings.basic',
];

/**
 * Returns the token file path for a given account.
 * Falls back to legacy "token.json" if the account-specific file doesn't exist.
 */
function getTokenPath(accountId: string): string {
    const dir = process.cwd();
    const accountTokenPath = path.join(dir, `token-${accountId}.json`);
    const legacyTokenPath = path.join(dir, 'token.json');

    if (fs.existsSync(accountTokenPath)) return accountTokenPath;
    if (accountId === 'default' && fs.existsSync(legacyTokenPath)) return legacyTokenPath;

    // Return account-specific path for new tokens
    return accountTokenPath;
}

/**
 * Get an authenticated Gmail client for the specified account.
 * 
 * @param accountId - Account identifier (e.g., "default", "purchasing")
 * @returns Authenticated OAuth2Client
 */
export async function getAuthenticatedClient(accountId: string = 'default'): Promise<OAuth2Client> {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
        throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env.local");
    }

    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    const tokenPath = getTokenPath(accountId);

    if (fs.existsSync(tokenPath)) {
        try {
            const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

            // Check if token has send scope — warn if not
            const tokenScopes = token.scope || '';
            if (!tokenScopes.includes('gmail.send')) {
                console.warn(`⚠️ [Gmail Auth] Token for "${accountId}" missing gmail.send scope. Run: npx tsx src/cli/gmail-auth.ts ${accountId}`);
            }

            client.setCredentials(token);

            // Auto-refresh if token is expired
            if (token.expiry_date && Date.now() >= token.expiry_date) {
                console.log(`🔄 [Gmail Auth] Refreshing expired token for "${accountId}"...`);
                const { credentials } = await client.refreshAccessToken();
                client.setCredentials(credentials);
                // Save refreshed token
                fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2));
                console.log(`✅ [Gmail Auth] Token refreshed and saved for "${accountId}"`);
            } else {
                console.log(`✅ [Gmail Auth] Loaded token for account: ${accountId}`);
            }
        } catch (err: any) {
            console.error(`❌ [Gmail Auth] Failed to load token for "${accountId}": ${err.message}`);
            throw new Error(`Gmail auth failed for "${accountId}". Run: npx tsx src/cli/gmail-auth.ts ${accountId}`);
        }
    } else {
        throw new Error(`No Gmail token for "${accountId}". Run: npx tsx src/cli/gmail-auth.ts ${accountId}`);
    }

    return client;
}

/**
 * Generate an authorization URL for the specified account.
 */
export function getAuthUrl(accountId: string = 'default'): string {
    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    return client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent', // Force consent screen to get refresh token
        state: accountId,
    });
}

/**
 * Exchange an authorization code for tokens and save them.
 */
export async function exchangeCodeAndSave(code: string, accountId: string = 'default'): Promise<void> {
    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    const { tokens } = await client.getToken(code);
    const tokenPath = path.join(process.cwd(), `token-${accountId}.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    console.log(`✅ Token saved to ${tokenPath}`);
    console.log(`   Scopes: ${tokens.scope}`);
}

/** All configured scopes */
export { SCOPES };
