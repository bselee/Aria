/**
 * @file    route.ts
 * @purpose PO Document Ledger API — returns the complete document trail for a PO
 *          from the unified po_document_ledger VIEW. Supports single-PO lookup
 *          (?po=) and vendor-wide listing (?vendor=&limit=).
 * @deps    @/lib/db (createClient), NextResponse
 * @created 2026-07-24
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LedgerEntry {
  poNumber: string;
  vendorName: string | null;
  docType: string;
  docRef: string;
  amount: number;
  status: string;
  occurredAt: string;
  sourceTable: string;
  sourceId: string;
  detail: Record<string, unknown> | null;
}

export interface LedgerSummary {
  poNumber: string;
  vendorName: string | null;
  docCounts: Record<string, number>;
  totalInvoiced: number;
  latestActivity: string | null;
  documentCount: number;
}

export type PoLedgerResponse = {
  poNumber: string;
  vendorName: string | null;
  documents: LedgerEntry[];
  summary: LedgerSummary;
};

export type VendorLedgerResponse = {
  vendor: string;
  poNumbers: string[];
  documents: LedgerEntry[];
  totalDocuments: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize PO number to canonical form for lookup.
 * Mirrors normalizePoString() in shipment-intelligence.ts.
 */
function normalizePo(po: string): string {
  return po
    .trim()
    .toUpperCase()
    .replace(/^(PO[\s-]?|ORDER[\s-]?|#)/i, '')
    .trim();
}

/**
 * Map snake_case row from PostgREST to camelCase LedgerEntry.
 */
function rowToEntry(row: any): LedgerEntry {
  return {
    poNumber: row.po_number ?? '',
    vendorName: row.vendor_name ?? null,
    docType: row.doc_type ?? '',
    docRef: row.doc_ref ?? '',
    amount: Number(row.amount ?? 0),
    status: row.status ?? '',
    occurredAt: row.occurred_at ?? '',
    sourceTable: row.source_table ?? '',
    sourceId: String(row.source_id ?? ''),
    detail: (row.detail as Record<string, unknown>) ?? null,
  };
}

/**
 * Build summary object from a list of entries for a single PO.
 *
 * NOTE(2026-07-24): totalInvoiced deliberately deduplicates by (docRef,
 * amount) rather than summing every financial-doc-type row. The ledger
 * VIEW unions invoices / paid_invoices / vendor_invoices — three
 * different eras/snapshots of the SAME underlying invoice as it moves
 * through its lifecycle (e.g. invoice #9441610 appears once in `invoices`
 * when parsed, again in `paid_invoices` once paid). Summing all three
 * would double/triple-count real spend on any PO that reached payment.
 * Distinct docRef+amount is a reasonable proxy given there's no shared
 * primary key across those tables (see docs/dashboard-design-audit.md —
 * "zero FKs, 4 different PO-linkage column names" finding).
 */
function buildSummary(poNumber: string, entries: LedgerEntry[]): LedgerSummary {
  const docCounts: Record<string, number> = {};
  let totalInvoiced = 0;
  const seenInvoiceKeys = new Set<string>();
  let latestActivity: string | null = null;

  for (const e of entries) {
    docCounts[e.docType] = (docCounts[e.docType] ?? 0) + 1;

    // Sum amounts from financial doc types — deduplicated by (docRef, amount)
    // so the same underlying invoice recorded across invoices/paid_invoices/
    // vendor_invoices isn't counted more than once.
    if (
      ['invoice', 'paid_invoice', 'vendor_invoice'].includes(e.docType) &&
      e.amount > 0
    ) {
      const dedupeKey = `${e.docRef || e.sourceId}:${e.amount}`;
      if (!seenInvoiceKeys.has(dedupeKey)) {
        seenInvoiceKeys.add(dedupeKey);
        totalInvoiced += e.amount;
      }
    }

    // Track latest activity timestamp
    if (e.occurredAt && (!latestActivity || e.occurredAt > latestActivity)) {
      latestActivity = e.occurredAt;
    }
  }

  return {
    poNumber,
    vendorName: entries.length > 0 ? entries[0].vendorName : null,
    docCounts,
    totalInvoiced,
    latestActivity,
    documentCount: entries.length,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────

let cache: { data: any; at: number } | null = null;
const CACHE_TTL = 30 * 1000; // 30 seconds

function getCached(key: string): any | null {
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL) {
    return cache.data;
  }
  return null;
}

function setCache(key: string, data: any): void {
  cache = { key, data, at: Date.now() };
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const poParam = req.nextUrl.searchParams.get('po');
  const vendorParam = req.nextUrl.searchParams.get('vendor');
  const limitParam = req.nextUrl.searchParams.get('limit');
  const bust = req.nextUrl.searchParams.has('bust');

  if (!poParam && !vendorParam) {
    return NextResponse.json(
      { error: 'Query parameter required: ?po=<poNumber> or ?vendor=<vendorName>' },
      { status: 400 }
    );
  }

  const db = createClient();
  if (!db) {
    return NextResponse.json(
      { error: 'Database not configured' },
      { status: 503 }
    );
  }

  try {
    // ── Single-PO lookup ─────────────────────────────────────────────────────
    if (poParam) {
      const cacheKey = `po:${poParam}`;
      if (!bust) {
        const cached = getCached(cacheKey);
        if (cached) {
          return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store' } });
        }
      }

      const normalizedPo = normalizePo(poParam);

      // Query the VIEW through PostgREST
      const { data: rawRows, error } = await db
        .from('po_document_ledger')
        .select('*')
        .eq('po_number', normalizedPo)
        .order('occurred_at', { ascending: true });

      if (error) throw new Error(error.message);

      const rows = rawRows ?? [];
      const entries = rows.map(rowToEntry);
      const summary = buildSummary(normalizedPo, entries);

      const result: PoLedgerResponse = {
        poNumber: normalizedPo,
        vendorName: summary.vendorName,
        documents: entries,
        summary,
      };

      setCache(cacheKey, result);
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }

    // ── Vendor-wide listing ──────────────────────────────────────────────────
    if (vendorParam) {
      const cacheKey = `vendor:${vendorParam}:${limitParam ?? 100}`;
      if (!bust) {
        const cached = getCached(cacheKey);
        if (cached) {
          return NextResponse.json(cached, { headers: { 'Cache-Control': 'no-store' } });
        }
      }

      const limit = Math.min(Math.max(parseInt(limitParam ?? '100', 10) || 100, 1), 500);

      // Fetch all rows for this vendor from the view
      const { data: rawRows, error } = await db
        .from('po_document_ledger')
        .select('*')
        .ilike('vendor_name', `%${vendorParam}%`)
        .order('occurred_at', { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);

      const rows = rawRows ?? [];
      const entries = rows.map(rowToEntry);

      // Get unique PO numbers
      const poNumbers = [...new Set(entries.map(e => e.poNumber).filter(Boolean))];

      const result: VendorLedgerResponse = {
        vendor: vendorParam,
        poNumbers,
        documents: entries,
        totalDocuments: entries.length,
      };

      setCache(cacheKey, result);
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
  } catch (err: any) {
    console.error('[po-ledger] GET error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  return NextResponse.json(
    { error: 'Unexpected state' },
    { status: 500 }
  );
}

// ── POST — bust cache ─────────────────────────────────────────────────────────

export async function POST() {
  cache = null;
  return NextResponse.json({ ok: true });
}
