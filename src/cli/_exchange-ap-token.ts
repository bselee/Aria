import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { exchangeCodeAndSave } from '../lib/gmail/auth';

const code = process.argv[2];
if (!code) { console.error('Usage: node _exchange-ap-token.ts <code>'); process.exit(1); }

(async () => {
    await exchangeCodeAndSave(code, 'ap');
    console.log('✅ token-ap.json saved');
})();
