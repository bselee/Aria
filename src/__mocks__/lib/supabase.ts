/**
 * @file    src/__mocks__/lib/supabase.ts
 * @purpose Vitest automatic mock for the legacy @/lib/supabase shim.
 *          Forwards to the same MockQueryBuilder used by @/lib/db.
 * @created 2026-07-08
 */

import { vi } from "vitest";

type FilterOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "like" | "ilike" | "is" | "in" | "contains" | "overlap";

class MockQueryBuilder {
  private _filters: string[] = [];
  private _select = "*";
  private _order: string | null = null;
  private _orderDir: "asc" | "desc" = "asc";
  private _limit: number | null = null;
  private _single = false;
  private _maybeSingle = false;
  private _method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private _body: any = null;

  select(columns = "*") { this._select = columns; return this; }

  private addFilter(col: string, op: FilterOp, val: any) {
    if (val === null || val === undefined) {
      this._filters.push(`${col}=is.null`);
    } else if (Array.isArray(val)) {
      this._filters.push(`${col}=${op}.(${val.join(",")})`);
    } else {
      this._filters.push(`${col}=${op}.${encodeURIComponent(String(val))}`);
    }
    return this;
  }

  eq(col: string, val: any) { return this.addFilter(col, "eq", val); }
  neq(col: string, val: any) { return this.addFilter(col, "neq", val); }
  gt(col: string, val: any) { return this.addFilter(col, "gt", val); }
  gte(col: string, val: any) { return this.addFilter(col, "gte", val); }
  lt(col: string, val: any) { return this.addFilter(col, "lt", val); }
  lte(col: string, val: any) { return this.addFilter(col, "lte", val); }
  like(col: string, val: any) { return this.addFilter(col, "like", val); }
  ilike(col: string, val: any) { return this.addFilter(col, "ilike", val); }
  is(col: string, val: any) { return this.addFilter(col, "is", val); }
  in(col: string, vals: any[]) { return this.addFilter(col, "in", vals); }
  contains(col: string, val: any) { return this.addFilter(col, "contains", val); }
  overlap(col: string, val: any) { return this.addFilter(col, "overlap", val); }
  not(col: string, op: FilterOp, val: any) { this._filters.push(`not.${col}=${op}.${val}`); return this; }
  or(filters: string) { this._filters.push(`or=(${filters})`); return this; }

  order(col: string, opts?: { ascending?: boolean }) {
    this._order = col;
    this._orderDir = opts?.ascending === false ? "desc" : "asc";
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  offset(n: number) { return this; }
  single() { this._single = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  insert(body: any) { this._method = "POST"; this._body = body; return this; }
  upsert(body: any) { this._method = "POST"; this._body = body; return this; }
  update(body: any) { this._method = "PATCH"; this._body = body; return this; }
  delete() { this._method = "DELETE"; return this; }

  then(resolve?: any, reject?: any) {
    const result = { data: null as any, error: null as any };
    if (resolve) return resolve(result);
    return result;
  }
}

const createClient = vi.fn(() => ({
  from: vi.fn((table: string) => new MockQueryBuilder()),
  rpc: vi.fn(async () => ({ data: null, error: null })),
}));

export { createClient, createClient as createBrowserClient };
export function resetClient() { /* no-op for tests */ }