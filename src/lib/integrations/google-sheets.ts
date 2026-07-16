/**
 * @file    google-sheets.ts
 * @purpose Google Sheets API reader for Aria. Reads Daily Cash Report sheets
 *          from a specified Google Drive folder using OAuth2. Uses the Gmail
 *          auth module for OAuth2 since @googleapis/gmail's OAuth2 constructor
 *          is already configured and working.
 * @author  Hermia
 * @created 2026-07-16
 * @deps    @googleapis/gmail, fs, path
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI
 */

import * as fs from 'fs';
import * as path from 'path';
import { auth as gmailAuth } from '@googleapis/gmail';

/* ─────────────────────────── Consts ─────────────────────────── */

/** Drive folder ID for Daily Cash Reports */
export const CASH_REPORT_FOLDER_ID = '1uQ2u1FoZbbxUvX-yq8een0oZgJTmJuEJ';

/** OAuth2 scopes needed: read-only Sheets + Drive metadata */
export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

/** Token file path for Sheets access */
function getSheetsTokenPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(home, 'AppData', 'Local', 'hermes', 'tokens', 'sheets-token.json');
}

type GoogleOAuth2Client = InstanceType<typeof gmailAuth.OAuth2>;

/* ─────────────────────── Auth ─────────────────────── */

/**
 * Create a bare OAuth2 client for Sheets using the Gmail auth module.
 */
function createClient(): GoogleOAuth2Client {
  return new gmailAuth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost',
  );
}

/**
 * Save tokens to the sheets token path.
 */
function saveToken(tokens: any): void {
  const tokenPath = getSheetsTokenPath();
  const dir = path.dirname(tokenPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`✅ Sheets token saved to ${tokenPath}`);
}

/**
 * Get an authenticated client for Google Sheets/Drive API access.
 * Loads stored token, auto-refreshes if expired via direct HTTP refresh
 * (avoids gmailAuth.OAuth2.refreshAccessToken() bundle version mismatch).
 */
export async function getSheetsAuthClient(): Promise<{ accessToken: string }> {
  const tokenPath = getSheetsTokenPath();

  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      'No Sheets token found. Run: node --import tsx src/cli/google-sheets-auth.ts'
    );
  }

  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  // Refresh if expired (or within 5 min of expiry)
  if (!token.expiry_date || Date.now() >= token.expiry_date - 300000) {
    console.log('🔄 [Sheets Auth] Refreshing token...');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID || '',
        client_secret: process.env.GMAIL_CLIENT_SECRET || '',
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    const data = await response.json();
    if (data.error) {
      throw new Error(`Token refresh failed: ${data.error} — ${data.error_description || ''}`);
    }

    token.access_token = data.access_token;
    token.expiry_date = Date.now() + (data.expires_in || 3600) * 1000;
    if (data.scope) token.scope = data.scope;
    fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2));
  }

  return { accessToken: token.access_token };
}

/**
 * Generate an OAuth URL for Sheets authorization.
 */
export function getSheetsAuthUrl(): string {
  const client = createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SHEETS_SCOPES,
    prompt: 'consent',
  });
}

/**
 * Exchange an OAuth code for Sheets tokens and save to disk.
 */
export async function exchangeSheetsCode(code: string): Promise<void> {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  saveToken(tokens);
}

/* ─────────────────────── Drive/Sheets API ─────────────────────── */

/**
 * List Daily Cash Report spreadsheets in the target Drive folder.
 * Returns newest first. Supports Shared Drives.
 */
export async function listCashReportSheets(auth: { accessToken: string }): Promise<{
  id: string;
  name: string;
  dateRange: { start: string; end: string };
}[]> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?` +
      `q='${CASH_REPORT_FOLDER_ID}'+in+parents+and+mimeType='application/vnd.google-apps.spreadsheet'&` +
      `supportsAllDrives=true&includeItemsFromAllDrives=true&` +
      `orderBy=createdTime+desc&fields=files(id,name,createdTime)`,
    {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive API error: ${response.status} — ${text}`);
  }

  const data = (await response.json()) as {
    files: { id: string; name: string; createdTime: string }[];
  };

  return (data.files || []).map((f) => {
    const parts = f.name.split(' - ');
    return {
      id: f.id,
      name: f.name,
      dateRange: {
        start: parts[1] || '',
        end: parts[2] || '',
      },
    };
  });
}

/**
 * Read a Google Sheet as pipe-delimited CSV text via the Sheets API.
 */
export async function readSheetAsCSV(
  auth: { accessToken: string },
  spreadsheetId: string,
): Promise<string> {
  // Get sheet metadata
  const metaResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    },
  );

  if (!metaResponse.ok) {
    throw new Error(`Sheets API error: ${metaResponse.status}`);
  }

  const meta = (await metaResponse.json()) as {
    sheets: { properties: { sheetId: number; title: string } }[];
  };
  const firstSheet = meta.sheets?.[0];
  if (!firstSheet) throw new Error('No sheets found in spreadsheet');

  // Fetch data
  const range = `${firstSheet.properties.title}!A:E`;
  const dataResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range,
    )}?majorDimension=ROWS`,
    {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    },
  );

  if (!dataResponse.ok) {
    throw new Error(`Sheets API error: ${dataResponse.status}`);
  }

  const data = (await dataResponse.json()) as { values: string[][] };
  if (!data.values || data.values.length === 0) return '';

  // Convert to pipe-delimited
  return data.values
    .map((row) =>
      row
        .map((cell) => {
          const str = String(cell ?? '');
          if (str.includes('|') || str.includes(',') || str.includes('"')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join('|'),
    )
    .join('\n');
}

/**
 * Get the most recent Daily Cash Report sheet as CSV.
 */
export async function getLatestCashReportCSV(): Promise<{
  csv: string;
  sheetName: string;
}> {
  const auth = await getSheetsAuthClient();
  const sheets = await listCashReportSheets(auth);

  if (sheets.length === 0) {
    throw new Error('No Daily Cash Report sheets found in the folder');
  }

  const cashReports = sheets.filter((s) =>
    s.name.toLowerCase().includes('daily cash report'),
  );

  const target = cashReports.length > 0 ? cashReports[0] : sheets[0];
  const csv = await readSheetAsCSV(auth, target.id);

  return { csv, sheetName: target.name };
}
