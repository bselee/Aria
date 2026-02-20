import { OAuth2Client } from "google-auth-library";
import * as fs from 'fs';
import * as path from 'path';

export async function getAuthenticatedClient(accountId: string): Promise<OAuth2Client> {
    if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
        throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env.local");
    }

    const client = new OAuth2Client({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost',
    });

    // Check for local token.json
    const tokenPath = path.join(process.cwd(), 'token.json');

    if (fs.existsSync(tokenPath)) {
        try {
            const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            client.setCredentials(token);
            console.log(`✅ [Gmail Auth] Loaded local token for account: ${accountId}`);
        } catch (err: any) {
            console.error(`❌ [Gmail Auth] Failed to parse token.json: ${err.message}`);
        }
    } else {
        console.warn(`⚠️ [Gmail Auth] No token found at ${tokenPath}.`);
    }

    return client;
}
