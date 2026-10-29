/**
 * @file    api/dashboard/receivings/route.ts
 * @purpose Returns Finale received POs enriched with local reconciliation data.
 *          For each received PO, shows: matched invoice, price changes,
 *          freight/tax adjustments, approval status, and invoice-PO match suggestions.
 *
 *          GET  — received POs + reconciliation + match suggestions
 *          POST — actions: complete_po, match_invoice, mark_freight_pattern
 *
 * @updated 2026-07-14 — added 30d window, match suggestions, PO completion, freight learning
 */

import { NextRequest, NextResponse } from 'next/server';
import { FinaleClient } from '@/lib/finale/client';
import { createClient } from '@/lib/db';
import { firstRealInvoice, isPhantomInvoiceRow, isCarrierFreightArchive, invoiceNumberFromAttachment, type InvoicePoolRow } from '@/lib/purchasing/invoice-pool';
import { findPOCandidates, type POCandidate } from '@/lib/purchasing/invoice-po-matcher';
import { sanitizeOcrPoCandidate } from '@/lib/purchasing/ocr-po-sanitize';
import { transitionLifecycleState } from '@/lib/purchasing/po-lifecycle';
import { recordFreightEvidence, markVendorFreightPattern, getVendorFreightClassification, type FreightLearningResult } from '@/lib/purchasing/vendor-freight-learning';
import type { ReceivedPO } from '@/lib/finale/core-client';
import type { ReconciliationResult } from '@/lib/finale/reconciler';
import type { gmail_v1 } from '@googleapis/gmail';
import { loadTrueReceiptQuantities, receiptShorts } from '@/lib/finale/receipt-quantities';
import { isFreightRequiredVendor, freightOnPo } from '@/config/freight-required-vendors';
import { isDeliverAndBillVendor } from '@/lib/purchasing/deliver-bill-vendors';
import { overbillGracePending } from '@/lib/purchasing/overbill-grace';
import { buildReceivingsThreeWay, type ReceivingsThreeWay, type ThreeWayInvoiceLine } from '@/lib/purchasing/receivings-three-way';

// ── GET response cache (paint-first) ─────────────────────────────────────
// HERMIA(2026-08-06): Panel timed out because every GET ran Finale GraphQL
// + up to 12× findPOCandidates + auto-reconcile Finale writes. Cache the
// full JSON for 3 minutes so lifecycle paint is ~ms; bust=1 forces rebuild.
/** One line item on a vendor invoice — raw_data.lineItems or line_items JSONB. */
interface InvoiceLineItem {
    sku?: string | null;
    productId?: string | null;
    partNumber?: string | null;
    description?: string | null;
    qty?: number | null;
    quantity?: number | null;
    unit_price?: number | null;
    ext_price?: number | null;
}

/** The subset of raw_data JSONB this route reads on a vendor_invoices row. */
interface InvoiceRawData {
    lineItems?: InvoiceLineItem[];
    ocrPoCandidate?: string | null;
    poNumber?: string | null;
    orderNumber?: string | null;
    email_from?: unknown;
    email_subject?: unknown;
    source?: string;
}

/** vendor_invoices row as the receivings panel reads it. */
interface VendorInvoiceRow extends InvoicePoolRow {
    id: string;
    vendor_name: string;
    invoice_number: string | null;
    invoice_date: string | null;
    subtotal: number | null;
    freight: number | null;
    tax: number | null;
    total: number | null;
    po_number?: string | null;
    line_items?: string | InvoiceLineItem[] | null;
    raw_data?: InvoiceRawData | null;
}

/** A match-pool invoice: a vendor_invoices row plus local-cache provenance. */
type PoolInvoiceRow = VendorInvoiceRow & { _fromCache?: boolean };

/** A row of the vendor bill pool (queried without a po_number filter). */
interface VendorBillRow {
    po_number: string | null;
    invoice_number: string | null;
    vendor_name: string | null;
    total: number | null;
    line_items: string | InvoiceLineItem[] | null;
}

/** reconciliation_outcomes row for the received POs. */
interface ReconciliationOutcomeRow {
    po_id: string;
    invoice_id: string | null;
    outcome: string;
    created_at: string;
    resolved_at: string | null;
}

/** A bill that can be compared against a delivery (linked invoice or covering bill). */
interface ComparableBill {
    invoice_number?: string | null;
    total?: number | null;
    line_items?: string | InvoiceLineItem[] | null;
}

/** A vendor bill covering lines of a PO it is not itself linked to. */
interface CoveringBill extends ComparableBill {
    invoice_number: string | null;
    total: number;
    line_items: string | InvoiceLineItem[] | null;
}

/** Invoice-vs-delivery comparison stamped on bill-as-they-deliver POs. */
interface InvoiceVsReceipt {
    invoicedTotal: number;
    receivedValue: number;
    invoicedQty: number;
    receivedQty: number;
    overbilled: boolean;
    gracePending?: boolean;
    billed: boolean;
    unmatchedValue?: number;
}

/** Open overbill dispute stamped on the PO it holds. */
interface OverbillDisputeStamp {
    disposition: string;
    status: string;
    delta: number;
    invoicedTotal: number;
    receivedValue: number;
    vendorNotified: boolean;
    vendorDraftId: string | null;
    createdAt: string;
    resolution: string | null;
    balancedNow: boolean;
}

/** overbill_disputes row (open holds for the received POs). */
interface OverbillDisputeRow {
    po_number: string;
    vendor_name: string | null;
    invoice_number: string | null;
    invoiced_total: number | null;
    received_value: number | null;
    delta: number | null;
    status: string;
    disposition: string;
    vendor_notified_at: string | null;
    vendor_draft_id: string | null;
    resolution: string | null;
    created_at: string;
}

/** Reconciliation metadata this route stamps onto each received PO. */
interface ReceiptReconciliation {
    invoices: VendorInvoiceRow[];
    outcomes: ReconciliationOutcomeRow[];
    hasPendingApproval: boolean;
    hasAutoApplied: boolean;
    matchedInvoice: (VendorInvoiceRow & { identityUnknown?: boolean }) | null;
    billingPattern: 'deliver_and_bill' | null;
    vendorHasUnlinkedBills?: boolean;
    coveringBill?: CoveringBill;
    invoiceVsReceipt?: InvoiceVsReceipt;
    overbillDispute?: OverbillDisputeStamp;
    vendorOverbillPattern?: { flagged: number; bills: number };
    /**
     * 3-way verdict (WS4, 2026-10-29): ordered vs received vs billed per line
     * plus a bucketed variance, so the row says READY or names the one thing
     * that differs — instead of "invoice matched" meaning nothing more than
     * "a vendor_invoices row points at this PO".
     */
    threeWay?: ReceivingsThreeWay;
}

/** ReceivedPO as this route consumes it: Finale rows carry the PO reference as
 *  orderId, and every enrichment step stamps reconciliation metadata on. */
type ReceivedPORow = ReceivedPO & {
    poNumber?: string;
    _reconciliation?: ReceiptReconciliation;
};

/** One line item extracted from a bill for the match suggestions. */
type ExtractedLineItem = { sku?: string; qty?: number; description?: string };

/** One invoice row in `matchSuggestions` (rendered by the Receivings panel). */
interface MatchSuggestion {
    invoiceId: string;
    invoiceNumber: string | null;
    vendorName: string;
    invoiceDate: string | null;
    invoiceTotal: number | null;
    candidates: POCandidate[];
    autoApplyReady: boolean;
    fromCache: boolean;
    timedOut?: boolean;
    invoiceLineItems: ExtractedLineItem[] | null;
}

/** ap_activity_log.metadata JSONB keys this route reads. */
interface ApActivityMetadata {
    poNumber?: string;
    orderId?: string;
    invoice?: string;
    invoiceNumber?: string;
    vendorName?: string;
    [key: string]: unknown;
}

/** ap_activity_log row (the reconciliation audit trail). */
interface ApActivityLogRow {
    intent: string;
    created_at: string;
    metadata: ApActivityMetadata | null;
}

/** One row of the recent auto-completions audit trail. */
interface RecentAutoCompletion {
    intent: string;
    poNumber?: string;
    invoiceNumber?: string;
    vendorName?: string;
    createdAt: string;
    metadata?: ApActivityMetadata | null;
}

/** ap_pending_approvals row for the PO being approved. */
interface PendingApprovalRow {
    id: string;
    reconciliation_result: ReconciliationResult | null;
    invoice_number: string | null;
    status: string;
}

/** vendor_invoices row read for the overbill vendor draft. */
interface OverbillInvoiceRow {
    invoice_number: string | null;
    total: number | null;
    raw_data: InvoiceRawData | null;
}

/** The shape `await createClient().from(…).select(…)` resolves to. */
type QueryResult<T> = { data: T | null; error: unknown };

type ReceivingsPayload = {
    received: ReceivedPORow[];
    days: number;
    range: string;
    startDate: string;
    asOf: string;
    matchSuggestions: MatchSuggestion[];
    freightClasses: Record<string, FreightLearningResult>;
    recentAutoCompletions?: RecentAutoCompletion[];
    cachedAt?: string;
    cacheAgeMs?: number;
};
let _getCache: { at: number; key: string; payload: ReceivingsPayload } | null = null;
const GET_CACHE_TTL_MS = 3 * 60 * 1000;
// ────────────────────────────────────────────────────────────────────────────

// ── Concurrency-limited async map ────────────────────────────────────────
/**
 * Maps an array with a bounded number of concurrent async operations.
 * Preserves input order. Replaces unbounded Promise.all(arr.map(fn))
 * which fans out N requests at once. Used for PostgREST loops that are
 * NOT subject to the Finale 500ms global queue (local DB calls only).
 */
async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

export function getDenverWeekStart(date: Date): string {
    const denverNow = new Date(date.toLocaleString('en-US', { timeZone: 'America/Denver' }));
    const day = denverNow.getDay();
    const daysSinceMonday = (day + 6) % 7;
    denverNow.setDate(denverNow.getDate() - daysSinceMonday);
    return denverNow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
}

/** Extract line items from a vendor_invoices row's raw_data or cached line_items. */
function extractLineItems(inv: Pick<VendorInvoiceRow, 'raw_data' | 'line_items'>): ExtractedLineItem[] | null {
    // Try raw_data.lineItems first (OCR extraction)
    const rd = inv.raw_data;
    if (rd?.lineItems && Array.isArray(rd.lineItems) && rd.lineItems.length > 0) {
        return rd.lineItems.map((li) => ({
            sku: li.sku || li.productId || li.partNumber || undefined,
            qty: li.qty ?? li.quantity ?? undefined,
            description: li.description || undefined,
        }));
    }
    // Fall back to cached line_items JSON string (from invoice_cache)
    if (inv.line_items) {
        try {
            const parsed: unknown = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : inv.line_items;
            if (Array.isArray(parsed) && parsed.length > 0) {
                return (parsed as InvoiceLineItem[]).map((li) => ({
                    sku: li.sku || li.productId || undefined,
                    qty: li.qty ?? li.quantity ?? undefined,
                    description: li.description || undefined,
                }));
            }
        } catch { /* not JSON */ }
    }
    return null;
}

/**
 * Parse `vendor_invoices.line_items` (OCR JSONB or JSON string) into the shape
 * the 3-way stamp needs. Read-only — never re-OCR and never fetch Finale.
 */
function invoiceLinesForThreeWay(
    inv: Pick<VendorInvoiceRow, 'line_items'> | null | undefined,
): ThreeWayInvoiceLine[] {
    if (!inv?.line_items) return [];
    let parsed: unknown = inv.line_items;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(parsed)) return [];
    const out: ThreeWayInvoiceLine[] = [];
    for (const raw of parsed as InvoiceLineItem[]) {
        const qty = Number(raw?.qty ?? raw?.quantity ?? 0);
        const unitPrice = Number(raw?.unit_price ?? 0);
        const extPrice = raw?.ext_price === null || raw?.ext_price === undefined
            ? null
            : Number(raw.ext_price);
        out.push({
            sku: raw?.sku ?? null,
            productId: raw?.productId ?? null,
            description: raw?.description ?? null,
            qty: Number.isFinite(qty) ? qty : 0,
            unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
            extPrice: extPrice !== null && Number.isFinite(extPrice) ? extPrice : null,
        });
    }
    return out;
}

export async function GET(req: NextRequest) {
    // ── Outer guard: the route MUST NEVER hang the socket ──
    // HERMIA(2026-08-06): Dropped 45s → 20s. Panel paint budget is ~5–8s;
    // anything longer feels like a timeout. Prefer cached payload over hang.
    const ROUTE_TIMEOUT_MS = 20_000;
    try {
        const payload = await Promise.race([
            handleGET(req),
            new Promise<NextResponse>((_, reject) =>
                setTimeout(() => reject(new Error(`Receivings route timed out (${ROUTE_TIMEOUT_MS / 1000}s)`)), ROUTE_TIMEOUT_MS),
            ),
        ]);
        return payload;
    } catch (outerErr: unknown) {
        const outerMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        console.warn('[receivings] Route guard caught hang — returning graceful error:', outerMsg);
        // Serve stale cache if we have one rather than empty skeleton
        if (_getCache?.payload?.received?.length) {
            const age = Date.now() - _getCache.at;
            return NextResponse.json({
                ..._getCache.payload,
                stale: true,
                cacheAgeMs: age,
                message: 'Serving cached receivings after timeout',
            }, { headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'stale-on-timeout' } });
        }
        return NextResponse.json({
            error: 'finale_timeout',
            message: 'Receivings data temporarily unavailable — Finale rate-limited',
            received: [],
            days: 30,
            range: 'error',
            startDate: '',
            asOf: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' }),
            matchSuggestions: [],
            freightClasses: {},
            recentAutoCompletions: [],
        });
    }
}

async function handleGET(req: NextRequest): Promise<NextResponse> {
    try {
        const { searchParams } = new URL(req.url);
        const daysParam = searchParams.get('days');
        const matchInvoiceId = searchParams.get('match_invoice');
        const bust = searchParams.has('bust');

        const now = new Date();
        const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const DEFAULT_RECEIVINGS_DAYS = 30;
        const startStr = daysParam
            ? (() => {
                const days = parseInt(daysParam, 10);
                const start = new Date(now);
                start.setDate(start.getDate() - days);
                return start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            })()
            : (() => {
                const start = new Date(now);
                start.setDate(start.getDate() - DEFAULT_RECEIVINGS_DAYS);
                return start.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
            })();

        const cacheKey = `${startStr}|${todayStr}|${matchInvoiceId || ''}`;
        if (!bust && _getCache && _getCache.key === cacheKey && (Date.now() - _getCache.at) < GET_CACHE_TTL_MS) {
            const age = Date.now() - _getCache.at;
            return NextResponse.json(
                { ..._getCache.payload, cachedAt: new Date(_getCache.at).toISOString(), cacheAgeMs: age },
                { headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'hit' } },
            );
        }

        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

        const finale = new FinaleClient();
        // Finale receivings can hang 60s+ under load — fail open so the panel paints.
        // NOTE(2026-07-27): getTodaysReceivedPOs no longer uses a soft timeout at all.
        // Shipment enrichment on the request path is CACHE-ONLY (synchronous Map
        // lookups, zero network I/O), with cold shipment detail fetched by a bounded
        // single-flight background warm-up. See the DECISION block in receivings.ts.
        // Consequence: base GraphQL POs always return promptly even when Finale is
        // rate-limited, and there is no enrichment race left to tune here.
        let received: ReceivedPORow[] = [];
        try {
            // Soft budget: GraphQL must not eat the whole route timeout.
            received = await Promise.race([
                finale.getTodaysReceivedPOs(startStr, tomorrowStr),
                new Promise<ReceivedPORow[]>((_, reject) =>
                    setTimeout(() => reject(new Error('getTodaysReceivedPOs soft budget 12s')), 12_000),
                ),
            ]);
        } catch (finaleErr: unknown) {
            const finaleMsg = finaleErr instanceof Error ? finaleErr.message : String(finaleErr);
            console.warn('[receivings] Finale getTodaysReceivedPOs failed/timeout:', finaleMsg);
            // Prefer stale received list over empty if cache has one
            if (_getCache?.payload?.received?.length) {
                received = _getCache.payload.received;
            } else {
                received = [];
            }
        }

        // Enrich with reconciliation data from local Postgres
        const sb = createClient();
        if (sb && received.length > 0) {
            const poNumbers = received
                .map((r) => r.poNumber || r.orderId)
                .filter(Boolean);

            if (poNumbers.length > 0) {
                const { data: invoices } = (await sb
                    .from('vendor_invoices')
                    .select('po_number, invoice_number, subtotal, freight, tax, total, status, created_at, id, pdf_storage_path, source_ref, line_items')
                    .in('po_number', poNumbers)
                    .order('created_at', { ascending: false })) as QueryResult<VendorInvoiceRow[]>;

                const { data: outcomes } = (await sb
                    .from('reconciliation_outcomes')
                    .select('po_id, invoice_id, outcome, outcome_meta, created_at, resolved_at')
                    .in('po_id', poNumbers)
                    .order('created_at', { ascending: false })) as QueryResult<ReconciliationOutcomeRow[]>;

                const invoiceMap = new Map<string, VendorInvoiceRow[]>();
                for (const inv of (invoices || [])) {
                    // Carrier freight archives never satisfy a goods bill. Phantom
                    // rows (OCR "error" identity) STAY in the map — a row with real
                    // money is a real bill whose OCR identity failed, and the row
                    // must name it rather than say "awaiting vendor invoice".
                    if (isCarrierFreightArchive(inv)) continue;
                    const key = inv.po_number;
                    if (!invoiceMap.has(key)) invoiceMap.set(key, []);
                    invoiceMap.get(key)!.push(inv);
                }

                const outcomeMap = new Map<string, ReconciliationOutcomeRow[]>();
                for (const oc of (outcomes || [])) {
                    const key = oc.po_id;
                    if (!outcomeMap.has(key)) outcomeMap.set(key, []);
                    outcomeMap.get(key)!.push(oc);
                }

                for (const po of received) {
                    const poNum = po.poNumber || po.orderId;
                    // Invoice leg selection (2026-10-29): a row whose total is
                    // zero is a real document with an unreadable amount, NOT a
                    // bill that satisfies the leg. Letting it through made PO
                    // 125378 (Novelty) and 125331 (Intl Molasses) read as
                    // "matched, $0" instead of "amount unknown, review".
                    // Prefer a positive-total sibling when one exists; else keep
                    // the zero-total row but flag identityUnknown so the panel
                    // says so. If every row is phantom-NAMED but one carries
                    // real money, surface that one with identityUnknown too —
                    // the panel must name the bill rather than "awaiting vendor
                    // invoice".
                    const rows = invoiceMap.get(poNum) || [];
                    const real = firstRealInvoice(rows);
                    const positiveRows = rows
                        .filter((r) => !isPhantomInvoiceRow(r) && Number(r.total || 0) > 0)
                        .sort((a, b) => Number(b.total) - Number(a.total));
                    const moneyRow = rows
                        .filter((r) => Number(r.total || 0) > 1)
                        .sort((a, b) => Number(b.total) - Number(a.total))[0] ?? null;
                    const realTotal = Number(real?.total || 0);
                    const matchedInvoice = real && realTotal > 0
                        ? real
                        : positiveRows[0]
                            ?? (real
                                ? { ...real, identityUnknown: true }
                                : moneyRow
                                    ? { ...moneyRow, identityUnknown: true }
                                    : null);
                    po._reconciliation = {
                        invoices: rows,
                        outcomes: outcomeMap.get(poNum) || [],
                        hasPendingApproval: (outcomeMap.get(poNum) || []).some(
                            (o) => o.outcome === 'pending_approval' && !o.resolved_at
                        ),
                        hasAutoApplied: (outcomeMap.get(poNum) || []).some(
                            (o) => o.outcome === 'auto_applied'
                        ),
                        matchedInvoice,
                        // Vendors that bill per delivery (2026-10-28): the
                        // panel must treat a partial receipt as the normal
                        // shape and compare the bill to the DELIVERY, not to
                        // the whole PO.
                        billingPattern: isDeliverAndBillVendor(po.supplier) ? "deliver_and_bill" : null,
                    };
                }

                // ── 3-way verdict (WS4, 2026-10-29) ──────────────────────────
                // Every received PO with a matched bill gets ordered vs received
                // vs billed per line plus a bucketed variance. BULK DATA ONLY:
                // `po.items` already carries unitPrice from the bulk GraphQL
                // query and the matched invoice carries its OCR lines — a
                // per-PO getOrderDetails here would queue on Finale's 500ms
                // serial interval and the 20s route guard would drop the whole
                // enrichment. Pure CPU, no I/O.
                for (const po of received) {
                    const rec = po._reconciliation;
                    if (!rec?.matchedInvoice) continue;
                    try {
                        const items = (po.items || []).map((it) => ({
                            productId: String(it.productId || ""),
                            orderedQty: Number(it.orderedQuantity ?? it.quantity ?? 0),
                            receivedQty:
                                it.receivedQuantity === undefined || it.receivedQuantity === null
                                    ? null
                                    : Number(it.receivedQuantity),
                            unitPrice: Number(it.unitPrice ?? 0),
                        }));
                        // Finale has no freight field on a PO: freight = total − subtotal.
                        const poFreight =
                            po.subtotal !== null && po.subtotal !== undefined && Number(po.subtotal) > 0
                                ? Number(po.total || 0) - Number(po.subtotal)
                                : null;
                        rec.threeWay = buildReceivingsThreeWay({
                            orderId: String(po.orderId),
                            items,
                            invoiceLines: invoiceLinesForThreeWay(rec.matchedInvoice),
                            invoice: {
                                freight: rec.matchedInvoice.freight,
                                tax: rec.matchedInvoice.tax,
                                total: rec.matchedInvoice.total,
                            },
                            poFreight,
                            hasReceipt: Boolean(po.receiveDate || (po.receiptHistory?.length ?? 0) > 0),
                        });
                    } catch (twErr: unknown) {
                        // Never let one bad row blank the panel; the absence of a
                        // stamp is honest, a fabricated verdict is not.
                        const msg = twErr instanceof Error ? twErr.message : String(twErr);
                        console.warn(`[receivings] 3-way stamp failed for ${po.orderId}: ${msg}`);
                    }
                }
            }

            // ── Match suggestions: find unmatched invoices for received PO vendors ──
            const vendorNames = [...new Set(received.map((r) => r.supplier).filter(Boolean))] as string[];
            const matchSuggestions: MatchSuggestion[] = [];

            if (vendorNames.length > 0) {
                let unmatchedInvoices: PoolInvoiceRow[] = [];
                try {
                    const { data } = (await sb
                        .from('vendor_invoices')
                        .select('id, invoice_number, vendor_name, invoice_date, subtotal, freight, tax, total, raw_data, source, source_ref')
                        .is('po_number', null)
                        .in('vendor_name', vendorNames)
                        .order('created_at', { ascending: false })
                        .limit(40)) as QueryResult<PoolInvoiceRow[]>;
                    unmatchedInvoices = data || [];
                } catch (fetchErr: unknown) {
                    const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                    console.warn(`[receivings] Failed to fetch unmatched invoices: ${fetchMsg}`);
                    unmatchedInvoices = [];
                }
                unmatchedInvoices = unmatchedInvoices.filter(
                    (i) => !isPhantomInvoiceRow(i) && !isCarrierFreightArchive(i),
                );

                // Local invoice_cache fallback when PostgREST is empty/down (photo invoices etc.)
                try {
                    const { getUnmatchedInvoices, getInvoiceCacheByVendor } = await import(
                        '@/lib/storage/purchasing-cache'
                    );
                    const localUnmatched = getUnmatchedInvoices();
                    const seen = new Set(
                        unmatchedInvoices.map(
                            (i) =>
                                `${(i.vendor_name || '').toLowerCase()}|${i.invoice_number || ''}|${i.total || 0}`,
                        ),
                    );
                    for (const v of vendorNames) {
                        const rows = [
                            ...localUnmatched.filter((r) =>
                                (r.vendor_name || '').toLowerCase().includes(String(v).toLowerCase().slice(0, 12)),
                            ),
                            ...getInvoiceCacheByVendor(v).filter((r) => !r.matched_po && !r.po_number),
                        ];
                        for (const row of rows) {
                            if (isPhantomInvoiceRow(row)) continue;
                            const key = `${(row.vendor_name || '').toLowerCase()}|${row.invoice_number || ''}|${row.total || 0}`;
                            if (seen.has(key)) continue;
                            // Only skip confirmed matches — OCR may set po_number as candidate
                            if (row.matched_po) continue;
                            seen.add(key);
                            const invoiceNumber = invoiceNumberFromAttachment(row.vendor_invoice_id, row.invoice_number);
                            const ocrPo = sanitizeOcrPoCandidate(row.po_number);
                            unmatchedInvoices.push({
                                id: row.vendor_invoice_id || key,
                                invoice_number: invoiceNumber,
                                vendor_name: row.vendor_name,
                                invoice_date: row.invoice_date,
                                subtotal: row.total || 0,
                                freight: row.freight || 0,
                                tax: row.tax || 0,
                                total: row.total || 0,
                                raw_data: {
                                    lineItems: (() => {
                                        try {
                                            return JSON.parse(row.line_items || '[]') as InvoiceLineItem[];
                                        } catch {
                                            return [];
                                        }
                                    })(),
                                    source: 'invoice_cache',
                                    ocrPoCandidate: ocrPo,
                                },
                                _fromCache: true,
                            });
                        }
                    }
                    // Also surface DTE / recent AP photo invoices even if vendor name on PO differs slightly
                    for (const row of localUnmatched.slice(0, 30)) {
                        const key = `${(row.vendor_name || '').toLowerCase()}|${row.invoice_number || ''}|${row.total || 0}`;
                        if (seen.has(key)) continue;
                        if (row.matched_po) continue;
                        seen.add(key);
                            const invoiceNumber = invoiceNumberFromAttachment(row.vendor_invoice_id, row.invoice_number);
                            const ocrPo = sanitizeOcrPoCandidate(row.po_number);
                            unmatchedInvoices.push({
                                id: row.vendor_invoice_id || key,
                                invoice_number: invoiceNumber,
                                vendor_name: row.vendor_name,
                                invoice_date: row.invoice_date,
                                subtotal: row.total || 0,
                                freight: row.freight || 0,
                                tax: row.tax || 0,
                                total: row.total || 0,
                                raw_data: {
                                    source: 'invoice_cache',
                                    ocrPoCandidate: ocrPo,
                                },
                                _fromCache: true,
                            });
                    }
                } catch (cacheErr: unknown) {
                    const cacheMsg = cacheErr instanceof Error ? cacheErr.message : String(cacheErr);
                    console.warn('[receivings] invoice_cache fallback failed:', cacheMsg);
                }

                const recoveredNumbers = unmatchedInvoices.map((i) => i.invoice_number).filter(Boolean);
                if (recoveredNumbers.length > 0) {
                    const { data: alreadyLinked } = (await sb
                        .from('vendor_invoices')
                        .select('invoice_number')
                        .in('invoice_number', recoveredNumbers)
                        .not('po_number', 'is', null)) as QueryResult<Array<{ invoice_number: string | null }>>;
                    const linked = new Set((alreadyLinked || []).map((r) => r.invoice_number));
                    unmatchedInvoices = unmatchedInvoices.filter((i) => !linked.has(i.invoice_number));
                }

                if (unmatchedInvoices && unmatchedInvoices.length > 0) {
                                    // HERMIA(2026-08-06): Drop junk invoices before scoring
                                    unmatchedInvoices = unmatchedInvoices.filter((inv) => {
                                        const total = Number(inv.total || 0);
                                        const invNo = String(inv.invoice_number || "").trim();
                                        if (total < 1 && !invNo) return false;
                                        if (total < 1) return false; // $0 placeholders
                                        return true;
                                    });
                                }

                                if (unmatchedInvoices && unmatchedInvoices.length > 0) {
                                    // HERMIA(2026-08-06): Paint budget. Was 12×4s sequential-ish scoring
                                    // + Finale auto-reconcile on GET → 45s panel timeouts.
                                    // Cap hard: 6 invoices, 2s each, concurrency 4. NO writes on GET.
                                    const toScore = unmatchedInvoices.slice(0, 6);
                                    // Drop dropship-flow invoices before scoring (vendor keyword or known patterns)
                                    const { classifyInvoice } = await import('@/config/invoice-classification');
                                    const filteredToScore = toScore.filter((inv) => {
                                        const cls = classifyInvoice({
                                            vendorName: inv.vendor_name,
                                            poNumber: inv.raw_data?.ocrPoCandidate || inv.po_number || null,
                                        });
                                        return cls.classification !== 'dropship_flow_through';
                                    });
                                    // Prefer filtered list
                                    const scoreList = filteredToScore; // always use filtered (may be empty)

                                    // ── Phase A: score all invoices in parallel (read-only, concurrency 4) ──
                                    // DECISION(2026-07-27): Previously this loop scored up to 12 invoices
                                    // sequentially against 4s findPOCandidates timeouts (~48s worst case).
                                    // Now scoring runs in parallel at concurrency 4.
                                    // HERMIA(2026-08-06): Phase B Finale auto-apply REMOVED from GET.
                                    // GET is paint-only. Auto-match writes belong on POST/cron.
                                    const scoredResults = await mapConcurrent(scoreList, 4, async (inv) => {
                                        // OCR short-circuit: no DB call needed — still never offer dropship POs
                                        const ocrPo = sanitizeOcrPoCandidate(inv.raw_data?.ocrPoCandidate || inv.po_number || null);
                                        if (inv._fromCache && ocrPo) {
                                            return {
                                                inv,
                                                status: 'ocr' as const,
                                                ocrSuggestion: {
                                                    invoiceId: inv.id,
                                                    invoiceNumber: inv.invoice_number,
                                                    vendorName: inv.vendor_name,
                                                    invoiceDate: inv.invoice_date,
                                                    invoiceTotal: inv.total,
                                                    candidates: [{
                                                        orderId: String(ocrPo),
                                                        vendorName: inv.vendor_name,
                                                        orderDate: inv.invoice_date || '',
                                                        total: Number(inv.total || 0),
                                                        status: 'ocr_candidate',
                                                        score: 70,
                                                        reasons: ['OCR PO# candidate'],
                                                        isOpen: true,
                                                    } satisfies POCandidate],
                                                    autoApplyReady: false,
                                                    fromCache: true,
                                                    invoiceLineItems: extractLineItems(inv),
                                                },
                                            };
                                        }
                                        try {
                                            const scorePromise = findPOCandidates({
                                                id: inv.id,
                                                invoiceNumber: inv.invoice_number,
                                                vendorName: inv.vendor_name,
                                                invoiceDate: inv.invoice_date,
                                                subtotal: Number(inv.subtotal || 0),
                                                freight: Number(inv.freight || 0),
                                                tax: Number(inv.tax || 0),
                                                total: Number(inv.total || 0),
                                                lineItems: inv.raw_data?.lineItems || [],
                                                ocrPoCandidate: inv.raw_data?.ocrPoCandidate || inv.raw_data?.poNumber || null,
                                                ocrOrderCandidate: inv.raw_data?.orderNumber || null,
                                            });
                                            const result = await Promise.race([
                                                scorePromise,
                                                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
                                            ]);
                                            if (!result) {
                                                return { inv, status: 'timed_out' as const };
                                            }
                                            return { inv, status: 'scored' as const, result };
                                        } catch (err: unknown) {
                                            return { inv, status: 'error' as const, err };
                                        }
                                    });

                                    // ── Phase B: suggestions only (NO Finale writes on GET) ──
                                    for (const sr of scoredResults) {
                                        const { inv } = sr;
                                        if (sr.status === 'ocr' && sr.ocrSuggestion) {
                                            // Never offer dropship POs as OCR match targets
                                            const ocrCands = (sr.ocrSuggestion.candidates || []).filter(
                                                (c) => !/DropshipPO/i.test(String(c.orderId || '')),
                                            );
                                            if (ocrCands.length === 0) continue;
                                            matchSuggestions.push({ ...sr.ocrSuggestion, candidates: ocrCands });
                                            continue;
                                        }
                                        if (sr.status === 'timed_out') {
                                            matchSuggestions.push({
                                                invoiceId: inv.id,
                                                invoiceNumber: inv.invoice_number,
                                                vendorName: inv.vendor_name,
                                                invoiceDate: inv.invoice_date,
                                                invoiceTotal: inv.total,
                                                candidates: [],
                                                autoApplyReady: false,
                                                fromCache: !!inv._fromCache,
                                                timedOut: true,
                                                invoiceLineItems: extractLineItems(inv),
                                            });
                                            continue;
                                        }
                                        if (sr.status === 'error') {
                                            const scoreMsg = sr.err instanceof Error ? sr.err.message : String(sr.err);
                                            console.warn(`[receivings] Match scoring failed for invoice: ${scoreMsg}`);
                                            continue;
                                        }

                                        // Scored successfully — surface suggestions only
                                        const result = sr.result!;
                                        // Strip dropship POs from candidates — never match those
                                        result.candidates = (result.candidates || []).filter(
                                            (c) => !/DropshipPO/i.test(String(c.orderId || '')),
                                        );
                                        result.bestMatch = result.candidates[0] || null;
                                        if (result.autoApplyReady && result.bestMatch && /DropshipPO/i.test(result.bestMatch.orderId || '')) {
                                            result.autoApplyReady = false;
                                        }
                                        matchSuggestions.push({
                                            invoiceId: inv.id,
                                            invoiceNumber: inv.invoice_number,
                                            vendorName: inv.vendor_name,
                                            invoiceDate: inv.invoice_date,
                                            invoiceTotal: inv.total,
                                            candidates: result.candidates.slice(0, 5),
                                            autoApplyReady: result.autoApplyReady ?? false,
                                            fromCache: !!inv._fromCache,
                                            invoiceLineItems: extractLineItems(inv),
                                        });
                                    }
                                }
                            }

                            // ── Unlinked-bill presence (2026-10-27) ──────────────────
                            // A received PO whose vendor has bills sitting in AP
                            // with no PO link is NOT "awaiting vendor invoice" —
                            // the bill arrived, it just is not linked yet. The
                            // matchSuggestions list is exactly those bills, so
                            // stamp each PO from it (case-insensitive; vendor
                            // spellings drift: ULINE vs Uline).
                            const unlinkedVendors = new Set(
                                matchSuggestions.map((m) => String(m.vendorName || "").toLowerCase()).filter(Boolean),
                            );
                            for (const po of received) {
                                const v = String(po.supplier || "").toLowerCase();
                                if (!v) continue;
                                const hit =
                                    unlinkedVendors.has(v) ||
                                    [...unlinkedVendors].some(
                                        (u) => (v.length >= 8 && u.includes(v)) || (u.length >= 8 && v.includes(u)),
                                    );
                                po._reconciliation.vendorHasUnlinkedBills = hit;
                            }

                            // ── Vendor bill pool + covering-bill detection (2026-10-27) ──
                            // Some vendors (Miles) email ONE bill per delivery batch that
                            // covers lines on SEVERAL POs, but vendor_invoices.po_number is
                            // a single scalar, so the bill is linked to only one PO. Every
                            // sibling PO must still name the bill. Match each bill line to
                            // this PO's items by quantity (ordered OR received) AND unit
                            // price; one hit means the bill covers this PO.
                            const poolCutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
                            const poolOrFilter = vendorNames.map((v) => `vendor_name.ilike.*${v}*`).join(",");
                            let vendorBillRows: VendorBillRow[] = [];
                            try {
                                const { data: billRows } = (await sb
                                    .from("vendor_invoices")
                                    .select("po_number, invoice_number, vendor_name, total, line_items")
                                    .or(poolOrFilter)
                                    .gte("created_at", poolCutoff)
                                    .order("created_at", { ascending: false })
                                    .limit(300)) as QueryResult<VendorBillRow[]>;
                                vendorBillRows = billRows || [];
                            } catch (poolErr: unknown) {
                                const poolMsg = poolErr instanceof Error ? poolErr.message : String(poolErr);
                                console.warn(`[receivings] vendor bill pool failed: ${poolMsg}`);
                            }
                            // Rows linked to a received PO regardless of vendor name:
                            // the OCR "error" vendor on the Miles bill never matches an
                            // ilike filter, but the PO link is exactly the identity that
                            // makes it a candidate for that vendor's sibling POs.
                            try {
                                const { data: linkedRows } = (await sb
                                    .from("vendor_invoices")
                                    .select("po_number, invoice_number, vendor_name, total, line_items")
                                    .in("po_number", received.map((r) => r.poNumber || r.orderId).filter(Boolean))
                                    .gte("created_at", poolCutoff)
                                    .order("created_at", { ascending: false })
                                    .limit(300)) as QueryResult<VendorBillRow[]>;
                                vendorBillRows = vendorBillRows.concat(linkedRows || []);
                            } catch (linkedErr: unknown) {
                                const linkedMsg = linkedErr instanceof Error ? linkedErr.message : String(linkedErr);
                                console.warn(`[receivings] linked bill pool failed: ${linkedMsg}`);
                            }

                            const billPoolByVendor = new Map<string, VendorBillRow[]>();
                            for (const row of vendorBillRows) {
                                const rv = String(row.vendor_name || "").toLowerCase().trim();
                                if (!rv) continue;
                                if (!billPoolByVendor.has(rv)) billPoolByVendor.set(rv, []);
                                billPoolByVendor.get(rv)!.push(row);
                            }

                            // Linked rows whose OCR vendor name is junk ("error") can
                            // only be found through the PO they ARE linked to. A bill
                            // linked to one PO of a vendor covers that vendor's sibling
                            // POs when its lines match theirs.
                            const supplierByPo = new Map<string, string>();
                            for (const r of received) {
                                supplierByPo.set(String(r.orderId), String(r.supplier || ""));
                            }

                            for (const po of received) {
                                const rec = po._reconciliation;
                                if (rec?.matchedInvoice) continue; // bill already named on this row
                                const v = String(po.supplier || "").toLowerCase().trim();
                                if (!v) continue;
                                const pool: VendorBillRow[] = [];
                                for (const row of vendorBillRows) {
                                    const linkedPo = String(row.po_number || "");
                                    const linkedSupplier = supplierByPo.get(linkedPo) || "";
                                    if (linkedPo && linkedPo !== String(po.orderId) && linkedSupplier === po.supplier) {
                                        pool.push(row); // sibling PO bill of the same supplier
                                    }
                                }
                                const vendorRows = billPoolByVendor.get(v) || [];
                                pool.push(...vendorRows);
                                if (pool.length === 0) {
                                    for (const [pv, rows] of billPoolByVendor) {
                                        if ((v.length >= 8 && pv.includes(v)) || (pv.length >= 8 && v.includes(pv))) {
                                            pool.push(...rows);
                                        }
                                    }
                                }
                                if (pool.length === 0) continue;

                                const items = (po.items || []).map((it) => ({
                                    ordered: Number(it.orderedQuantity ?? it.quantity ?? 0),
                                    received: it.receivedQuantity !== undefined ? Number(it.receivedQuantity) : null,
                                    unitPrice: Number(it.unitPrice ?? 0),
                                }));

                                let coveringBill: CoveringBill | null = null;
                                for (const row of pool) {
                                    let lines: InvoiceLineItem[] = [];
                                    try {
                                        const parsed: unknown =
                                            typeof row.line_items === "string" ? JSON.parse(row.line_items) : row.line_items;
                                        lines = Array.isArray(parsed) ? (parsed as InvoiceLineItem[]) : [];
                                    } catch { /* not JSON */ }
                                    let hits = 0;
                                    for (const line of lines) {
                                        const q = Number(line?.qty ?? line?.quantity ?? 0);
                                        if (!(q > 0)) continue;
                                        const up = Number(line?.unit_price ?? 0);
                                        const hit = items.some((it) => {
                                            const qtyMatch = q === it.ordered || (it.received !== null && q === it.received);
                                            const priceMatch = up > 0 ? Math.abs(up - it.unitPrice) < 0.01 : true;
                                            return qtyMatch && priceMatch;
                                        });
                                        if (hit) hits++;
                                    }
                                    if (hits > 0) {
                                        coveringBill = {
                                            invoice_number: row.invoice_number ?? null,
                                            total: Number(row.total || 0),
                                            // Keep the lines — invoice-vs-delivery attribution
                                            // needs them to slice this PO's share of the bill.
                                            line_items: row.line_items ?? null,
                                        };
                                        break;
                                    }
                                }
                                if (coveringBill) rec.coveringBill = coveringBill;
                            }

                            // ── Invoice-vs-delivery comparison (2026-10-28) ──
                            // For bill-as-they-deliver vendors the review that
                            // matters is NOT invoice-vs-PO — it is invoice-vs-
                            // what actually arrived. Bill: invoices "almost
                            // always over bill us a complete PO". Stamp the
                            // comparison so the panel flags an overbill the
                            // moment the bill and the receipt are both known.
                            //
                            // ATTRIBUTION RULE (verified against the 10/27
                            // Miles delivery): one bill can cover several POs.
                            // Comparing the WHOLE bill against ONE PO's
                            // receipts manufactures a false "exceeds delivery"
                            // on every sibling (125415 $2,688 vs $1,344).
                            // Compare only the bill lines that MATCH this PO's
                            // items (ordered or received qty + unit price) —
                            // the rest of the bill belongs to sibling POs.
                            for (const po of received) {
                                const rec = po._reconciliation;
                                if (!rec || !isDeliverAndBillVendor(po.supplier)) continue;
                                const bills: ComparableBill[] = [];
                                if (rec.matchedInvoice) bills.push(rec.matchedInvoice);
                                if (
                                    rec.coveringBill &&
                                    (!rec.matchedInvoice ||
                                        String(rec.coveringBill.invoice_number) !== String(rec.matchedInvoice.invoice_number))
                                ) {
                                    bills.push(rec.coveringBill);
                                }
                                const seenTotals = new Set<number>();
                                const dedup = bills.filter((b) => {
                                    const t = Number(b?.total || 0);
                                    if (!t || seenTotals.has(t)) return false;
                                    seenTotals.add(t);
                                    return true;
                                });
                                const billLines: Array<{ qty: number; unit_price: number; ext_price: number }> = [];
                                for (const b of dedup) {
                                    let lines: InvoiceLineItem[] = [];
                                    try {
                                        const parsed: unknown =
                                            typeof b?.line_items === "string" ? JSON.parse(b.line_items) : b?.line_items;
                                        lines = Array.isArray(parsed) ? (parsed as InvoiceLineItem[]) : [];
                                    } catch { /* not JSON */ }
                                    for (const l of lines) {
                                        const q = Number(l?.qty ?? l?.quantity ?? 0);
                                        if (!(q > 0)) continue;
                                        const up = Number(l?.unit_price ?? 0);
                                        billLines.push({
                                            qty: q,
                                            unit_price: up,
                                            ext_price: Number(l?.ext_price ?? 0) || q * up,
                                        });
                                    }
                                }

                                const items = (po.items || []).map((it) => ({
                                    ordered: Number(it.orderedQuantity ?? it.quantity ?? 0),
                                    received: it.receivedQuantity !== undefined ? Number(it.receivedQuantity) : null,
                                    unitPrice: Number(it.unitPrice ?? 0),
                                }));

                                let coveredValue = 0;
                                let coveredQty = 0;
                                for (const line of billLines) {
                                    const hit = items.some((it) => {
                                        const qtyMatch =
                                            line.qty === it.ordered || (it.received !== null && line.qty === it.received);
                                        const priceMatch =
                                            line.unit_price > 0 ? Math.abs(line.unit_price - it.unitPrice) < 0.01 : true;
                                        return qtyMatch && priceMatch;
                                    });
                                    if (hit) {
                                        coveredValue += line.ext_price;
                                        coveredQty += line.qty;
                                    }
                                }

                                // A bill with NO usable line items cannot be
                                // attributed — assume the linked bill belongs
                                // wholly to the PO it is linked to.
                                if (billLines.length === 0 && rec.matchedInvoice) {
                                    coveredValue = Number(rec.matchedInvoice.total || 0);
                                }

                                let receivedQty = 0;
                                let receivedValue = 0;
                                for (const it of po.items || []) {
                                    const rc = it.receivedQuantity;
                                    if (rc === undefined || rc === null) continue;
                                    receivedQty += Number(rc);
                                    receivedValue += Number(rc) * Number(it.unitPrice ?? 0);
                                }
                                receivedValue = Math.round(receivedValue * 100) / 100;
                                coveredValue = Math.round(coveredValue * 100) / 100;
                                const rawOverbilled =
                                    coveredValue > 0 && receivedValue > 0 && coveredValue > receivedValue * 1.05 + 5;
                                // Same-day grace (2026-10-28): the receipt is
                                // stamped today — the delivery day has not
                                // settled. Show the comparison softly; the
                                // hard flag waits for tomorrow.
                                const grace = rawOverbilled && overbillGracePending(po.receiveDateTime || po.receiveDate);
                                rec.invoiceVsReceipt = {
                                    invoicedTotal: coveredValue,
                                    receivedValue,
                                    invoicedQty: coveredQty,
                                    receivedQty,
                                    overbilled: rawOverbilled && !grace,
                                    gracePending: rawOverbilled && grace,
                                    billed: coveredValue > 0,
                                };
                            }

                            // ── Batch-level unmatched-line check (2026-10-28) ──
                            // A bill line that matches NO received PO of the
                            // vendor is the true rogue line — billed something
                            // nobody received. Stamp it on the row that carries
                            // the matched invoice so the review lands on the
                            // bill, not on a guessing sibling.
                            for (const po of received) {
                                const rec = po._reconciliation;
                                if (!rec || !isDeliverAndBillVendor(po.supplier) || !rec.matchedInvoice) continue;
                                const vendor = String(po.supplier || "").toLowerCase();
                                const vendorPos = received.filter(
                                    (p) => String(p.supplier || "").toLowerCase() === vendor,
                                );
                                let lines: InvoiceLineItem[] = [];
                                try {
                                    const parsed: unknown =
                                        typeof rec.matchedInvoice?.line_items === "string"
                                            ? JSON.parse(rec.matchedInvoice.line_items)
                                            : rec.matchedInvoice?.line_items;
                                    lines = Array.isArray(parsed) ? (parsed as InvoiceLineItem[]) : [];
                                } catch { /* not JSON */ }
                                let unmatchedValue = 0;
                                for (const l of lines) {
                                    const q = Number(l?.qty ?? l?.quantity ?? 0);
                                    if (!(q > 0)) continue;
                                    const up = Number(l?.unit_price ?? 0);
                                    const ev = Number(l?.ext_price ?? 0) || q * up;
                                    const hit = vendorPos.some((p) =>
                                        (p.items || []).some((it) => {
                                            const ordered = Number(it.orderedQuantity ?? it.quantity ?? 0);
                                            const received =
                                                it.receivedQuantity !== undefined ? Number(it.receivedQuantity) : null;
                                            const qtyMatch = q === ordered || (received !== null && q === received);
                                            const priceMatch =
                                                up > 0 ? Math.abs(up - Number(it.unitPrice ?? 0)) < 0.01 : true;
                                            return qtyMatch && priceMatch;
                                        }),
                                    );
                                    if (!hit) unmatchedValue += ev;
                                }
                                if (unmatchedValue > 5) {
                                    rec.invoiceVsReceipt = {
                                        ...(rec.invoiceVsReceipt || {
                                            invoicedTotal: 0,
                                            receivedValue: 0,
                                            invoicedQty: 0,
                                            receivedQty: 0,
                                            overbilled: false,
                                            billed: false,
                                        }),
                                        unmatchedValue: Math.round(unmatchedValue * 100) / 100,
                                    };
                                }
                            }

                            // ── Open overbill disputes (2026-10-28) ──
                            // Bill's flow: he does NOT enter an overbill. He
                            // drafts the vendor an email and pays only for what
                            // was delivered. The dispute row keeps that state
                            // until the credit or revised invoice lands.
                            try {
                                const { data: disputes } = (await sb
                                    .from('overbill_disputes')
                                    .select(
                                        'po_number, vendor_name, invoice_number, invoiced_total, received_value, delta, status, disposition, vendor_notified_at, vendor_draft_id, resolution, created_at',
                                    )
                                    .in('po_number', poNumbers)
                                    .eq('status', 'open')
                                    .order('created_at', { ascending: false })
                                    .limit(100)) as QueryResult<OverbillDisputeRow[]>;
                                for (const row of disputes || []) {
                                    const po = received.find(
                                        (p) => String(p.poNumber || p.orderId) === String(row.po_number),
                                    );
                                    if (!po) continue;
                                    const rec = po._reconciliation;
                                    const ivr = rec?.invoiceVsReceipt;
                                    rec.overbillDispute = {
                                        disposition: row.disposition,
                                        status: row.status,
                                        delta: Number(row.delta || 0),
                                        invoicedTotal: Number(row.invoiced_total || 0),
                                        receivedValue: Number(row.received_value || 0),
                                        vendorNotified: !!row.vendor_notified_at,
                                        vendorDraftId: row.vendor_draft_id || null,
                                        createdAt: row.created_at,
                                        resolution: row.resolution,
                                        // The receipts now cover the bill — safe to resolve.
                                        balancedNow: !!ivr && !ivr.overbilled,
                                    };
                                }
                            } catch (dispErr: unknown) {
                                const dispMsg = dispErr instanceof Error ? dispErr.message : String(dispErr);
                                console.warn(`[receivings] overbill dispute query failed: ${dispMsg}`);
                            }

                            // ── Vendor overbill pattern (2026-10-28) ──
                            // These vendors overbill repeatedly. Show the
                            // pattern itself on their rows: N holds in the
                            // last 90 days against M bills in the last 60.
                            try {
                                const patternVendors = vendorNames.filter((v) => isDeliverAndBillVendor(v));
                                if (patternVendors.length > 0) {
                                    const [disputeRes, billRes] = await Promise.all([
                                        sb
                                            .from('overbill_disputes')
                                            .select('vendor_name')
                                            .gte('created_at', new Date(Date.now() - 90 * 86400 * 1000).toISOString())
                                            .in('vendor_name', patternVendors)
                                            .limit(200),
                                        sb
                                            .from('vendor_invoices')
                                            .select('vendor_name')
                                            .gte('created_at', new Date(Date.now() - 90 * 86400 * 1000).toISOString())
                                            .in('vendor_name', patternVendors)
                                            .limit(500),
                                    ]);
                                    const flagCount = new Map<string, number>();
                                    for (const r of (disputeRes.data || []) as Array<{ vendor_name?: unknown }>) {
                                        const v = String(r.vendor_name || '');
                                        if (v) flagCount.set(v, (flagCount.get(v) || 0) + 1);
                                    }
                                    const billCount = new Map<string, number>();
                                    for (const r of (billRes.data || []) as Array<{ vendor_name?: unknown }>) {
                                        const v = String(r.vendor_name || '');
                                        if (v) billCount.set(v, (billCount.get(v) || 0) + 1);
                                    }
                                    for (const po of received) {
                                        if (!isDeliverAndBillVendor(po.supplier)) continue;
                                        const flagged = flagCount.get(po.supplier) || 0;
                                        const bills = billCount.get(po.supplier) || 0;
                                        if (flagged > 0) {
                                            const rec = po._reconciliation as
                                                | { vendorOverbillPattern?: { flagged: number; bills: number } }
                                                | undefined;
                                            if (rec) {
                                                rec.vendorOverbillPattern = {
                                                    flagged,
                                                    bills,
                                                };
                                            }
                                        }
                                    }
                                }
                            } catch (patErr: unknown) {
                                const msg = patErr instanceof Error ? patErr.message : String(patErr);
                                console.warn(`[receivings] vendor overbill pattern failed: ${msg}`);
                            }

            // ── Recent auto-completions (audit trail for auto-processed) ──
            let recentAutoCompletions: RecentAutoCompletion[] = [];
            try {
                const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString(); // 30 days
                const { data: activityLog } = (await sb
                    .from('ap_activity_log')
                    .select('intent, created_at, metadata')
                    .in('intent', ['RECONCILIATION_AUTO_APPLIED', 'RECONCILIATION_ERROR'])
                    .gte('created_at', cutoff)
                    .order('created_at', { ascending: false })
                    .limit(20)) as QueryResult<ApActivityLogRow[]>;
                if (activityLog) {
                    recentAutoCompletions = activityLog.map((row) => ({
                        intent: row.intent,
                        poNumber: row.metadata?.poNumber || row.metadata?.orderId || '',
                        invoiceNumber: row.metadata?.invoice || row.metadata?.invoiceNumber || '',
                        vendorName: row.metadata?.vendorName || '',
                        createdAt: row.created_at,
                        metadata: row.metadata,
                    }));
                }
            } catch (completionsErr: unknown) {
                const completionsMsg =
                    completionsErr instanceof Error ? completionsErr.message : String(completionsErr);
                console.warn(`[receivings] Failed to fetch recent auto-completions: ${completionsMsg}`);
            }

            // ── Freight classifications for received PO vendors ──
                        // DECISION(2026-07-27): This loop was 40 sequential ~2.2s PostgREST
                        // round-trips and is now bounded-parallel at 8. These are local-DB
                        // calls (PostgREST on port 3000), NOT subject to the Finale 500ms
                        // global queue, so real parallelism is achieved here.
                        // HERMIA(2026-08-06): Cap to 12 vendors — full list was burning paint budget.
                        const freightClasses: Record<string, FreightLearningResult> = {};
                        const vendorsForFreight = vendorNames.slice(0, 12);
                        const fcResults = await mapConcurrent(vendorsForFreight, 8, async (v) => {
                            try {
                                const result = await Promise.race([
                                    getVendorFreightClassification(v),
                                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
                                ]);
                                return { vendor: v, result };
                            } catch (fcErr: unknown) {
                                const fcMsg = fcErr instanceof Error ? fcErr.message : String(fcErr);
                                console.warn(`[receivings] Freight classification failed for ${v}: ${fcMsg}`);
                                return { vendor: v, result: undefined };
                            }
                        });
                        for (const fr of fcResults) {
                            if (fr.result !== undefined && fr.result !== null) {
                                freightClasses[fr.vendor] = fr.result;
                            }
                        }

                        const payload: ReceivingsPayload = {
                            received,
                            days: daysParam ? parseInt(daysParam, 10) : DEFAULT_RECEIVINGS_DAYS,
                            range: daysParam ? 'rolling_days' : 'rolling_30d',
                            startDate: startStr,
                            asOf: todayStr,
                            matchSuggestions,
                            freightClasses,
                            recentAutoCompletions,
                        };
                        // A payload with no received quantities is a cold
                        // shipment cache (boot or quiet period). Cache it only
                        // 60s — the background warm-up fills quantities within
                        // ~50s and the next poll must paint them, not replay
                        // "unknown" for 3 minutes.
                        const hasAnyReceivedQty = (received || []).some((p) =>
                            (p.items || []).some((i) => i.receivedQuantity !== undefined),
                        );
                        const cacheAt = hasAnyReceivedQty ? Date.now() : Date.now() - (GET_CACHE_TTL_MS - 60_000);
                        _getCache = { at: cacheAt, key: cacheKey, payload };
                        if (!hasAnyReceivedQty) {
                            console.log("[receivings] cold shipment cache — serving with 60s cache, warm-up in flight");
                        }
                        return NextResponse.json(payload, {
                            headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'miss' },
                        });
                    }

                    const emptyPayload: ReceivingsPayload = {
                        received,
                        days: daysParam ? parseInt(daysParam, 10) : DEFAULT_RECEIVINGS_DAYS,
                        range: daysParam ? 'rolling_days' : 'rolling_30d',
                        startDate: startStr,
                        asOf: todayStr,
                        matchSuggestions: [],
                        freightClasses: {},
                    };
                    _getCache = { at: Date.now(), key: cacheKey, payload: emptyPayload };
                    return NextResponse.json(emptyPayload, {
                        headers: { 'Cache-Control': 'no-store', 'X-Receivings-Cache': 'miss-empty' },
                    });
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.error('Receivings API error:', message);
                    return NextResponse.json({ error: message }, { status: 500 });
                }
            }

// ── POST: Complete PO, match invoice, mark freight pattern ──────────────────

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { action } = body;

        if (action === 'approve_reconciliation') {
            const { orderId, invoiceId } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

            const sb = createClient();
            if (!sb) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

            const now = new Date().toISOString();

            // ── HERMIA(2026-07-29): 3-way match enforcement ─────────────────
            // This handler previously flipped ap_pending_approvals,
            // reconciliation_outcomes, invoices and vendor_invoices to
            // 'approved'/'reconciled' and returned ok:true — WITHOUT ever
            // contacting Finale and without comparing the three documents.
            // Every click wrote a false "reconciled" state: the DB claimed the
            // corrections had posted while Finale never received them.
            //
            // Correct AP order of operations is now enforced:
            //   1. Load the stored reconciliation for this PO.
            //   2. Push the approved price/freight changes to Finale FIRST.
            //   3. Only if Finale accepts the write, record 'reconciled' in the DB.
            // A failure at step 2 returns 4xx/5xx so the operator sees it,
            // instead of a green tick over an unposted correction.
            const { data: approval } = (await sb
                .from('ap_pending_approvals')
                .select('id, reconciliation_result, invoice_number, status')
                .eq('order_id', orderId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()) as QueryResult<PendingApprovalRow>;

            const reconciliationResult = approval?.reconciliation_result;

            if (!reconciliationResult) {
                // Nothing to post. Refuse rather than mark the PO reconciled.
                return NextResponse.json(
                    {
                        error: 'No reconciliation on file for this PO',
                        detail:
                            `No stored reconciliation_result was found for ${orderId}, so there is ` +
                            `nothing to push to Finale. Re-run the AP match for this PO before approving.`,
                        orderId,
                        applied: false,
                    },
                    { status: 409 },
                );
            }

            // Step 2: post to Finale BEFORE claiming success anywhere.
            let appliedCount = 0;
            try {
                const { applyReconciliation } = await import('@/lib/finale/reconciler');
                const finaleClient = new FinaleClient();
                const applyResult = await applyReconciliation(reconciliationResult, finaleClient);
                appliedCount = applyResult.applied.length;

                if (applyResult.errors.length > 0) {
                    return NextResponse.json(
                        {
                            error: 'Finale rejected part of the reconciliation',
                            detail: applyResult.errors.join('; '),
                            orderId,
                            applied: false,
                            appliedCount,
                        },
                        { status: 502 },
                    );
                }
            } catch (err: unknown) {
                const applyMsg = err instanceof Error ? err.message : String(err);
                console.error(`[receivings/approve] Finale apply failed for ${orderId}:`, applyMsg);
                return NextResponse.json(
                    {
                        error: 'Failed to apply reconciliation to Finale',
                        detail: applyMsg,
                        orderId,
                        applied: false,
                    },
                    { status: 502 },
                );
            }

            // Step 3: Finale accepted the write — now it is true to say reconciled.
            const approvalId = approval?.id;
            if (approvalId) {
                await sb
                    .from('ap_pending_approvals')
                    .update({ status: 'approved', resolved_at: now })
                    .eq('id', approvalId);
            } else if (invoiceId) {
                await sb
                    .from('ap_pending_approvals')
                    .update({ status: 'approved', resolved_at: now })
                    .eq('order_id', orderId)
                    .eq('invoice_number', invoiceId);
            } else {
                await sb
                    .from('ap_pending_approvals')
                    .update({ status: 'approved', resolved_at: now })
                    .eq('order_id', orderId);
            }

            // Update reconciliation_outcomes
            await sb
                .from('reconciliation_outcomes')
                .update({ outcome: 'approved', resolved_at: now })
                .eq('po_id', orderId)
                .is('resolved_at', null);

            // Update invoices status
            await sb
                .from('invoices')
                .update({ status: 'reconciled', updated_at: now })
                .eq('po_number', orderId);

            // Update vendor_invoices status
            await sb
                .from('vendor_invoices')
                .update({ status: 'reconciled', updated_at: now })
                .eq('po_number', orderId);

            // Transition lifecycle state
            const { transitionLifecycleState } = await import('@/lib/purchasing/po-lifecycle');
            await transitionLifecycleState(
                orderId,
                'RECONCILED',
                'dashboard-receivings',
                { invoiceId: invoiceId || null, approvedAt: now, appliedCount },
            );

            return NextResponse.json({ ok: true, orderId, reconciled: true, applied: true, appliedCount });
        }

        if (action === 'complete_po') {
            const { orderId, vendorName, hadFreightOnPO, invoiceFreight, freightMatched } = body;
            if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });

            // ── Receipt gate (2026-10-27) ──────────────────────────────────
            // Complete is a financial close. It must never fire on a PO whose
            // goods have not all arrived. Read the true per-SKU receipt from
            // Finale shipment details right now; a real short refuses with 409.
            // Billed-upfront vendors are NOT exempt: their bill already covers
            // the whole PO, so completing while goods are short is exactly the
            // mistake this gate exists to stop.
            const receipt = await loadTrueReceiptQuantities(orderId);
            if (!receipt) {
                return NextResponse.json(
                    { error: 'Could not read shipment receipts for this PO — not completing', orderId },
                    { status: 502 },
                );
            }
            const shorts = receiptShorts(receipt);
            if (shorts.length > 0) {
                const detail = shorts
                    .map((s) => `${s.sku} ${s.received}/${s.ordered} short ${s.short}`)
                    .join(' · ');
                console.warn(`[receivings] complete_po refused for ${orderId}: ${detail}`);
                return NextResponse.json(
                    { error: `Goods not all received — ${detail}`, orderId, shorts },
                    { status: 409 },
                );
            }

            // ── Freight gate (2026-10-28) ───────────────────────────────────
            // Truck-freight vendors (Rootwise, Uline, Garys, International
            // Molasses, Lind Marine...) must have their freight ON the PO
            // before the PO closes: "just as invoice aligns, freight should
            // align as well" — vendor-charged or carrier-added. Finale is the
            // truth: freight on PO = order total − goods subtotal.
            if (isFreightRequiredVendor(vendorName)) {
                const freightNow = freightOnPo(receipt.total, receipt.subtotal);
                if (freightNow <= 0.5) {
                    console.warn(`[receivings] complete_po refused for ${orderId}: freight not on PO (${vendorName})`);
                    return NextResponse.json(
                        { error: 'Freight not on PO — add trucking freight before completing', orderId, freightNow },
                        { status: 409 },
                    );
                }
            }

            const finale = new FinaleClient();
            const result = await finale.completeOrder(orderId);
            const finalStatus = result?.finalStatus || 'ORDER_COMPLETED';

            // Record freight evidence for learning
            await recordFreightEvidence({
                orderId,
                vendorName: vendorName || '',
                hadFreightOnPO: hadFreightOnPO || false,
                invoiceFreight: invoiceFreight || 0,
                freightMatched: freightMatched || false,
                completedBy: 'dashboard',
            });

            // Invalidate caches so Active Purchases drops this PO
            const { invalidatePurchasingCaches } = await import('@/lib/purchasing/cache');
            await invalidatePurchasingCaches();

            return NextResponse.json({ completed: true, orderId, finalStatus });
        }

        if (action === 'match_invoice') {
            const { invoiceId, poNumber } = body;
            if (!invoiceId || !poNumber) {
                return NextResponse.json({ error: 'invoiceId and poNumber required' }, { status: 400 });
            }

            const sb = createClient();
            if (!sb) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

            await sb
                .from('vendor_invoices')
                .update({ po_number: poNumber })
                .eq('id', invoiceId);

            await transitionLifecycleState(poNumber, 'INVOICED', 'dashboard-receivings', { invoiceId });

            return NextResponse.json({ matched: true, invoiceId, poNumber });
        }

        if (action === 'mark_freight_pattern') {
            const { vendorName, pattern } = body;
            if (!vendorName || !pattern) {
                return NextResponse.json({ error: 'vendorName and pattern required' }, { status: 400 });
            }

            await markVendorFreightPattern(vendorName, pattern);

            return NextResponse.json({ marked: true, vendorName, pattern });
        }

        if (action === 'overbill_disposition') {
            const { orderId, disposition } = body;
            if (!orderId || !['draft_vendor', 'resolve'].includes(disposition)) {
                return NextResponse.json(
                    { error: 'orderId and disposition (draft_vendor | resolve) required' },
                    { status: 400 },
                );
            }
            const sb = createClient();
            if (!sb) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

            const { recordOverbillDispute, resolveOverbillDispute, overbillDraftBody } = await import(
                '@/lib/purchasing/overbill-dispute'
            );

            if (disposition === 'resolve') {
                const resolution = body.resolution || 'credit or revised invoice received';
                const { resolved, error } = await resolveOverbillDispute(sb, orderId, resolution);
                if (error) return NextResponse.json({ error }, { status: 500 });
                await sb.from('ap_activity_log').insert({
                    intent: 'OVERBILL_RESOLVED',
                    created_at: new Date().toISOString(),
                    metadata: { poNumber: orderId, resolution },
                });
                return NextResponse.json({ resolved, orderId });
            }

            // draft_vendor: Bill's process — hold the bill, draft the vendor
            // email (never sent) so the vendor gets a chance to correct, and
            // enter payment only for what was delivered.
            const { data: invRows } = (await sb
                .from('vendor_invoices')
                .select('invoice_number, total, raw_data')
                .eq('po_number', orderId)
                .order('created_at', { ascending: false })
                .limit(1)) as QueryResult<OverbillInvoiceRow[]>;
            const inv = (invRows || [])[0] || null;
            const invoicedTotal = Number(body.invoicedTotal ?? inv?.total ?? 0);
            const receivedValue = Number(body.receivedValue ?? 0);
            const delta = Math.round((Math.max(0, invoicedTotal - receivedValue)) * 100) / 100;
            if (!(delta > 0)) {
                return NextResponse.json({ error: 'No positive delta to dispute' }, { status: 400 });
            }

            const rec = await recordOverbillDispute(sb, {
                poNumber: orderId,
                vendorName: body.vendorName ?? null,
                invoiceNumber: inv?.invoice_number ?? null,
                invoicedTotal,
                receivedValue,
                delta,
                receivedQtySum: body.receivedQty != null ? Number(body.receivedQty) : null,
            });
            if ('error' in rec) return NextResponse.json({ error: rec.error }, { status: 500 });

            // ── Gmail draft (draft-only, never sent) ────────────────────────
            let draftCreated = false;
            let draftId: string | null = null;
            let draftSubject = '';
            try {
                const rd: InvoiceRawData = inv?.raw_data || {};
                const rawFrom = typeof rd.email_from === 'string' ? String(rd.email_from) : '';
                const to = (rawFrom.match(/<([^>]+)>/) || [])[1] || (rawFrom.includes('@') ? rawFrom : null);
                const origSubject = typeof rd.email_subject === 'string' ? String(rd.email_subject) : '';
                const { getAuthenticatedClient } = await import('@/lib/gmail/auth');
                const { gmail: GmailApi } = await import('@googleapis/gmail');
                const auth = await getAuthenticatedClient('default');
                // googleapis declares the entry point as a factory function, but the
                // runtime object is the API constructor and this call has always used
                // `new` (which is what binds `this` for the endpoint context).
                const GmailApiCtor = GmailApi as unknown as new (options: gmail_v1.Options) => gmail_v1.Gmail;
                const gmail = new GmailApiCtor({ auth, version: 'v1' });
                const text = overbillDraftBody();
                draftSubject = `Re: ${origSubject || `Invoice ${inv?.invoice_number || ''}`.trim() || `PO ${orderId}`}`;
                const headers = [
                    'From: bill.selee@buildasoil.com',
                    to ? `To: ${to}` : '',
                    `Subject: ${draftSubject}`,
                    'MIME-Version: 1.0',
                    'Content-Type: text/plain; charset=UTF-8',
                ]
                    .filter(Boolean)
                    .join('\r\n');
                const raw = Buffer.from(`${headers}\r\n\r\n${text}`, 'utf8').toString('base64url');
                let threadId: string | undefined;
                if (to) {
                    try {
                        const domain = to.split('@')[1];
                        const q = `from:${domain} subject:"${origSubject.slice(0, 40)}"`;
                        const { data: threads } = await gmail.users.threads.list({ userId: 'me', q, maxResults: 3 });
                        threadId = threads?.threads?.[0]?.id ?? undefined;
                    } catch { /* thread lookup best-effort */ }
                }
                const draft = await gmail.users.drafts.create({
                    userId: 'me',
                    requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
                });
                draftId = draft.data.id ?? null;
                draftCreated = !!draftId;
                if (draftCreated) {
                    await sb
                        .from('overbill_disputes')
                        .update({
                            vendor_notified_at: new Date().toISOString(),
                            vendor_draft_id: draftId,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('po_number', orderId)
                        .eq('status', 'open');
                }
            } catch (draftErr: unknown) {
                const draftMsg = draftErr instanceof Error ? draftErr.message : String(draftErr);
                console.warn(`[receivings] overbill vendor draft failed for ${orderId}: ${draftMsg}`);
            }

            await sb.from('ap_activity_log').insert({
                intent: 'OVERBILL_HELD',
                created_at: new Date().toISOString(),
                metadata: { poNumber: orderId, invoicedTotal, receivedValue, delta, draftCreated },
            });
            return NextResponse.json({ held: true, orderId, delta, draftCreated, draftId, draftSubject });
        }

        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Receivings POST error:', message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
