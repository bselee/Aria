import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });
import { createClient } from '@/lib/supabase';

(async () => {
    const sb = createClient();
    if (!sb) { console.error('no supabase'); process.exit(1); }
    const targets = process.argv.slice(2);
    if (targets.length === 0) {
        console.error('Usage: reset-followup-state.ts <po1> <po2> ...');
        process.exit(1);
    }
    const { error } = await sb
        .from('purchase_orders')
        .update({ tracking_requested_at: null, updated_at: new Date().toISOString() })
        .in('po_number', targets);
    if (error) { console.error(error.message); process.exit(1); }
    console.log(`Reset tracking_requested_at on: ${targets.join(', ')}`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
