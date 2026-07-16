/**
 * @file    src/lib/db.ts
 * @purpose Direct PostgREST client — no Supabase SDK dependency.
 *          Replaces src/lib/supabase.ts which wrapped @supabase/supabase-js.
 *          The operational DB is PostgREST + Postgres in Docker (WSL2).
 *          Local-only ops use aria-local.db via src/lib/storage/local-db.ts instead.
 *
 * API: Minimal chainable query builder compatible with existing call sites.
 *   const db = createClient();
 *   const { data, error } = await db.from("table").select("*").eq("id","x").single();
 *   const { data, error } = await db.from("table").upsert(payload).select("id").single();
 *   const { error } = await db.from("table").update(fields).eq("id",v);
 *   const { data, error } = await db.rpc("fn", { arg });
 *
 * @env     PGRST_URL          — PostgREST endpoint (defaults from SUPABASE_URL)
 *          PGRST_JWT_SECRET   — JWT signing secret for PostgREST
 *          SUPABASE_SERVICE_ROLE_KEY — fallback JWT / API key
 * @created 2026-07-01 (replaces supabase.ts)
 */

import * as crypto from "crypto";

// ── Config ──────────────────────────────────────────────────────────────────

/** Lazy — evaluated at first call so dotenv has time to load before the module is imported. */
function getPgrstUrl(): string {
  return (
    process.env.PGRST_URL ||
    process.env.PGREST_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(".supabase.co", "") ||
    process.env.SUPABASE_URL ||
    "http://localhost:5434"
  );
}

/**
 * Quick health probe for PostgREST. Use before optional enrichment paths
 * so Finale-first UI never blocks on a dead local DB.
 *
 * @param timeoutMs Max wait (default 2s)
 * @returns true if PostgREST returns a body (200 or 503 schema loading)
 */
export async function probePostgrest(timeoutMs = 2000): Promise<boolean> {
  const base = getPgrstUrl().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
  if (!base) return false;
  try {
    const res = await fetch(base + "/", {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 200 = ready; 503 = schema cache loading but pipe is alive
    return res.status === 200 || res.status === 503;
  } catch {
    return false;
  }
}

const PGRST_SECRET =
  process.env.PGRST_JWT_SECRET || "aria-local-dev-secret-not-for-production";

const SERVER_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "mock-key";

// ── Auth token ──────────────────────────────────────────────────────────────

function getAuthToken(): string {
  // If the key looks like a JWT (3 dot-separated base64 parts), use it directly.
  if (SERVER_ROLE_KEY.split(".").length === 3) return SERVER_ROLE_KEY;

  // For local PostgREST: generate a JWT signed with the known secret
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      role: "anon",
      iss: "postgrest",
      exp: 9999999999,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", PGRST_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// ── Query builder ───────────────────────────────────────────────────────────

type FilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "is"
  | "in"
  | "contains"
  | "overlap";

class QueryBuilder {
  private table: string;
  private _select: string = "*";
  private _filters: string[] = [];
  private _order: string | null = null;
  private _orderDir: "asc" | "desc" = "asc";
  private _limit: number | null = null;
  private _offset: number | null = null;
  private _single: boolean = false;
  private _maybeSingle: boolean = false;
  private _method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private _body: any = null;
  private _onConflict: string | null = null;
  private _rpcName: string | null = null;
  private _rpcArgs: Record<string, any> | null = null;

  constructor(table: string) {
    this.table = table;
  }

  // ── Chain methods ──────────────────────────────────────────────────────

  select(columns: string = "*"): this {
    this._select = columns;
    return this;
  }

  private addFilter(col: string, op: FilterOp, val: any): this {
    if (val === null || val === undefined) {
      if (op === "eq") this._filters.push(`${col}=is.null`);
      else if (op === "neq") this._filters.push(`${col}=not.is.null`);
      else this._filters.push(`${col}=${op}.null`);
    } else if (Array.isArray(val)) {
      if (op === "in") this._filters.push(`${col}=in.(${val.join(",")})`);
      else if (op === "contains")
        this._filters.push(`${col}=cs.${JSON.stringify(val)}`);
      else if (op === "overlap")
        this._filters.push(`${col}=ov.{${val.map((v: any) => encodeURIComponent(String(v))).join(",")}}`);
      else
        this._filters.push(
          `${col}=${op}.${val.map((v: any) => encodeURIComponent(String(v))).join(",")}`
        );
    } else {
      this._filters.push(`${col}=${op}.${val}`);
    }
    return this;
  }

  eq(col: string, val: any): this {
    return this.addFilter(col, "eq", val);
  }
  /**
   * Supabase SDK compatibility: `.filter(column, operator, value)`.
   * Used heavily for JSON/metadata columns (`metadata->>type`, etc.).
   */
  filter(col: string, op: string, val: any): this {
    return this.addFilter(col, op as FilterOp, val);
  }
  neq(col: string, val: any): this {
    return this.addFilter(col, "neq", val);
  }
  gt(col: string, val: any): this {
    return this.addFilter(col, "gt", val);
  }
  gte(col: string, val: any): this {
    return this.addFilter(col, "gte", val);
  }
  lt(col: string, val: any): this {
    return this.addFilter(col, "lt", val);
  }
  lte(col: string, val: any): this {
    return this.addFilter(col, "lte", val);
  }
  like(col: string, val: any): this {
    return this.addFilter(col, "like", val);
  }
  ilike(col: string, val: any): this {
    return this.addFilter(col, "ilike", val);
  }
  is(col: string, val: any): this {
    return this.addFilter(col, "is", val);
  }
  in(col: string, vals: any[]): this {
    return this.addFilter(col, "in", vals);
  }
  contains(col: string, val: any): this {
    return this.addFilter(col, "contains", val);
  }
  overlap(col: string, val: any): this {
    return this.addFilter(col, "overlap", val);
  }
  /** Alias — Supabase SDK called this `.overlaps`. */
  overlaps(col: string, val: any): this {
    return this.addFilter(col, "overlap", val);
  }
  /**
   * Supabase-compatible NOT filter.
   * PostgREST expects: col=not.op.val  (e.g. po_sent_verified_at=not.is.null)
   * NOT the inverted form not.col=op.val which triggers PGRST108.
   */
  not(col: string, op: string, val: any): this {
    if (val === null || val === undefined) {
      if (op === "is") this._filters.push(`${col}=not.is.null`);
      else this._filters.push(`${col}=not.${op}.null`);
    } else if (Array.isArray(val) && op === "in") {
      this._filters.push(`${col}=not.in.(${val.join(",")})`);
    } else {
      this._filters.push(`${col}=not.${op}.${val}`);
    }
    return this;
  }

  or(filters: string): this {
    this._filters.push(`or=(${filters})`);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this._order = col;
    this._orderDir = opts?.ascending === false ? "desc" : "asc";
    return this;
  }

  limit(n: number): this {
    this._limit = n;
    return this;
  }

  offset(n: number): this {
    this._offset = n;
    return this;
  }

  single(): this {
    this._single = true;
    return this;
  }

  maybeSingle(): this {
    this._maybeSingle = true;
    return this;
  }

  insert(body: any): this {
    this._method = "POST";
    this._body = body;
    return this;
  }

  upsert(
    body: any,
    opts?: { onConflict?: string; ignoreDuplicates?: boolean }
  ): this {
    this._method = "POST";
    this._body = body;
    this._onConflict = opts?.onConflict || null;
    // For upsert, we set Prefer header via onConflict
    return this;
  }

  update(body: any): this {
    this._method = "PATCH";
    this._body = body;
    return this;
  }

  delete(): this {
    this._method = "DELETE";
    return this;
  }

  // ── Execute ────────────────────────────────────────────────────────────

  async then<T = any>(
    resolve?: (value: { data: T | null; error: any }) => any,
    reject?: (reason: any) => any
  ): Promise<{ data: T | null; error: any }> {
    try {
      const result = await this.execute<T>();
      if (resolve) return resolve(result);
      return result;
    } catch (err) {
      if (reject) return reject(err);
      throw err;
    }
  }

  private async execute<T>(): Promise<{ data: T | null; error: any }> {
    const pgrstUrl = getPgrstUrl();
    if (!pgrstUrl) {
      return { data: null, error: new Error("PostgREST URL not configured") };
    }

    // Clean URL — remove /rest/v1/ if present, ensure no double slashes
    let base = pgrstUrl.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
    const url = new URL(`${base}/${this.table}`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      apikey: getAuthToken(),
      Authorization: `Bearer ${getAuthToken()}`,
    };

    if (this._onConflict) {
      headers["Prefer"] = `resolution=merge-duplicates`;
      // PostgREST uses ?on_conflict= query param for upsert
      url.searchParams.set("on_conflict", this._onConflict);
    }

    // Build query params for GET
    if (this._method === "GET") {
      url.searchParams.set("select", this._select);

      for (const f of this._filters) {
        const eqIndex = f.indexOf("=");
        if (eqIndex === -1) continue;
        const key = f.slice(0, eqIndex);
        const val = f.slice(eqIndex + 1);
        url.searchParams.append(key, val);
      }

      if (this._order) {
        const dir = this._orderDir === "desc" ? ".desc" : ".asc";
        url.searchParams.set("order", `${this._order}${dir}`);
      }
      if (this._limit !== null) url.searchParams.set("limit", String(this._limit));
      if (this._offset !== null) url.searchParams.set("offset", String(this._offset));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url.toString(), {
        method: this._method,
        headers,
        body: this._method !== "GET" && this._body !== null
          ? JSON.stringify(this._body)
          : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          data: null,
          error: new Error(
            `PostgREST ${res.status}: ${res.statusText} — ${text.slice(0, 200)}`
          ),
        };
      }

      // Check for 204 No Content
      if (res.status === 204) {
        return { data: null as T | null, error: null };
      }

      const text = await res.text();
      if (!text || text.trim() === "") {
        return { data: null as T | null, error: null };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { data: text as unknown as T, error: null };
      }

      if (this._single || this._maybeSingle) {
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) {
            return {
              data: (this._single ? null : null) as T | null,
              error: this._single
                ? new Error("Row not found")
                : null,
            };
          }
          return { data: parsed[0], error: null };
        }
        return { data: parsed, error: null };
      }

      return { data: parsed, error: null };
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { data: null, error: new Error("PostgREST request timed out") };
      }
      return { data: null, error: err };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── RPC builder ─────────────────────────────────────────────────────────────

class RpcBuilder {
  private name: string;
  private params: Record<string, any> = {};

  constructor(name: string) {
    this.name = name;
  }

  select(_cols?: string): this {
    return this;
  }

  async then<T = any>(
    resolve?: (value: { data: T | null; error: any }) => any,
    reject?: (reason: any) => any
  ): Promise<{ data: T | null; error: any }> {
    try {
      const result = await this.execute<T>();
      if (resolve) return resolve(result);
      return result;
    } catch (err) {
      if (reject) return reject(err);
      throw err;
    }
  }

  private async execute<T>(): Promise<{ data: T | null; error: any }> {
    const pgrstUrl = getPgrstUrl();
    if (!pgrstUrl) {
      return { data: null, error: new Error("PostgREST URL not configured") };
    }

    const base = pgrstUrl.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
    const url = `${base}/rpc/${this.name}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      apikey: getAuthToken(),
      Authorization: `Bearer ${getAuthToken()}`,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(this.params),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          data: null,
          error: new Error(
            `PostgREST RPC ${res.status}: ${res.statusText} — ${text.slice(0, 200)}`
          ),
        };
      }

      if (res.status === 204) {
        return { data: null as T | null, error: null };
      }

      const text = await res.text();
      if (!text || text.trim() === "") {
        return { data: null as T | null, error: null };
      }

      try {
        return { data: JSON.parse(text), error: null };
      } catch {
        return { data: text as unknown as T, error: null };
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { data: null, error: new Error("PostgREST RPC timed out") };
      }
      return { data: null, error: err };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface DbClient {
  from(table: string): QueryBuilder;
  rpc(name: string, params?: Record<string, any>): RpcBuilder;
}

let client: DbClient | null = null;

export function createClient(): DbClient {
  if (client) return client;

  const _client: DbClient = {
    from(table: string): QueryBuilder {
      return new QueryBuilder(table);
    },
    rpc(name: string, params?: Record<string, any>): RpcBuilder {
      const builder = new RpcBuilder(name);
      if (params) Object.assign(builder, { params });
      return builder;
    },
  };

  client = _client;
  return _client;
}

/**
 * Reset the singleton (for testing).
 */
export function resetClient(): void {
  client = null;
}
