/**
 * @file    route.test.ts
 * @purpose Smoke test for /api/dashboard/po-ledger
 * @deps    vitest
 * @created 2026-07-24
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock @/lib/db — createClient() returns a DbClient { from() }
vi.mock('@/lib/db', () => ({
  createClient: vi.fn(() => {
    function makeQueryBuilder() {
      const qb: any = {
        _select: '*',
        _filters: [] as any[],
        _order: null as string | null,
        _asc: true,
        _limit: null as number | null,
        select(cols: string) {
          qb._select = cols;
          return qb;
        },
        eq(col: string, val: any) {
          qb._filters.push({ col, op: 'eq', val });
          return qb;
        },
        ilike(col: string, val: any) {
          qb._filters.push({ col, op: 'ilike', val });
          return qb;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          qb._order = col;
          qb._asc = opts?.ascending !== false;
          return qb;
        },
        limit(n: number) {
          qb._limit = n;
          return qb;
        },
        not(col: string, op: string, val: any) {
          qb._filters.push({ col, op: `not.${op}`, val });
          return qb;
        },
        gte(col: string, val: any) {
          qb._filters.push({ col, op: 'gte', val });
          return qb;
        },
        then: (resolve?: any, reject?: any) => {
          let result: { data: any[]; error: null };
          const poFilter = qb._filters.find((f: any) => f.col === 'po_number');
          const vendorFilter = qb._filters.find((f: any) => f.col === 'vendor_name');
          if (poFilter) {
            const po = poFilter.val;
            result = {
              data: [
                { po_number: po, vendor_name: 'Test Vendor', doc_type: 'invoice', doc_ref: 'INV-001', amount: 100, status: 'matched', occurred_at: '2026-07-01T12:00:00.000Z', source_table: 'invoices', source_id: '1', detail: { invoice_number: 'INV-001' } },
                { po_number: po, vendor_name: 'Test Vendor', doc_type: 'paid_invoice', doc_ref: 'INV-001', amount: 100, status: 'po_matched', occurred_at: '2026-07-02T12:00:00.000Z', source_table: 'paid_invoices', source_id: '2', detail: { invoice_number: 'INV-001' } },
                { po_number: po, vendor_name: 'Test Vendor', doc_type: 'lifecycle_transition', doc_ref: '', amount: 0, status: 'INVOICED', occurred_at: '2026-07-03T12:00:00.000Z', source_table: 'po_lifecycle_transitions', source_id: '3', detail: { po_number: po, from_state: 'REVIEW', to_state: 'INVOICED' } },
              ],
              error: null,
            };
          } else if (vendorFilter) {
            result = {
              data: [
                { po_number: 'PO-001', vendor_name: vendorFilter.val, doc_type: 'invoice', doc_ref: 'INV-001', amount: 100, status: 'matched', occurred_at: '2026-07-01T12:00:00.000Z', source_table: 'invoices', source_id: '1', detail: {} },
              ],
              error: null,
            };
          } else {
            result = { data: [], error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return qb;
    }

    return {
      from: (_table: string) => makeQueryBuilder(),
      rpc: () => ({
        then: (resolve?: any, reject?: any) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
      }),
    };
  }),
}));

// Import after mocking
const { GET } = await import('./route');

describe('GET /api/dashboard/po-ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when no query param provided', async () => {
    const req = new NextRequest(new URL('http://localhost:3001/api/dashboard/po-ledger'));
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Query parameter required');
  });

  it('returns PO document trail for a valid PO', async () => {
    const req = new NextRequest(
      new URL('http://localhost:3001/api/dashboard/po-ledger?po=124813')
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.poNumber).toBe('124813');
    expect(body.documents).toHaveLength(3);
    expect(body.summary).toBeDefined();
    expect(body.summary.docCounts.invoice).toBe(1);
    expect(body.summary.documentCount).toBe(3);
    expect(body.summary.totalInvoiced).toBe(100);
  });

  it('normalizes PO numbers (strips PO- prefix, uppercase)', async () => {
    const req = new NextRequest(
      new URL('http://localhost:3001/api/dashboard/po-ledger?po=po-124813')
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should normalize to 124813
    expect(body.poNumber).toBe('124813');
  });

  it('supports vendor-wide listing', async () => {
    const req = new NextRequest(
      new URL('http://localhost:3001/api/dashboard/po-ledger?vendor=Test&limit=50')
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vendor).toBe('Test');
    expect(body.totalDocuments).toBeGreaterThan(0);
    expect(body.poNumbers).toContain('PO-001');
  });

  it('busts cache when ?bust=1 is passed', async () => {
    const req1 = new NextRequest(
      new URL('http://localhost:3001/api/dashboard/po-ledger?po=124813')
    );
    await GET(req1);

    const req2 = new NextRequest(
      new URL('http://localhost:3001/api/dashboard/po-ledger?po=124813&bust=1')
    );
    const res2 = await GET(req2);
    expect(res2.status).toBe(200);
  });

  it('POST busts cache', async () => {
    const { POST } = await import('./route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
