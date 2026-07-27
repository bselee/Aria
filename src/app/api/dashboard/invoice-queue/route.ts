/**
 * @file    route.ts
 * @purpose Dashboard Invoice Queue API — returns recent AP-processed invoices with stats.
 *          GET:  returns invoices + stats (60-second module-level cache, bust with ?bust=1)
 *          POST: /api/dashboard/invoice-queue/export handled via the export sub-route.
 *                This route also handles ?export=1 to return CSV for download.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/db';
import { KNOWN_DROPSHIP_KEYWORDS } from '@/config/dropship-vendors';
import { classifyInvoice, type InvoiceClassification } from '@/config/invoice-classification';
import { resolveStatus, isPendingStatus, type ResolvedStatus } from './resolve-status';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InvoiceQueueItem = {
    id: string;
    activityLogId: string | null;
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
    invoiceDate: string | null;
    dueDate: string | null;
    ocrPoCandidate: string | null;
    ocrOrderCandidate: string | null;
    lastMatchStatus: string | null;
    processedAt: string;
    dollarImpact: number | null;
    balanceWarning: string | null;
    metadata: Record<string, unknown> | null;
    classification: InvoiceClassification;
    classificationReason: string | null;
    sourceInbox: string | null;
};

export type InvoiceQueueStats = {
    totalToday: number;
    autoApproved: number;
    needsApproval: number;
    unmatched: number;
    matchedUnreconciled: number;
    totalDollarImpact: number;
};

export type InvoiceQueueResponse = {
  invoices: InvoiceQueueItem[];
  stats: InvoiceQueueStats;
  needsEyes: {
    missingPdf: number;
    humanInteraction: number;
  };
  cachedAt: string;
};

// ── Module-level cache ────────────────────────────────────────────────────────

let cache: InvoiceQueueResponse | null = null;
let cacheAt = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    const sortByDollar = req.nextUrl.searchParams.get('sort') === 'dollar';

    // ── CSV Export ────────────────────────────────────────────────────────────
    if (wantCsv) {
        return handleCsvExport();
    }

    // ── Cache check ───────────────────────────────────────────────────────────
    // Sort param always busts cache because sort mode affects the response shape
    if (sortByDollar) {
        cache = null;
        cacheAt = 0;
    }
    if (!bust && cache && Date.now() - cacheAt < CACHE_TTL) {
        return NextResponse.json(cache, { headers: { 'Cache-Control': 'no-store' } });
    }

    const db = createClient();
    if (!db) {
        return NextResponse.json(
            { error: 'Supabase not configured' },
            { status: 503 }
        );
    }

    try {
        // ── Fetch invoices ordered newest-first (default) or by total DESC ────
        let query = db
            .from('invoices')
            .select(
                'id, invoice_number, vendor_name, total, subtotal, freight, tax, tariff, labor, status, po_number, created_at, invoice_date, due_date, discrepancies, no_po_required'
            );

        if (sortByDollar) {
            query = query.order('total', { ascending: false });
        } else {
            query = query.order('created_at', { ascending: false });
        }

        const { data: invoicesRaw, error: invErr } = await query.limit(100);

        if (invErr) throw new Error(invErr.message);

        const rows: any[] = invoicesRaw ?? [];

        // ── Requires-PO filter: vendors flagged requires_po=false never
        //    appear as unmatched (service vendors like AAA Cooper, Culligan,
        //    Terminix — they don't need PO matching).
        const { data: vendorProfiles } = await db
            .from('vendor_profiles')
            .select('vendor_name')
            .eq('requires_po', false);
        const noPoVendorNames: string[] = (vendorProfiles ?? []).map((vp: any) => vp.vendor_name);

        // ── Vendor invoices lookup: source_inbox + OCR PO candidates + last-match
        //    We join by invoice_number+vendor_name across all vendor_invoices matching
        //    the vendors in our result set.
        const vendorNamesInSet = [...new Set(rows.map((r: any) => r.vendor_name).filter(Boolean))];
        const { data: viRows } = vendorNamesInSet.length > 0
            ? await db
                .from('vendor_invoices')
                .select('vendor_name, invoice_number, source_inbox, raw_data, reconciled_at, po_number')
                .in('vendor_name', vendorNamesInSet)
            : { data: [] };
        const sourceInboxByKey = new Map<string, string>();
        const ocrPoByKey = new Map<string, string>();
        const ocrOrderByKey = new Map<string, string>();
        for (const vi of viRows ?? []) {
            const key = normalizeName(vi.vendor_name) + '|' + (vi.invoice_number ?? '');
            if (!sourceInboxByKey.has(key) && vi.source_inbox) {
                sourceInboxByKey.set(key, vi.source_inbox);
            }
            // Extract OCR PO candidates from raw_data (poNumber / orderNumber)
            const raw = vi.raw_data as Record<string, unknown> | null;
            if (raw) {
                const pn = raw.poNumber as string | undefined;
                if (pn && !ocrPoByKey.has(key)) ocrPoByKey.set(key, String(pn));
                const on = raw.orderNumber as string | undefined;
                if (on && !ocrOrderByKey.has(key)) ocrOrderByKey.set(key, String(on));
            }
        }

        // ── Last-matched per vendor (vendor confidence signal)
        //    Fetch the most recent reconciled invoice per vendor where a PO was matched.
        const { data: lastMatchedRows } = vendorNamesInSet.length > 0
            ? await db
                .from('vendor_invoices')
                .select('vendor_name, reconciled_at')
                .not('po_number', 'is', null)
                .not('reconciled_at', 'is', null)
                .in('vendor_name', vendorNamesInSet)
                .order('reconciled_at', { ascending: false })
            : { data: [] };
        const lastMatchByVendor = new Map<string, string>();
        for (const lm of lastMatchedRows ?? []) {
            const normVendor = normalizeName(lm.vendor_name);
            if (!lastMatchByVendor.has(normVendor)) {
                // Format as compact date like "Jun 22" or store ISO — format in panel
                const d = lm.reconciled_at ? new Date(lm.reconciled_at) : null;
                lastMatchByVendor.set(
                    normVendor,
                    d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'unknown'
                );
            }
        }

        // ── Fetch the most recent ap_activity_log entry per invoice ───────────
        // We join by invoice_number matching email_subject (the reconciler logs
        // include the invoice number in the subject or metadata). Since there is no
        // FK between the tables, we fetch the last 200 log rows and index them by
        // invoice number extracted from metadata.invoiceNumber.
        const { data: logRaw } = await db
            .from('ap_activity_log')
            .select('id, created_at, email_subject, action_taken, reviewed_at, reviewed_action, metadata, intent')
            .in('intent', ['INVOICE', 'RECONCILIATION', 'HUMAN_INTERACTION', 'HUMAN_INTERACT', 'EYES_NEEDED'])
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
        let matchedUnreconciled = 0;
        let totalDollarImpact = 0;

        const invoices: InvoiceQueueItem[] = rows.flatMap(row => {
            const vendorName = row.vendor_name ?? 'Unknown';
            const fromEmail = row.email_from ?? '';
            const subject = row.email_subject ?? '';

            // Use the unified classification module — single source of truth
            const classResult = classifyInvoice({
                vendorName,
                fromEmail,
                subject,
                poNumber: row.po_number,
            });

            // Dropship flow-through invoices never appear in the queue
            if (classResult.classification === 'dropship_flow_through') {
                return [];
            }
            // Disregarded invoices (marked "not a PO purchase" by a human) are excluded
            if (row.no_po_required === true) {
                return [];
            }
            // Service vendors (requires_po=false) don't need PO matching —
            // filter out their unmatched invoices from the queue
            if (!row.po_number && isNoPoVendor(vendorName, noPoVendorNames)) {
                return [];
            }
            const invNum: string = row.invoice_number ?? '';
            const matchedLog = logByInvoiceNum.get(invNum) ?? null;
            const reviewedAction = (matchedLog?.reviewed_action ?? "").toLowerCase();

            if (reviewedAction === "dismissed" || reviewedAction === "approved" || reviewedAction === "rejected") {
                return [];
            }

            const status = resolveStatus(row.status, matchedLog?.action_taken ?? null, matchedLog?.metadata, row.po_number);
            const dollarImpact = extractDollarImpact(matchedLog?.metadata ?? null);
            const balanceWarning = extractBalanceWarning(matchedLog?.metadata ?? null);

            const hasActivityLog = !!matchedLog?.id;
            // Items with no activity log can't be acted on — demote needs_approval/short_shipment to unmatched
            const resolvedStatus = hasActivityLog ? status : (isPendingStatus(status) ? 'unmatched' : status);

            // Filter items that can't be acted on (no activityLogId for needs_approval or short_shipment_hold)
            if (isPendingStatus(resolvedStatus) && !hasActivityLog) {
                return [];
            }

            const processedAt: string = row.created_at ?? new Date().toISOString();

            // Look up source_inbox from vendor_invoices (ap vs bill.selee)
            const sourceInboxKey = normalizeName(vendorName) + '|' + invNum;
            const sourceInbox = sourceInboxByKey.get(sourceInboxKey) ?? null;
            const ocrPoCandidate = ocrPoByKey.get(sourceInboxKey) ?? null;
            const ocrOrderCandidate = ocrOrderByKey.get(sourceInboxKey) ?? null;
            const lastMatch = lastMatchByVendor.get(normalizeName(vendorName)) ?? null;

            // Only count stats for items that actually appear in the queue
            if (new Date(processedAt) >= todayStart) totalToday++;
            if (resolvedStatus === 'auto_approved') autoApproved++;
            if (isPendingStatus(resolvedStatus)) needsApproval++;
            if (resolvedStatus === 'unmatched') unmatched++;
            if (resolvedStatus === 'matched_unreconciled') matchedUnreconciled++;
            if (dollarImpact !== null) totalDollarImpact += dollarImpact;

            return [{
                            id: String(row.id),
                            activityLogId: hasActivityLog ? String(matchedLog.id) : null,
                            invoiceNumber: invNum,
                            vendorName,
                            total: Number(row.total ?? 0),
                            subtotal: Number(row.subtotal ?? 0),
                            freight: row.freight !== null ? Number(row.freight) : null,
                            tax: row.tax !== null ? Number(row.tax) : null,
                            tariff: row.tariff !== null ? Number(row.tariff) : null,
                            labor: row.labor !== null ? Number(row.labor) : null,
                            status: resolvedStatus,
                            poNumber: row.po_number ?? null,
                            invoiceDate: row.invoice_date ?? null,
                            dueDate: row.due_date ?? null,
                            ocrPoCandidate,
                            ocrOrderCandidate,
                            lastMatchStatus: lastMatch,
                            processedAt,
                            dollarImpact,
                            balanceWarning,
                            metadata: hasActivityLog ? (matchedLog?.metadata ?? null) : null,
                            classification: classResult.classification,
                            classificationReason: classResult.reason,
                            sourceInbox,
                        }];
        });

        // ── Sort: ap@ unmatched first (real exceptions), then high-dollar first ──
        invoices.sort((a, b) => {
            // source_inbox='ap' comes before null/other
            const aPriority = a.sourceInbox === 'ap' ? 0 : 1;
            const bPriority = b.sourceInbox === 'ap' ? 0 : 1;
            if (aPriority !== bPriority) return aPriority - bPriority;
            // Within each group descending total
            return b.total - a.total;
        });

        const needsEyes = {
          missingPdf: 0,
          humanInteraction: 0,
        };

        for (const log of logRaw ?? []) {
          const reasonCode = log.metadata?.reasonCode;
          if (reasonCode === "missing_pdf_manual_review") needsEyes.missingPdf++;
          if (reasonCode === "human_interaction_manual_review") needsEyes.humanInteraction++;
        }

        const result: InvoiceQueueResponse = {
          invoices,
          stats: {
            totalToday,
            autoApproved,
            needsApproval,
            unmatched,
            matchedUnreconciled,
            totalDollarImpact,
          },
          needsEyes,
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
    const db = createClient();
    if (!db) {
        return new NextResponse('Supabase not configured', { status: 503 });
    }

    try {
        const since = new Date();
        since.setDate(since.getDate() - 90);

        const { data, error } = await db
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

// ── Vendor name helpers (requires_po filter) ──────────────────────────────────

/**
 * Normalize a vendor name for comparison: lowercase, collapse whitespace,
 * strip unicode typographic symbols.
 */
function normalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[\r\n]+/g, ' ')
        .replace(/[™®©]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check whether an invoice vendor name matches any of the known
 * requires_po=false vendor profiles. Uses substring matching on
 * normalized names so "AAA COOPER TRANSPORTATION" matches
 * "aaa cooper", "AAA Cooper Transportation", etc.
 */
function isNoPoVendor(
    invoiceVendorName: string,
    noPoVendorNames: string[],
): boolean {
    const normInvoice = normalizeName(invoiceVendorName);
    for (const vp of noPoVendorNames) {
        const normVp = normalizeName(vp);
        // Both directions: short profile name like "aaa cooper" is a substring
        // of "aaa cooper transportation", but also handle exact/close matches
        if (normInvoice.includes(normVp) || normVp.includes(normInvoice)) {
            return true;
        }
    }
    return false;
}
