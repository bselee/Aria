/**
 * @file    route.ts
 * @purpose Dashboard AP Health API — returns real-time pipeline stats.
 *          Queries ap_activity_log for today's intent counts + ap_inbox_queue
 *          for stuck items. 60-second module-level cache (bust with ?bust=1).
 * @author  Hermia
 * @created 2026-06-05
 * @deps    @/lib/supabase
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApHealthResponse {
    todayCounts: Record<string, number>;
    totalToday: number;
    matched: number;
    unmatched: number;
    matchRate: number;
    stuck: number;
    ocrIssues: number;
    recentStuck: Array<{ subject: string; from: string; status: string; ageHours: number; message_id?: string | null }>;
    status: 'healthy' | 'degraded' | 'critical';
}

// ── Module-level cache (60s) ─────────────────────────────────────────────────

let cache: { data: ApHealthResponse | null; ts: number } = { data: null, ts: 0 };
const CACHE_TTL = 60_000;

// ── Route ────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
    const bust = request.nextUrl.searchParams.get('bust');
    const now = Date.now();

    if (!bust && cache.data && now - cache.ts < CACHE_TTL) {
        return NextResponse.json(cache.data);
    }

    const db = createClient();
    if (!db) {
        return NextResponse.json({ error: 'Supabase client unavailable' }, { status: 500 });
    }

    try {
        // 1. Today's ap_activity_log counts by intent
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = today.toISOString();

        const { data: todayRows } = await db
            .from('ap_activity_log')
            .select('intent, metadata')
            .gte('created_at', todayIso);

        const todayCounts: Record<string, number> = {};
        let matched = 0;
        let unmatched = 0;
        let ocrIssues = 0;

        for (const row of (todayRows || []) as Array<{ intent: string; metadata: Record<string, unknown> | null }>) {
            const intent = row.intent || 'UNKNOWN';
            todayCounts[intent] = (todayCounts[intent] || 0) + 1;

            if (intent === 'OCR_RETRY') ocrIssues++;
            if (row.metadata?.matched === true || row.metadata?.matched === 'true') matched++;
            else if (intent === 'BILL_FORWARD' || intent === 'INVOICE') {
                if (row.metadata?.matched === false || row.metadata?.matched === 'false') unmatched++;
            }
            // Also check action_taken for zero-line-item signals
            if (intent === 'OCR_RETRY') ocrIssues++;
        }

        // 2. Stuck invoices (exclude zombies)
        const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
        const { data: stuckRows } = await db
            .from('ap_inbox_queue')
            .select('message_id, email_subject, email_from, status, created_at, extracted_json')
            .in('status', ['ERROR_FORWARDING', 'ERROR_PROCESSING'])
            .lt('updated_at', twoHoursAgo)
            .limit(10);

        let stuck = 0;
        const recentStuck: ApHealthResponse['recentStuck'] = [];
        for (const row of (stuckRows || []) as Array<{
            message_id: string | null;
            email_subject: string | null;
            email_from: string | null;
            status: string;
            created_at: string;
            extracted_json: Record<string, unknown> | null;
        }>) {
            const ej = row.extracted_json;
            // Zombie filter: skip records with no meaningful extracted_json
            if (!ej || typeof ej !== 'object' || (!ej.from && !ej.vendor_name && !ej.subject && !row.email_subject)) {
                continue;
            }
            stuck++;
            if (recentStuck.length < 5) {
                recentStuck.push({
                    message_id: row.message_id,
                    subject: row.email_subject || (ej.subject as string) || '(no subject)',
                    from: row.email_from || (ej.from as string) || (ej.vendor_name as string) || 'unknown',
                    status: row.status,
                    ageHours: Math.round((Date.now() - new Date(row.created_at).getTime()) / 3600000),
                });
            }
        }

        // 3. OCR issues from action_taken
        const { data: ocrRows } = await db
            .from('ap_activity_log')
            .select('action_taken')
            .gte('created_at', todayIso)
            .eq('intent', 'OCR_RETRY');

        const zeroLineItems = (ocrRows || []).filter((r: any) =>
            (r.action_taken || '').toLowerCase().includes('zero line')
        ).length;
        ocrIssues = Math.max(ocrIssues, zeroLineItems);

        // 4. Compute stats
        const totalInvoiceRelated = (todayCounts['INVOICE'] || 0) + (todayCounts['BILL_FORWARD'] || 0);
        const totalMatched = matched;
        const matchRate = totalInvoiceRelated > 0 ? Math.round((totalMatched / totalInvoiceRelated) * 100) : 100;

        // 5. Overall status
        let status: ApHealthResponse['status'] = 'healthy';
        if (stuck > 0 || ocrIssues > 2) status = 'critical';
        else if (matchRate < 50 || ocrIssues > 0) status = 'degraded';

        const response: ApHealthResponse = {
            todayCounts,
            totalToday: Object.values(todayCounts).reduce((a, b) => a + b, 0),
            matched: totalMatched,
            unmatched,
            matchRate,
            stuck,
            ocrIssues,
            recentStuck,
            status,
        };

        cache = { data: response, ts: Date.now() };
        return NextResponse.json(response);

    } catch (err: any) {
        console.error('[ap-health] API error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}