/**
 * @file    google-sheets-auth.ts
 * @purpose CLI to authorize Google Sheets read access. Generates an auth URL,
 *          exchanges the code, and saves the token.
 * @author  Hermia
 * @created 2026-07-16
 * @deps    dotenv, google-sheets.ts
 *
 * Usage:
 *   node --import tsx src/cli/google-sheets-auth.ts
 *   -> Opens auth URL. Paste code back as argument:
 *   node --import tsx src/cli/google-sheets-auth.ts <code>
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { getSheetsAuthUrl, exchangeSheetsCode } from '../lib/integrations/google-sheets';

async function main() {
  const code = process.argv[2];

  if (!code) {
    const url = getSheetsAuthUrl();
    console.log('🔐 Authorize Google Sheets access:');
    console.log('');
    console.log(url);
    console.log('');
    console.log('After authorizing, paste the authorization code:');
    console.log('  node --import tsx src/cli/google-sheets-auth.ts <code>');
    process.exit(0);
  }

  try {
    await exchangeSheetsCode(code);
    console.log('');
    console.log('✅ Sheets token saved. You can now use /match or reconcile-deposits.');
  } catch (err: any) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  }
}

main();
