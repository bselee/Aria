/**
 * @file src/lib/db.test.ts
 * @purpose Regression tests for the PostgREST query-builder in src/lib/db.ts.
 *          Guards the 2026-07-27 data-corruption bug where filters were applied
 *          ONLY to GET requests, making every .update()/.delete() an unfiltered
 *          whole-table write.
 * @author Hermia
 * @created 2026-07-27
 * @deps vitest, src/lib/db.ts
 * @env PGRST_URL (stubbed per-test)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

interface CapturedCall {
    url: string;
    method: string;
    body?: string;
}

let calls: CapturedCall[] = [];
let originalFetch: typeof globalThis.fetch;

/** Extract the query string from a captured URL, or '' when absent. */
function qs(call: CapturedCall): string {
    return call.url.split('?')[1] ?? '';
}

beforeEach(() => {
    process.env.PGRST_URL = 'http://localhost:5434';
    process.env.PGRST_JWT_SECRET = 'test-secret-value-for-unit-tests-only-0000';
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (u: any, o: any) => {
        calls.push({ url: String(u), method: o?.method ?? 'GET', body: o?.body });
        return new Response('[]', {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

async function freshClient() {
    const mod = await import('./db');
    return mod.createClient();
}

describe('db.ts query builder — filter application across HTTP methods', () => {
    it('applies filters to GET (select)', async () => {
        const db = await freshClient();
        await db!.from('ap_activity_log').select('id').eq('id', 'ROW-123');

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('GET');
        expect(qs(calls[0])).toContain('id=eq.ROW-123');
    });

    it('applies filters to PATCH (update) — regression: 2026-07-27 whole-table overwrite', async () => {
        const db = await freshClient();
        await db!
            .from('ap_activity_log')
            .update({ action_taken: 'X' })
            .eq('id', 'ROW-123');

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('PATCH');
        // The bug: query string was empty, so PostgREST patched EVERY row.
        expect(qs(calls[0])).toBe('id=eq.ROW-123');
    });

    it('applies filters to DELETE', async () => {
        const db = await freshClient();
        await db!.from('ap_activity_log').delete().eq('id', 'ROW-123');

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('DELETE');
        expect(qs(calls[0])).toBe('id=eq.ROW-123');
    });

    it('applies multiple/compound filters to PATCH, including JSONB paths', async () => {
        const db = await freshClient();
        await db!
            .from('ap_activity_log')
            .update({ metadata: { a: 1 } })
            .eq('intent', 'PO_ARRIVAL_AT_RISK')
            .filter('metadata->>poId', 'eq', '125126');

        const query = decodeURIComponent(qs(calls[0]));
        expect(calls[0].method).toBe('PATCH');
        expect(query).toContain('intent=eq.PO_ARRIVAL_AT_RISK');
        expect(query).toContain('metadata->>poId=eq.125126');
    });

    it('does NOT leak select/order/limit onto a PATCH', async () => {
        const db = await freshClient();
        await db!
            .from('purchase_orders')
            .update({ status: 'Committed' })
            .eq('po_number', '125126');

        const query = qs(calls[0]);
        expect(query).not.toContain('select=');
        expect(query).not.toContain('order=');
        expect(query).not.toContain('limit=');
    });
});

describe('db.ts query builder — unfiltered write guard', () => {
    it('BLOCKS an unfiltered PATCH and issues no HTTP request', async () => {
        const db = await freshClient();
        const { error } = await db!
            .from('ap_activity_log')
            .update({ action_taken: 'oops' });

        expect(error).toBeTruthy();
        expect(String(error.message)).toContain('BLOCKED unfiltered PATCH');
        expect(calls).toHaveLength(0);
    });

    it('BLOCKS an unfiltered DELETE and issues no HTTP request', async () => {
        const db = await freshClient();
        const { error } = await db!.from('purchase_orders').delete();

        expect(error).toBeTruthy();
        expect(String(error.message)).toContain('BLOCKED unfiltered DELETE');
        expect(calls).toHaveLength(0);
    });

    it('still allows unfiltered POST (insert/upsert) — inserts need no predicate', async () => {
        const db = await freshClient();
        await db!.from('ap_activity_log').insert({ intent: 'TEST' });

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
    });
});
