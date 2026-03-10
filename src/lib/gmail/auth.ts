/**
 * @file    auth.ts
 * @purpose Multi-account Gmail OAuth2 client with per-account token storage.
 *          Supports multiple Gmail accounts (e.g., "default", "purchasing").
 *          Delegates to shared google-oauth.ts for OAuth2 logic.
 * @author  Will / Antigravity
 * @created 2026-02-20
 * @updated 2026-03-10
 * @deps    @googleapis/gmail, ../google/google-oauth
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 */

// DECISION(2026-03-09): Use auth.OAuth2 from @googleapis/gmail instead of the root
// google-auth-library. @googleapis/gmail bundles google-auth-library@10.x internally,
// and googleapis-common performs an instanceof check against its own bundled class.
// The root package is v9.x — a different class instance — so instanceof fails and
// the Authorization header is never sent. Using the same class the package bundled
// ensures the check passes and OAuth tokens are properly attached to every request.
import { auth as gmailAuth } from '@googleapis/gmail';
import * as fs from 'fs';
import * as path from 'path';

import {
    getAuthenticatedGoogleClient,
    getGoogleAuthUrl,
    exchangeGoogleCodeAndSave,
    type GoogleOAuthConfig,
} from '../google/google-oauth';

type GmailOAuth2Client = InstanceType<typeof gmailAuth.OAuth2>;

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

/** Shared config wired to the Gmail auth module and scopes */
const GMAIL_OAUTH_CONFIG: GoogleOAuthConfig = {
    authModule: gmailAuth,
    scopes: SCOPES,
    getTokenPath,
    label: 'Gmail',
    authCommand: (accountId) => `npx tsx src/cli/gmail-auth.ts ${accountId}`,
    requiredScopeSubstring: 'gmail.send',
};

/**
 * Get an authenticated Gmail client for the specified account.
 *
 * @param accountId - Account identifier (e.g., "default", "purchasing")
 * @returns Authenticated OAuth2Client
 */
export async function getAuthenticatedClient(accountId: string = 'default'): Promise<GmailOAuth2Client> {
    return getAuthenticatedGoogleClient(GMAIL_OAUTH_CONFIG, accountId) as Promise<GmailOAuth2Client>;
}

/**
 * Generate an authorization URL for the specified account.
 */
export function getAuthUrl(accountId: string = 'default'): string {
    return getGoogleAuthUrl(GMAIL_OAUTH_CONFIG, accountId);
}

/**
 * Exchange an authorization code for tokens and save them.
 */
export async function exchangeCodeAndSave(code: string, accountId: string = 'default'): Promise<void> {
    return exchangeGoogleCodeAndSave(GMAIL_OAUTH_CONFIG, code, accountId);
}

/** All configured scopes */
export { SCOPES };
