import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });
import { createClient } from '@/lib/supabase';

(async () => {
    const sb = createClient();
    if (!sb) { console.error('no supabase'); process.exit(1); }
    const pos = process.argv.slice(2);
    if (pos.length === 0) { console.error('Usage: inspect-po.ts <po1> ...'); process.exit(1); }
    const { data } = await sb
        .from('purchase_orders')
        .select('po_number,vendor_name,po_sent_verified_at,vendor_acknowledged_at,vendor_ack_source,tracking_requested_at,tracking_numbers,vendor_noncomm_at')
        .in('po_number', pos);
    for (const r of (data ?? [])) console.log(JSON.stringify(r, null, 2));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
