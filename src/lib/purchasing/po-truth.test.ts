/**
 * @file    po-truth.test.ts
 * @purpose Unit tests for the shared PO-truth reader (WS5.1).
 *          The whole point of the module is that a silent `{ error }` read is
 *          turned into a named `degraded[]` entry instead of blank columns, so
 *          the error paths are tested as hard as the happy path.
 */

import { describe, expect, it } from "vitest";

import { loadPOTruth, PO_TRUTH_TABLES } from "./po-truth";

type TableConfig = { rows?: any[]; error?: any; throws?: boolean };

interface RecordedCall {
  table: string;
  method: string;
  args: any[];
}

/**
 * Minimal thenable PostgREST stand-in. Applies the handful of filters this
 * module actually uses so the assertions are about real filtering, not stubs.
 */
function makeDb(config: Record<string, TableConfig>) {
  const calls: RecordedCall[] = [];

  const db = {
    from(table: string) {
      const cfg = config[table] ?? { rows: [] };
      let rows: any[] = cfg.rows ?? [];
      const record = (method: string, args: any[]) => calls.push({ table, method, args });

      const builder: any = {
        select: (...args: any[]) => {
          record("select", args);
          return builder;
        },
        eq: (col: string, val: any) => {
          record("eq", [col, val]);
          rows = rows.filter(r => r?.[col] === val);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          record("in", [col, vals]);
          rows = rows.filter(r => vals.includes(r?.[col]));
          return builder;
        },
        overlap: (col: string, vals: any[]) => {
          record("overlap", [col, vals]);
          rows = rows.filter(
            r => Array.isArray(r?.[col]) && r[col].some((v: any) => vals.includes(v))
          );
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          record("order", [col, opts]);
          const dir = opts?.ascending === false ? -1 : 1;
          rows = [...rows].sort((a, b) =>
            String(a?.[col] ?? "").localeCompare(String(b?.[col] ?? "")) * dir
          );
          return builder;
        },
        limit: (n: number) => {
          record("limit", [n]);
          rows = rows.slice(0, n);
          return builder;
        },
        then: (resolve: any, reject?: any) => {
          if (cfg.throws) {
            return Promise.reject(cfg.error ?? new Error("query threw")).then(resolve, reject);
          }
          return Promise.resolve({
            data: cfg.error ? null : rows,
            error: cfg.error ?? null,
          }).then(resolve, reject);
        },
      };

      return builder;
    },
  };

  return { db: db as any, calls };
}

const PO_125423 = {
  po_number: "125423",
  status: "PO Issued",
  total: 1234.5,
  receive_date: null,
  tracking_numbers: ["UPS:::1ZA2V8800334516249"],
  lifecycle_stage: "SENT",
  vendor_acknowledged_at: "2026-10-20T14:00:00.000Z",
  po_sent_verified_at: "2026-10-20T13:00:00.000Z",
};

const PO_125429 = {
  po_number: "125429",
  status: "Completed",
  total: null,
  total_amount: 2995.75,
  receive_date: "2026-10-27",
  tracking_numbers: null,
  lifecycle_stage: "RECEIVED",
  vendor_acknowledged_at: null,
  po_sent_verified_at: "2026-10-21T09:00:00.000Z",
};

function shipmentRow(overrides: Record<string, any> = {}) {
  return {
    id: "s1",
    tracking_key: "1z-1",
    tracking_number: "1ZA2V8800334516249",
    normalized_tracking_number: "1ZA2V8800334516249",
    carrier_name: "UPS",
    carrier_key: "ups",
    tracking_kind: "parcel",
    po_numbers: ["125423"],
    vendor_names: ["Uline"],
    status_category: "in_transit",
    status_display: "In Transit",
    public_tracking_url: null,
    estimated_delivery_at: null,
    delivered_at: null,
    last_checked_at: null,
    last_source: "carrier_poll",
    source_confidence: 0.9,
    source_refs: [],
    active: true,
    created_at: "2026-10-21T00:00:00.000Z",
    updated_at: "2026-10-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("loadPOTruth", () => {
  it("joins purchase_orders, shipments (overlap) and newest vendor_invoice per PO", async () => {
    const { db, calls } = makeDb({
      purchase_orders: { rows: [PO_125423, PO_125429] },
      shipments: {
        rows: [
          shipmentRow({ id: "s1", po_numbers: ["125423"] }),
          shipmentRow({ id: "s2", tracking_number: "1Z-X", po_numbers: ["125423", "125429"] }),
          shipmentRow({ id: "s3", po_numbers: ["999999"] }),
        ],
      },
      vendor_invoices: {
        rows: [
          { po_number: "125423", id: "inv-new", status: "matched", total: 1200, freight: 45 },
          { po_number: "125423", id: "inv-old", status: "matched", total: 1000, freight: 0 },
          { po_number: "125429", id: "inv-429", status: "received", total: 2995.75, freight: 0 },
        ],
      },
    });

    const { rows, degraded } = await loadPOTruth(db, ["125423", "125429"]);

    expect(degraded).toEqual([]);
    expect(rows.map(r => r.poNumber)).toEqual(["125423", "125429"]);

    const first = rows[0];
    expect(first.header).toEqual({ status: "PO Issued", total: 1234.5, receiveDate: null });
    expect(first.tracking.numbers).toEqual(["UPS:::1ZA2V8800334516249"]);
    expect(first.tracking.shipments.map(s => s.id)).toEqual(["s1", "s2"]);
    expect(first.lifecycle).toEqual({
      stage: "SENT",
      ackAt: "2026-10-20T14:00:00.000Z",
      sentVerifiedAt: "2026-10-20T13:00:00.000Z",
    });
    // Newest row (query order is created_at desc) wins, and its freight sets applied.
    expect(first.invoice).toEqual({ matchedId: "inv-new", status: "matched", total: 1200 });
    expect(first.freight).toEqual({ applied: true });

    const second = rows[1];
    // total falls back to total_amount; null tracking_numbers becomes [].
    expect(second.header).toEqual({ status: "Completed", total: 2995.75, receiveDate: "2026-10-27" });
    expect(second.tracking.numbers).toEqual([]);
    expect(second.tracking.shipments.map(s => s.id)).toEqual(["s2"]);
    expect(second.invoice).toEqual({ matchedId: "inv-429", status: "received", total: 2995.75 });
    expect(second.freight).toEqual({ applied: false });

    // shipments.po_numbers is an ARRAY column — it must be read with overlap.
    const shipmentFilters = calls.filter(c => c.table === "shipments");
    expect(shipmentFilters.some(c => c.method === "overlap" && c.args[0] === "po_numbers")).toBe(true);
    expect(shipmentFilters.some(c => c.method === "in" || c.method === "eq")).toBe(false);
  });

  it("degrades purchase_orders instead of throwing, and rows fall back to empty fields", async () => {
    const { db } = makeDb({
      purchase_orders: { error: { message: 'column "tracking_paused" does not exist' } },
      shipments: { rows: [shipmentRow()] },
      vendor_invoices: { rows: [{ po_number: "125423", id: "inv-1", status: "matched", total: 900, freight: 0 }] },
    });

    const { rows, degraded } = await loadPOTruth(db, ["125423", "125429"]);

    expect(degraded).toEqual(["purchase_orders"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].header).toEqual({ status: "", total: 0, receiveDate: null });
    expect(rows[0].tracking.numbers).toEqual([]);
    expect(rows[0].lifecycle).toEqual({ stage: null, ackAt: null, sentVerifiedAt: null });
    // Other reads still land — a partial degrade is still useful.
    expect(rows[0].tracking.shipments.map(s => s.id)).toEqual(["s1"]);
    expect(rows[0].invoice.matchedId).toBe("inv-1");
    expect(rows[1].invoice.matchedId).toBeNull();
  });

  it("degrades only shipments when that read fails, keeping PO header data", async () => {
    const { db } = makeDb({
      purchase_orders: { rows: [PO_125423] },
      shipments: { error: { message: "PGRST schema cache mismatch" } },
      vendor_invoices: { rows: [] },
    });

    const { rows, degraded } = await loadPOTruth(db, ["125423"]);

    expect(degraded).toEqual(["shipments"]);
    expect(rows[0].header.status).toBe("PO Issued");
    expect(rows[0].tracking.numbers).toEqual(["UPS:::1ZA2V8800334516249"]);
    expect(rows[0].tracking.shipments).toEqual([]);
    expect(rows[0].invoice).toEqual({ matchedId: null, status: null, total: null });
  });

  it("degrades a read whose promise rejects (network stack error)", async () => {
    const { db } = makeDb({
      purchase_orders: { throws: true, error: new Error("fetch failed") },
      shipments: { rows: [] },
      vendor_invoices: { rows: [] },
    });

    const { rows, degraded } = await loadPOTruth(db, ["125423"]);

    expect(degraded).toEqual(["purchase_orders"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].header.status).toBe("");
  });

  it("reports every table as degraded when there is no client", async () => {
    const { rows, degraded } = await loadPOTruth(null, ["125423"]);

    expect(degraded).toEqual([...PO_TRUTH_TABLES]);
    expect(rows).toEqual([
      {
        poNumber: "125423",
        header: { status: "", total: 0, receiveDate: null },
        tracking: { numbers: [], shipments: [] },
        lifecycle: { stage: null, ackAt: null, sentVerifiedAt: null },
        invoice: { matchedId: null, status: null, total: null },
        freight: { applied: false },
      },
    ]);
  });

  it("returns no rows and issues no queries for an empty or blank PO list", async () => {
    const { db, calls } = makeDb({ purchase_orders: { rows: [PO_125423] } });

    const { rows, degraded } = await loadPOTruth(db, ["", "   "]);

    expect(rows).toEqual([]);
    expect(degraded).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("dedupes PO numbers and ignores DB rows for POs that were not requested", async () => {
    const { db } = makeDb({
      purchase_orders: { rows: [PO_125423, PO_125429] },
      shipments: { rows: [] },
      vendor_invoices: { rows: [] },
    });

    const { rows, degraded } = await loadPOTruth(db, ["125423", " 125423 ", "125423"]);

    expect(degraded).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].poNumber).toBe("125423");
    expect(rows[0].header.total).toBe(1234.5);
  });
});
