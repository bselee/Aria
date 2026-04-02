import { NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const days = parseInt(searchParams.get('days') || '14', 10);

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const start = new Date(now);
        start.setDate(start.getDate() - days);
        const startStr = start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        // Use tomorrow as end bound so Finale's inclusive range catches today's receipts,
        // but actual filtering is done by shipmentList (only POs with real receipts returned)
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const finale = new FinaleClient();
        const received = await finale.getTodaysReceivedPOs(startStr, tomorrowStr);

        return NextResponse.json({ received, days, asOf: todayStr });
    } catch (err: any) {
        console.error('Receivings API error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
