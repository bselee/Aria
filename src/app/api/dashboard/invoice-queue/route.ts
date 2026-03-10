/**
 * @file    route.ts
 * @purpose Dashboard Invoice Queue API — returns recent AP-processed invoices with stats.
 *          GET:  returns invoices + stats (60-second module-level cache, bust with ?bust=1)
 *          POST: /api/dashboard/invoice-queue/export handled via the export sub-route.
 *                This route also handles ?export=1 to return CSV for download.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InvoiceQueueItem = {
    id: string;
    invoiceNumber: string;
    vendorName: string;
    total: number;
    subtotal: number;
    freight: number | null;
    tax: number | null;
    tariff: number | null;
    labor: number | null;
    status: string;
    poNumber: string | null;
    processedAt: string;
    dollarImpact: number | null;
    balanceWarning: string | null;
};

export type InvoiceQueueStats = {
    totalToday: number;
    autoApproved: number;
    needsApproval: number;
    unmatched: number;
    totalDollarImpact: number;
};

export type InvoiceQueueResponse = {
    invoices: InvoiceQueueItem[];
    stats: InvoiceQueueStats;
    cachedAt: string;
};

// ── Module-level cache ────────────────────────────────────────────────────────

let cache: InvoiceQueueResponse | null = null;
let cacheAt = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map raw invoice `status` + most recent activity log action_taken
 * to a canonical display status.
 */
function resolveStatus(
    invoiceStatus: string | null,
    actionTaken: string | null
): string {
    const a = (actionTaken ?? '').toLowerCase();
    const s = (invoiceStatus ?? '').toLowerCase();

    // Explicit invoice statuses from reconciler
    if (s === 'matched_approved' || a.includes('applied') || a.includes('auto-approv')) {
        return 'auto_approved';
    }
    if (s === 'matched_review' || a.includes('pending') || a.includes('flagged') || a.includes('approval')) {
        return 'needs_approval';
    }
    if (a.includes('rejected') || a.includes('reject')) {
        return 'rejected';
    }
    if (s === 'duplicate' || a.includes('duplicate') || a.includes('already processed')) {
        return 'duplicate';
    }
    // Default: unmatched if no PO was found
    if (s === 'unmatched' || a.includes('no match') || a.includes('unmatched') || a.includes('dropship')) {
        return 'unmatched';
    }
    // Forwarded to Bill.com but no reconciliation result yet
    return 'unmatched';
}

/**
 * Pull dollar impact from metadata JSONB — reconciler stores it under
 * metadata.totalImpact or metadata.dollarImpact.
 */
function extractDollarImpact(metadata: any): number | null {
    if (!metadata) return null;
    const v = metadata.totalImpact ?? metadata.dollarImpact ?? null;
    if (v === null || v === undefined) return null;
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
}

/**
 * Pull a balance warning string from metadata — reconciler may store
 * notes about price deviations or large adjustments.
 */
function extractBalanceWarning(metadata: any): string | null {
    if (!metadata) return null;
    return metadata.balanceWarning ?? metadata.warning ?? metadata.note ?? null;
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
    const bust = req.nextUrl.searchParams.has('bust');
    const wantCsv = req.nextUrl.searchParams.get('export') === '1';

    // ── CSV Export ────────────────────────────────────────────────────────────
    if (wantCsv) {
        return handleCsvExport();
    }

    // ── Cache check ───────────────────────────────────────────────────────────
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
        // ── Fetch invoices ordered newest-first ───────────────────────────────
        const { data: invoicesRaw, error: invErr } = await supabase
            .from('invoices')
            .select(
                'id, invoice_number, vendor_name, total, subtotal, freight, tax, tariff, labor, status, po_number, created_at, discrepancies'
            )
            .order('created_at', { ascending: false })
            .limit(100);

        if (invErr) throw new Error(invErr.message);

        const rows: any[] = invoicesRaw ?? [];

        // ── Fetch the most recent ap_activity_log entry per invoice ───────────
        // We join by invoice_number matching email_subject (the reconciler logs
        // include the invoice number in the subject or metadata). Since there is no
        // FK between the tables, we fetch the last 200 log rows and index them by
        // invoice number extracted from metadata.invoiceNumber.
        const { data: logRaw } = await supabase
            .from('ap_activity_log')
            .select('id, created_at, email_subject, action_taken, metadata, intent')
            .in('intent', ['INVOICE', 'RECONCILIATION'])
            .order('created_at', { ascending: false })
            .limit(200);

        // Index logs by invoice number extracted from metadata
        const logByInvoiceNum = new Map<string, any>();
        for (const log of logRaw ?? []) {
            const invNum: string | undefined =
                log.metadata?.invoiceNumber ??
                log.metadata?.invoice_number ??
                log.metadata?.orderId;
            if (invNum && !logByInvoiceNum.has(invNum)) {
                logByInvoiceNum.set(invNum, log);
            }
        }

        // ── Build invoice list ────────────────────────────────────────────────
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let totalToday = 0;
        let autoApproved = 0;
        let needsApproval = 0;
        let unmatched = 0;
        let totalDollarImpact = 0;

        const invoices: InvoiceQueueItem[] = rows.map(row => {
            const invNum: string = row.invoice_number ?? '';
            const matchedLog = logByInvoiceNum.get(invNum) ?? null;

            const status = resolveStatus(row.status, matchedLog?.action_taken ?? null);
            const dollarImpact = extractDollarImpact(matchedLog?.metadata ?? null);
            const balanceWarning = extractBalanceWarning(matchedLog?.metadata ?? null);

            const processedAt: string = row.created_at ?? new Date().toISOString();
            if (new Date(processedAt) >= todayStart) totalToday++;
            if (status === 'auto_approved') autoApproved++;
            if (status === 'needs_approval') needsApproval++;
            if (status === 'unmatched') unmatched++;
            if (dollarImpact !== null) totalDollarImpact += dollarImpact;

            return {
                id: String(row.id),
                invoiceNumber: invNum,
                vendorName: row.vendor_name ?? 'Unknown',
                total: Number(row.total ?? 0),
                subtotal: Number(row.subtotal ?? 0),
                freight: row.freight !== null ? Number(row.freight) : null,
                tax: row.tax !== null ? Number(row.tax) : null,
                tariff: row.tariff !== null ? Number(row.tariff) : null,
                labor: row.labor !== null ? Number(row.labor) : null,
                status,
                poNumber: row.po_number ?? null,
                processedAt,
                dollarImpact,
                balanceWarning,
            };
        });

        const result: InvoiceQueueResponse = {
            invoices,
            stats: {
                totalToday,
                autoApproved,
                needsApproval,
                unmatched,
                totalDollarImpact,
            },
            cachedAt: new Date().toISOString(),
        };

        cache = result;
        cacheAt = Date.now();

        return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (err: any) {
        console.error('[invoice-queue] GET error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// ── POST — bust cache (e.g., after an action is taken) ───────────────────────

export async function POST(req: NextRequest) {
    // Allow callers to invalidate cache without triggering a new fetch
    cache = null;
    cacheAt = 0;
    return NextResponse.json({ ok: true });
}

// ── CSV Export ────────────────────────────────────────────────────────────────
// Returns rows from ap_activity_log where reconciliation_report IS NOT NULL (last 90 days).
// Columns: date, invoice_number, vendor, invoice_total, po_id, changes_count,
//          auto_approved, balance_ok, warnings
// Used by accounting for compliance audits.

async function handleCsvExport(): Promise<NextResponse> {
    const supabase = createClient();
    if (!supabase) {
        return new NextResponse('Supabase not configured', { status: 503 });
    }

    try {
        const since = new Date();
        since.setDate(since.getDate() - 90);

        const { data, error } = await supabase
            .from('ap_activity_log')
            .select('created_at, reconciliation_report')
            .not('reconciliation_report', 'is', null)
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: false });

        if (error) throw new Error(error.message);

        const rows = data ?? [];

        const headers = [
            'date',
            'invoice_number',
            'vendor',
            'invoice_total',
            'po_id',
            'changes_count',
            'auto_approved',
            'balance_ok',
            'warnings',
        ];

        const csvLines: string[] = [headers.join(',')];

        for (const row of rows) {
            const rpt: any = row.reconciliation_report ?? {};
            const invoice = rpt.invoice ?? {};
            const finalePo = rpt.finale_po ?? {};
            const approval = rpt.approval ?? {};
            const balanceCheck = rpt.balance_check ?? {};
            const changes: any[] = rpt.changes ?? [];
            const warningsList: string[] = rpt.warnings ?? [];

            const changesCount = changes.filter(
                (c: any) => c.disposition !== 'no_change'
            ).length;

            const isAutoApproved =
                approval.method === 'auto' ||
                approval.approved_by === 'system';

            const cells = [
                csvEscape(row.created_at ?? ''),
                csvEscape(invoice.number ?? ''),
                csvEscape(invoice.vendor ?? ''),
                csvEscape(invoice.total != null ? String(invoice.total) : ''),
                csvEscape(finalePo.order_id ?? ''),
                csvEscape(String(changesCount)),
                csvEscape(isAutoApproved ? 'yes' : 'no'),
                csvEscape(balanceCheck.valid === true ? 'yes' : balanceCheck.valid === false ? 'no' : ''),
                csvEscape(warningsList.join(' | ')),
            ];
            csvLines.push(cells.join(','));
        }

        const csv = csvLines.join('\n');
        const dateStr = new Date().toISOString().slice(0, 10);

        return new NextResponse(csv, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="reconciliation-report-${dateStr}.csv"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch (err: any) {
        console.error('[invoice-queue] CSV export error:', err);
        return new NextResponse(`Export failed: ${err.message}`, { status: 500 });
    }
}

function csvEscape(val: any): string {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}
