import { NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';

export function getDenverWeekStart(date: Date): string {
    const denverNow = new Date(date.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    const day = denverNow.getDay();
    const daysSinceMonday = (day + 6) % 7;
    denverNow.setDate(denverNow.getDate() - daysSinceMonday);
    return denverNow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const daysParam = searchParams.get('days');

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const startStr = daysParam
            ? (() => {
                const days = parseInt(daysParam, 10);
                const start = new Date(now);
                start.setDate(start.getDate() - days);
                return start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            })()
            : getDenverWeekStart(now);

        // Use tomorrow as end bound so Finale's inclusive range catches today's receipts,
        // but actual filtering is done by shipmentList (only POs with real receipts returned)
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const finale = new FinaleClient();
        const received = await finale.getTodaysReceivedPOs(startStr, tomorrowStr);

        return NextResponse.json({
            received,
            days: daysParam ? parseInt(daysParam, 10) : null,
            range: daysParam ? 'rolling_days' : 'week_to_date',
            startDate: startStr,
            asOf: todayStr,
        });
    } catch (err: any) {
        console.error('Receivings API error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
