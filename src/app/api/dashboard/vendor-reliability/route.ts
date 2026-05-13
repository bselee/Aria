import { NextResponse } from 'next/server';
import { computeVendorReliability } from '@/lib/purchasing/vendor-reliability';

export async function GET() {
    const rows = await computeVendorReliability();
    return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
}
