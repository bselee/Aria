/**
 * @file    src/lib/purchasing/po-truth.ts
 * @purpose Shared PO-truth reader: one place that answers "what does the local
 *          DB actually know about these POs?" — header, tracking + shipments,
 *          lifecycle (ack / sent-verified), matched invoice, freight.
 *
 *          WHY THIS EXISTS
 *          ---------------
 *          The recurring Aria dashboard failure is a PostgREST read that returns
 *          `{ error }`, the caller ignores it, and the panel renders confident
 *          blanks (see Workstream 1: two non-existent columns silently nulled
 *          every enrichment field on 15 open POs). `createClient()` from
 *          `@/lib/db` RESOLVES `{ data, error }` instead of throwing, so a typo
 *          in a select list is invisible unless somebody reads `.error`.
 *
 *          This reader reads `.error` on EVERY query and reports the failing
 *          table in `degraded[]` instead of failing silent. Callers are expected
 *          to surface `degraded` in their payload so the UI can say
 *          "enrichment degraded: purchase_orders" rather than show blank columns.
 *
 * @deps    @/lib/db (client injected by the caller — no module-level client)
 * @created 2026-10-29 (WS5, docs/plans/2026-10-29-aria-dashboard-hardening.md)
 */

import type { DbClient } from "@/lib/db";
import type { ShipmentRecord } from "@/lib/tracking/shipment-intelligence";

/** Tables this reader touches. A failure on any of them lands in `degraded[]`. */
export const PO_TRUTH_TABLES = ["purchase_orders", "shipments", "vendor_invoices"] as const;
export type POTruthTable = (typeof PO_TRUTH_TABLES)[number];

export interface POTruth {
  poNumber: string;
  header: { status: string; total: number; receiveDate: string | null };
  tracking: { numbers: string[]; shipments: ShipmentRecord[] };
  lifecycle: { stage: string | null; ackAt: string | null; sentVerifiedAt: string | null };
  invoice: { matchedId: string | null; status: string | null; total: number | null };
  freight: { applied: boolean };
}

export interface POTruthResult {
  rows: POTruth[];
  /**
   * Table names whose read returned `{ error }` (or was skipped because there was
   * no client). Empty means "everything below is real data".
   */
  degraded: POTruthTable[];
}

/** Minimal shape this module needs from `createClient()` — keeps tests trivial. */
type TruthDb = Pick<DbClient, "from"> | null | undefined;

/** PostgREST `in.(...)` / `ov.{...}` payload size guard. */
const CHUNK_SIZE = 100;

interface ReadResult<T> {
  data: T[] | null;
  error: any;
}

/**
 * Await a query builder without letting a throw escape.
 *
 * `@/lib/db` resolves `{ error }` rather than rejecting, but the builder is
 * thenable and a rejected promise (network stack error, test double throwing)
 * must degrade — never take the whole panel down.
 */
async function safeRead<T>(query: PromiseLike<{ data: T[] | null; error: any }> | null): Promise<ReadResult<T>> {
  if (!query) return { data: null, error: new Error("no query") };
  try {
    const res = await query;
    return { data: (res?.data as T[]) ?? null, error: res?.error ?? null };
  } catch (err: any) {
    return { data: null, error: err ?? new Error("query threw") };
  }
}

function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A row with Finale-shaped / empty values — what a caller sees when the DB is mute. */
function emptyRow(poNumber: string): POTruth {
  return {
    poNumber,
    header: { status: "", total: 0, receiveDate: null },
    tracking: { numbers: [], shipments: [] },
    lifecycle: { stage: null, ackAt: null, sentVerifiedAt: null },
    invoice: { matchedId: null, status: null, total: null },
    freight: { applied: false },
  };
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/** Map a `shipments` row onto the ShipmentRecord shape the rest of Aria uses. */
function toShipmentRecord(row: any): ShipmentRecord {
  return {
    id: String(row?.id ?? ""),
    tracking_key: row?.tracking_key ?? "",
    tracking_number: row?.tracking_number ?? "",
    normalized_tracking_number: row?.normalized_tracking_number ?? "",
    carrier_name: row?.carrier_name ?? null,
    carrier_key: row?.carrier_key ?? null,
    tracking_kind: (row?.tracking_kind ?? "unknown") as ShipmentRecord["tracking_kind"],
    po_numbers: Array.isArray(row?.po_numbers) ? row.po_numbers.map(String) : [],
    vendor_names: Array.isArray(row?.vendor_names) ? row.vendor_names.map(String) : [],
    status_category: row?.status_category ?? null,
    status_display: row?.status_display ?? null,
    public_tracking_url: row?.public_tracking_url ?? null,
    estimated_delivery_at: row?.estimated_delivery_at ?? null,
    delivered_at: row?.delivered_at ?? null,
    last_checked_at: row?.last_checked_at ?? null,
    last_source: row?.last_source ?? null,
    source_confidence: row?.source_confidence ?? null,
    source_refs: Array.isArray(row?.source_refs) ? row.source_refs : [],
    active: Boolean(row?.active),
    created_at: row?.created_at ?? "",
    updated_at: row?.updated_at ?? "",
  };
}

/**
 * Load local PO truth for a set of PO numbers.
 *
 * Never throws. Every failed read is reported in `degraded[]`; the affected rows
 * fall back to empty/Finale-only values so a caller always gets one row per PO.
 */
export async function loadPOTruth(db: TruthDb, poNumbers: string[]): Promise<POTruthResult> {
  const wanted = [
    ...new Set(
      (poNumbers || [])
        .map(n => String(n ?? "").trim())
        .filter(Boolean)
    ),
  ];

  const rows = wanted.map(emptyRow);
  const degraded: POTruthTable[] = [];

  if (wanted.length === 0) return { rows, degraded };
  if (!db) {
    degraded.push(...PO_TRUTH_TABLES);
    return { rows, degraded };
  }

  const byPo = new Map<string, POTruth>(rows.map(r => [r.poNumber, r]));

  // ── 1. purchase_orders (header + tracking numbers + lifecycle) ────────────
  const poChunks = chunk(wanted);
  const poReads = await Promise.all(
    poChunks.map(part =>
      safeRead<any>(
        db
          .from("purchase_orders")
          .select(
            "po_number, status, total, total_amount, receive_date, tracking_numbers, " +
              "lifecycle_stage, vendor_acknowledged_at, po_sent_verified_at"
          )
          .in("po_number", part)
      )
    )
  );
  const poError = poReads.find(r => r.error)?.error ?? null;
  if (poError) {
    degraded.push("purchase_orders");
  } else {
    for (const read of poReads) {
      for (const r of read.data || []) {
        const row = byPo.get(String(r.po_number));
        if (!row) continue;
        row.header = {
          status: asString(r.status) ?? "",
          total: asNumber(r.total) ?? asNumber(r.total_amount) ?? 0,
          receiveDate: asString(r.receive_date),
        };
        row.tracking.numbers = Array.isArray(r.tracking_numbers)
          ? r.tracking_numbers.map(String).filter(Boolean)
          : [];
        row.lifecycle = {
          stage: asString(r.lifecycle_stage),
          ackAt: asString(r.vendor_acknowledged_at),
          sentVerifiedAt: asString(r.po_sent_verified_at),
        };
      }
    }
  }

  // ── 2. shipments — po_numbers is an ARRAY column: overlap, never .eq ─────
  const shipReads = await Promise.all(
    poChunks.map(part =>
      safeRead<any>(
        db
          .from("shipments")
          .select(
            "id, tracking_key, tracking_number, normalized_tracking_number, carrier_name, carrier_key, " +
              "tracking_kind, po_numbers, vendor_names, status_category, status_display, public_tracking_url, " +
              "estimated_delivery_at, delivered_at, last_checked_at, last_source, source_confidence, source_refs, " +
              "active, created_at, updated_at"
          )
          .overlap("po_numbers", part)
      )
    )
  );
  const shipError = shipReads.find(r => r.error)?.error ?? null;
  if (shipError) {
    degraded.push("shipments");
  } else {
    for (const read of shipReads) {
      for (const r of read.data || []) {
        const shipment = toShipmentRecord(r);
        for (const poNumber of shipment.po_numbers) {
          const row = byPo.get(poNumber);
          if (!row) continue;
          row.tracking.shipments.push(shipment);
        }
      }
    }
  }

  // ── 3. vendor_invoices (matched identity + amount + freight on the bill) ──
  const invReads = await Promise.all(
    poChunks.map(part =>
      safeRead<any>(
        db
          .from("vendor_invoices")
          .select("po_number, id, status, total, freight")
          .in("po_number", part)
          .order("created_at", { ascending: false })
      )
    )
  );
  const invError = invReads.find(r => r.error)?.error ?? null;
  if (invError) {
    degraded.push("vendor_invoices");
  } else {
    // Newest first (query order) — the first row seen for a PO wins.
    const seenInvoicePo = new Set<string>();
    for (const read of invReads) {
      for (const r of read.data || []) {
        const poNumber = asString(r.po_number);
        if (!poNumber) continue;
        const row = byPo.get(poNumber);
        if (!row) continue;
        if (seenInvoicePo.has(poNumber)) continue;
        seenInvoicePo.add(poNumber);
        row.invoice = {
          matchedId: asString(r.id),
          status: asString(r.status),
          total: asNumber(r.total),
        };
        row.freight = { applied: (asNumber(r.freight) ?? 0) > 0 };
      }
    }
  }

  return { rows, degraded };
}
