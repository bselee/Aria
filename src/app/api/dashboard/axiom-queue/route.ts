/**
 * @file    route.ts
 * @purpose Dashboard Axiom Demand Queue API — returns recent Axiom demand with stats.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';

export type AxiomQueueItem = {
    id: string;
    product_url: string;
    product_id: string;
    finale_sku: string;
    axiom_sku: string | null;
    runway_days: number;
    velocity_30d: number;
    current_stock: number;
    suggested_reorder_qty: number;
    status: string;
    created_at: string;
};

export type AxiomQueueStats = {
    totalPending: number;
    totalApproved: number;
    totalOrdered: number;
};

export type AxiomQueueResponse = {
    items: AxiomQueueItem[];
    stats: AxiomQueueStats;
    cachedAt: string;
};

let cache: AxiomQueueResponse | null = null;
let cacheAt = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

export async function GET(req: NextRequest) {
    const bust = req.nextUrl.searchParams.has('bust');

    if (!bust && cache && Date.now() - cacheAt < CACHE_TTL) {
        return NextResponse.json(cache, { headers: { 'Cache-Control': 'no-store' } });
    }

    const supabase = createClient();
    if (!supabase) {
        return NextResponse.json(
            { error: 'Supabase not configured' },
            { status: 503 }
        );
    }

    try {
        const { data: rows, error } = await supabase
            .from('axiom_demand_queue')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw new Error(error.message);

        let totalPending = 0;
        let totalApproved = 0;
        let totalOrdered = 0;

        const items: AxiomQueueItem[] = (rows ?? []).map(row => {
            if (row.status === 'pending') totalPending++;
            if (row.status === 'approved') totalApproved++;
            if (row.status === 'ordered') totalOrdered++;

            return {
                id: String(row.id),
                product_url: row.product_url,
                product_id: row.product_id,
                finale_sku: row.finale_sku,
                axiom_sku: row.axiom_sku,
                runway_days: Number(row.runway_days),
                velocity_30d: Number(row.velocity_30d),
                current_stock: Number(row.current_stock),
                suggested_reorder_qty: Number(row.suggested_reorder_qty),
                status: row.status,
                created_at: row.created_at,
            };
        });

        const result: AxiomQueueResponse = {
            items,
            stats: {
                totalPending,
                totalApproved,
                totalOrdered,
            },
            cachedAt: new Date().toISOString(),
        };

        cache = result;
        cacheAt = Date.now();

        return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (err: any) {
        console.error('[axiom-queue] GET error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    // Bust cache
    cache = null;
    cacheAt = 0;
    return NextResponse.json({ ok: true });
}
