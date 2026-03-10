/**
 * @file    calendar-auth.ts
 * @purpose Google Calendar OAuth2 client. Saves to calendar-token.json.
 *          Delegates to shared google-oauth.ts for OAuth2 logic.
 * @author  Aria
 * @created 2026-02-24
 * @updated 2026-03-10
 * @deps    @googleapis/calendar, ./google-oauth
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
 */

// DECISION(2026-03-09): Use auth.OAuth2 from @googleapis/calendar instead of the root
// google-auth-library. Mirrors the fix in gmail/auth.ts — see that file for full rationale.
import { auth as calendarAuth } from '@googleapis/calendar';
import * as path from 'path';

import {
    getAuthenticatedGoogleClient,
    getGoogleAuthUrl,
    exchangeGoogleCodeAndSave,
    type GoogleOAuthConfig,
} from './google-oauth';

type CalendarOAuth2Client = InstanceType<typeof calendarAuth.OAuth2>;

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
];

const TOKEN_PATH = path.join(process.cwd(), 'calendar-token.json');

/** Shared config wired to the Calendar auth module and scopes */
const CALENDAR_OAUTH_CONFIG: GoogleOAuthConfig = {
    authModule: calendarAuth,
    scopes: SCOPES,
    getTokenPath: () => TOKEN_PATH,
    label: 'Calendar',
    authCommand: () => 'npx tsx src/cli/calendar-auth.ts',
};

/**
 * Get an authenticated Calendar client.
 */
export async function getAuthenticatedCalendarClient(): Promise<CalendarOAuth2Client> {
    return getAuthenticatedGoogleClient(CALENDAR_OAUTH_CONFIG) as Promise<CalendarOAuth2Client>;
}

/**
 * Generate an authorization URL.
 */
export function getCalendarAuthUrl(): string {
    return getGoogleAuthUrl(CALENDAR_OAUTH_CONFIG);
}

/**
 * Exchange an authorization code for tokens and save them.
 */
export async function exchangeCalendarCodeAndSave(code: string): Promise<void> {
    return exchangeGoogleCodeAndSave(CALENDAR_OAUTH_CONFIG, code);
}
