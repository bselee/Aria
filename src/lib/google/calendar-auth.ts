/**
 * @file    calendar-auth.ts
 * @purpose Interactive Google OAuth2 authorization flow specifically for Calendar.
 *          Saves to calendar-token.json to keep it separate from Gmail tokens.
 * @author  Aria
 * @created 2026-02-24
 * @deps    google-auth-library
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
 */

import { OAuth2Client } from "google-auth-library";
import * as fs from 'fs';
import * as path from 'path';

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
];

const TOKEN_PATH = path.join(process.cwd(), 'calendar-token.json');

/**
 * Get an authenticated Calendar client.
 */
export async function getAuthenticatedCalendarClient(): Promise<OAuth2Client> {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
        throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env.local");
    }

    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));

            client.setCredentials(token);

            // Auto-refresh if token is expired
            if (token.expiry_date && Date.now() >= token.expiry_date) {
                console.log(`🔄 [Calendar Auth] Refreshing expired token...`);
                const { credentials } = await client.refreshAccessToken();
                client.setCredentials(credentials);
                // Save refreshed token
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
                console.log(`✅ [Calendar Auth] Token refreshed and saved.`);
            }
        } catch (err: any) {
            console.error(`❌ [Calendar Auth] Failed to load token: ${err.message}`);
            throw new Error(`Calendar auth failed. Run: npx tsx src/cli/calendar-auth.ts`);
        }
    } else {
        throw new Error(`No Calendar token found. Run: npx tsx src/cli/calendar-auth.ts`);
    }

    return client;
}

/**
 * Generate an authorization URL.
 */
export function getCalendarAuthUrl(): string {
    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    return client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent', // Force consent screen to get refresh token
    });
}

/**
 * Exchange an authorization code for tokens and save them.
 */
export async function exchangeCalendarCodeAndSave(code: string): Promise<void> {
    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    const { tokens } = await client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`✅ Token saved to ${TOKEN_PATH}`);
}
