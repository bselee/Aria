import { NextResponse } from 'next/server';
import { detectStuckPOs, summariseStuck } from '@/lib/purchasing/po-stuck-detector';

export async function GET() {
    const rows = await detectStuckPOs();
    const summary = summariseStuck(rows);
    return NextResponse.json({ summary, rows }, { headers: { 'Cache-Control': 'no-store' } });
}
