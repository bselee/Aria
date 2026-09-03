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
    prefer?: string;
}

let calls: CapturedCall[] = [];
let originalFetch: typeof globalThis.fetch;

/** Overridable per-test response body — set by tests that need custom data back. */
let nextResponseBody: string | null = null;

/** Extract the query string from a captured URL, or '' when absent. */
function qs(call: CapturedCall): string {
    return call.url.split('?')[1] ?? '';
}

beforeEach(() => {
    process.env.PGRST_URL = 'http://localhost:5434';
    process.env.PGRST_JWT_SECRET = 'test-secret-value-for-unit-tests-only-0000';
    calls = [];
    nextResponseBody = null;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (u: any, o: any) => {
        calls.push({ url: String(u), method: o?.method ?? 'GET', body: o?.body, prefer: o?.headers?.Prefer });
        // If a per-test response body was queued, use it (once), otherwise default empty array
        const body = nextResponseBody ?? '[]';
        nextResponseBody = null;
        return new Response(body, {
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

describe('db.ts PostgREST client — INSERT with .select() returning data', () => {
    it('sends Prefer: return=representation and ?select= on insert+select', async () => {
        const db = await freshClient();
        nextResponseBody = '[{"id":42}]';
        const { data, error } = await db!
            .from('cron_runs')
            .insert({ task_name: 'probe', status: 'running' })
            .select('id')
            .single();

        expect(error).toBeNull();
        expect(data).toEqual({ id: 42 });
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
        expect(qs(calls[0])).toContain('select=id');
        expect(calls[0].prefer).toContain('return=representation');
    });

    it('merges Prefer values when both onConflict and select are active', async () => {
        const db = await freshClient();
        nextResponseBody = '[{"id":7}]';
        const { data, error } = await db!
            .from('cron_runs')
            .upsert({ id: 7, task_name: 'upsert-probe' }, { onConflict: 'id' })
            .select('id')
            .single();

        expect(error).toBeNull();
        expect(data).toEqual({ id: 7 });
        expect(calls[0].prefer).toBe('resolution=merge-duplicates,return=representation');
        expect(qs(calls[0])).toContain('select=id');
        expect(qs(calls[0])).toContain('on_conflict=id');
    });

    it('does NOT send return=representation on insert without .select()', async () => {
        const db = await freshClient();
        await db!.from('cron_runs').insert({ task_name: 'lean' });

        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('POST');
        expect(calls[0].prefer).toBeUndefined();
        expect(qs(calls[0])).not.toContain('select=');
    });

    it('also works on update+select — PATCH returns the updated row', async () => {
        const db = await freshClient();
        nextResponseBody = '[{"id":99,"status":"succeeded"}]';
        const { data, error } = await db!
            .from('cron_runs')
            .update({ status: 'succeeded' })
            .eq('id', 99)
            .select('id,status')
            .single();

        expect(error).toBeNull();
        expect(data).toEqual({ id: 99, status: 'succeeded' });
        expect(calls[0].prefer).toContain('return=representation');
        expect(decodeURIComponent(qs(calls[0]))).toContain('select=id,status');
    });
});

describe('db.ts query builder — Promise-compatible catch()/finally()', () => {
    it('exposes catch() and finally() on QueryBuilder (thenable contract)', async () => {
        const db = await freshClient();
        if (!db) return; // skip when no client available
        const qb = db.from('ap_activity_log').insert({});
        expect(typeof qb.catch).toBe('function');
        expect(typeof qb.finally).toBe('function');
    });

    it('exposes catch() and finally() on RpcBuilder (thenable contract)', async () => {
        const db = await freshClient();
        if (!db) return;
        const rb = db.rpc('probe_fn', { arg: 1 });
        expect(typeof rb.catch).toBe('function');
        expect(typeof rb.finally).toBe('function');
    });
});
