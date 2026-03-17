/**
 * @file    route.ts
 * @purpose Handles actions on Axiom demand queue items (approve, reject, adjust qty).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';

export async function POST(req: NextRequest) {
    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
    }

    try {
        const body = await req.json();
        const { id, action, qty } = body;

        if (!id || !action) {
            return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
        }

        if (action === 'approve') {
            const updates: any = {
                status: 'approved',
                updated_at: new Date().toISOString(),
            };
            if (qty !== undefined) {
                updates.suggested_reorder_qty = qty;
            }

            const { error } = await supabase
                .from('axiom_demand_queue')
                .update(updates)
                .eq('id', id);

            if (error) throw new Error(error.message);
        } else if (action === 'reject') {
            const { error } = await supabase
                .from('axiom_demand_queue')
                .update({ status: 'rejected', updated_at: new Date().toISOString() })
                .eq('id', id);

            if (error) throw new Error(error.message);
        } else {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('[axiom-action] error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
