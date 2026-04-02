/**
 * @file    google-oauth.ts
 * @purpose Shared Google OAuth2 helper used by both Gmail and Calendar auth modules.
 *          Extracts common logic (client creation, token load/save/refresh, auth URL
 *          generation, code exchange) into a single generic implementation.
 * @author  Will / Antigravity
 * @created 2026-03-10
 * @updated 2026-03-10
 * @deps    fs, path
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 */

// DECISION(2026-03-10): This module is intentionally generic over the `auth` module.
// Each @googleapis/* package bundles its own google-auth-library@10.x internally, and
// googleapis-common performs an instanceof check against its own bundled OAuth2 class.
// If we used a single auth import (e.g. from @googleapis/gmail), the resulting client
// would fail instanceof checks inside @googleapis/calendar. To avoid this, each caller
// passes in the `auth` export from its own @googleapis/* package, and this module uses
// that to construct the OAuth2 client. See DECISION(2026-03-09) in gmail/auth.ts for
// the original discovery of this constraint.

import * as fs from 'fs';
import * as path from 'path';

/* ────────────────────────────── Types ────────────────────────────── */

/**
 * Minimal interface for the `auth` export from any @googleapis/* package.
 * Only the OAuth2 constructor is needed.
 */
interface GoogleAuthModule {
    OAuth2: new (...args: any[]) => GoogleOAuth2Client;
}

/**
 * Minimal interface for an OAuth2 client instance returned by any @googleapis/* auth.OAuth2.
 * Covers only the methods this helper actually calls.
 */
interface GoogleOAuth2Client {
    setCredentials(credentials: any): void;
    refreshAccessToken(): Promise<{ credentials: any }>;
    generateAuthUrl(options: {
        access_type: string;
        scope: string[];
        prompt: string;
        state?: string;
    }): string;
    getToken(code: string): Promise<{ tokens: any }>;
}

/**
 * Configuration for a specific Google API's auth needs.
 */
export interface GoogleOAuthConfig {
    /** The `auth` export from the relevant @googleapis/* package */
    authModule: GoogleAuthModule;
    /** OAuth2 scopes to request */
    scopes: string[];
    /** Resolve an accountId to a token file path */
    getTokenPath: (accountId: string) => string;
    /** Human-readable label for log messages (e.g. "Gmail", "Calendar") */
    label: string;
    /** CLI command to re-auth (used in error messages) */
    authCommand: (accountId: string) => string;
    /** Optional scope substring to validate in stored tokens */
    requiredScopeSubstring?: string;
}

/* ────────────────────────── Helpers ────────────────────────── */

/**
 * Creates a bare (unauthenticated) OAuth2 client from environment variables.
 *
 * @param   config - The OAuth config containing the auth module
 * @returns A new OAuth2 client instance from the correct @googleapis/* package
 * @throws  {Error} If GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET are not set
 */
function createOAuth2Client(config: GoogleOAuthConfig): GoogleOAuth2Client {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
        throw new Error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env.local');
    }

    return new config.authModule.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    );
}

/* ────────────────────── Public API ────────────────────── */

/**
 * Get an authenticated OAuth2 client for the specified account.
 * Loads the stored token, auto-refreshes if expired, and persists the update.
 *
 * @param   config    - OAuth config for the target Google API
 * @param   accountId - Account identifier (e.g. "default", "purchasing")
 * @returns Authenticated OAuth2 client
 * @throws  {Error} If no token exists or the token cannot be loaded
 */
export async function getAuthenticatedGoogleClient(
    config: GoogleOAuthConfig,
    accountId: string = 'default',
): Promise<GoogleOAuth2Client> {
    const client = createOAuth2Client(config);
    const tokenPath = config.getTokenPath(accountId);

    if (!fs.existsSync(tokenPath)) {
        throw new Error(
            `No ${config.label} token for "${accountId}". Run: ${config.authCommand(accountId)}`,
        );
    }

    try {
        const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

        // Optional scope validation
        if (config.requiredScopeSubstring) {
            const tokenScopes = (token.scope as string) || '';
            if (!tokenScopes.includes(config.requiredScopeSubstring)) {
                console.warn(
                    `⚠️ [${config.label} Auth] Token for "${accountId}" missing ${config.requiredScopeSubstring} scope. Run: ${config.authCommand(accountId)}`,
                );
            }
        }

        client.setCredentials(token);

        // Auto-refresh if token is expired
        if (token.expiry_date && Date.now() >= token.expiry_date) {
            console.log(`🔄 [${config.label} Auth] Refreshing expired token for "${accountId}"...`);
            const { credentials } = await client.refreshAccessToken();
            client.setCredentials(credentials);
            fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2));
            console.log(`✅ [${config.label} Auth] Token refreshed and saved for "${accountId}"`);
        } else {
            console.log(`✅ [${config.label} Auth] Loaded token for account: ${accountId}`);
        }
    } catch (err: any) {
        console.error(`❌ [${config.label} Auth] Failed to load token for "${accountId}": ${err.message}`);
        throw new Error(
            `${config.label} auth failed for "${accountId}". Run: ${config.authCommand(accountId)}`,
        );
    }

    return client;
}

/**
 * Generate an authorization URL for the OAuth2 consent screen.
 *
 * @param   config    - OAuth config for the target Google API
 * @param   accountId - Account identifier (used as `state` param for Gmail multi-account)
 * @returns Authorization URL string
 */
export function getGoogleAuthUrl(
    config: GoogleOAuthConfig,
    accountId?: string,
): string {
    const client = createOAuth2Client(config);

    return client.generateAuthUrl({
        access_type: 'offline',
        scope: config.scopes,
        prompt: 'consent',
        ...(accountId ? { state: accountId } : {}),
    });
}

/**
 * Exchange an authorization code for tokens and save them to disk.
 *
 * @param   config    - OAuth config for the target Google API
 * @param   code      - Authorization code from OAuth2 redirect
 * @param   accountId - Account identifier (determines token file path)
 */
export async function exchangeGoogleCodeAndSave(
    config: GoogleOAuthConfig,
    code: string,
    accountId: string = 'default',
): Promise<void> {
    const client = createOAuth2Client(config);

    const { tokens } = await client.getToken(code);
    const tokenPath = config.getTokenPath(accountId);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    console.log(`✅ Token saved to ${tokenPath}`);

    // Log scopes if available (Gmail returns them, Calendar may not)
    const scope = (tokens as Record<string, unknown>).scope;
    if (scope) {
        console.log(`   Scopes: ${scope}`);
    }
}
