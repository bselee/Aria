/**
 * @file    test-friday-order.ts
 * @purpose One-off test of the autonomous Friday ULINE order pipeline
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { runAutonomousUlineOrder } from './order-uline';

async function main() {
    console.log('\n  ═══ Testing Autonomous ULINE Order Pipeline ═══\n');
    const result = await runAutonomousUlineOrder();
    console.log('\n  ═══ RESULT ═══');
    console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
