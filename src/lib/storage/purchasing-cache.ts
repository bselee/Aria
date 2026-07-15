/**
 * @file    src/lib/storage/purchasing-cache.ts
 * @purpose Local-first cache for purchase orders and vendor invoices.
 *          Enables fast offline-capable PO matching and reconciliation
 *          without depending on PostgREST availability.
 *
 *          DESIGN:
 *            - Writes to SQLite FIRST (always available, sub-ms)
 *            - Async syncs to PostgREST (best-effort)
 *            - TTL-based expiry for cached records
 *            - Two-tier: hot (SQLite) / warm (PostgREST)
 *
 *          TABLES:
 *            po_cache      — mirrors purchase_orders table
 *            invoice_cache — mirrors vendor_invoices table
 *
 * @author  Hermia
 * @created 2026-07-15
 * @deps    @/lib/storage/local-db, @/lib/db (PostgREST sync)
 */

import { getLocalDb } from "./local-db";
import { createClient } from "../db";

// ── Schema init (idempotent) ───────────────────────────────────────────────

let schemaInitialized = false;

function ensureSchema(): void {
    if (schemaInitialized) return;
    const db = getLocalDb();
    db.exec(`
        CREATE TABLE IF NOT EXISTS po_cache (
            po_number TEXT PRIMARY KEY,
            vendor_name TEXT NOT NULL DEFAULT '',
            status TEXT,
            total_amount REAL DEFAULT 0,
            line_items TEXT DEFAULT '[]',
            tracking_numbers TEXT DEFAULT '[]',
            lifecycle_state TEXT,
            estimated_eta TEXT,
            po_sent_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            expire_at TEXT NOT NULL DEFAULT (datetime('now', '+1 hour'))
        );
        CREATE INDEX IF NOT EXISTS idx_po_cache_vendor ON po_cache(vendor_name);
        CREATE INDEX IF NOT EXISTS idx_po_cache_expire ON po_cache(expire_at);
        CREATE INDEX IF NOT EXISTS idx_po_cache_status ON po_cache(status);

        CREATE TABLE IF NOT EXISTS invoice_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendor_invoice_id TEXT UNIQUE,
            vendor_name TEXT NOT NULL,
            invoice_number TEXT,
            invoice_date TEXT,
            due_date TEXT,
            po_number TEXT,
            total REAL DEFAULT 0,
            freight REAL DEFAULT 0,
            tax REAL DEFAULT 0,
            status TEXT DEFAULT 'received',
            line_items TEXT DEFAULT '[]',
            source TEXT,
            matched_po TEXT,
            match_confidence TEXT,
            fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
            expire_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
        );
        CREATE INDEX IF NOT EXISTS idx_inv_cache_vendor ON invoice_cache(vendor_name);
        CREATE INDEX IF NOT EXISTS idx_inv_cache_po ON invoice_cache(po_number);
        CREATE INDEX IF NOT EXISTS idx_inv_cache_expire ON invoice_cache(expire_at);
    `);
    schemaInitialized = true;
}

// ── PO Cache ───────────────────────────────────────────────────────────────

export interface POCacheEntry {
    po_number: string;
    vendor_name: string;
    status: string | null;
    total_amount: number;
    line_items: string;          // JSON
    tracking_numbers: string;    // JSON array
    lifecycle_state: string | null;
    estimated_eta: string | null;
    po_sent_at: string | null;
    created_at: string | null;
    updated_at: string | null;
}

/**
 * Upsert a PO into local cache.
 */
export function upsertPOCache(po: Partial<POCacheEntry> & { po_number: string }): void {
    ensureSchema();
    const db = getLocalDb();

    const existing = db.prepare(
        `SELECT * FROM po_cache WHERE po_number = ?`
    ).get(po.po_number) as POCacheEntry | undefined;

    const merged: POCacheEntry = {
        po_number: po.po_number,
        vendor_name: po.vendor_name ?? existing?.vendor_name ?? '',
        status: po.status ?? existing?.status ?? null,
        total_amount: po.total_amount ?? existing?.total_amount ?? 0,
        line_items: po.line_items ?? existing?.line_items ?? '[]',
        tracking_numbers: po.tracking_numbers ?? existing?.tracking_numbers ?? '[]',
        lifecycle_state: po.lifecycle_state ?? existing?.lifecycle_state ?? null,
        estimated_eta: po.estimated_eta ?? existing?.estimated_eta ?? null,
        po_sent_at: po.po_sent_at ?? existing?.po_sent_at ?? null,
        created_at: po.created_at ?? existing?.created_at ?? null,
        updated_at: po.updated_at ?? existing?.updated_at ?? null,
    };

    const expireAt = new Date(Date.now() + 3600_000).toISOString(); // 1h TTL
    db.prepare(`
        INSERT INTO po_cache (po_number, vendor_name, status, total_amount, line_items, tracking_numbers, lifecycle_state, estimated_eta, po_sent_at, created_at, updated_at, fetched_at, expire_at)
        VALUES (@po_number, @vendor_name, @status, @total_amount, @line_items, @tracking_numbers, @lifecycle_state, @estimated_eta, @po_sent_at, @created_at, @updated_at, datetime('now'), ?)
        ON CONFLICT(po_number) DO UPDATE SET
            vendor_name = excluded.vendor_name,
            status = excluded.status,
            total_amount = excluded.total_amount,
            line_items = excluded.line_items,
            tracking_numbers = excluded.tracking_numbers,
            lifecycle_state = excluded.lifecycle_state,
            estimated_eta = excluded.estimated_eta,
            po_sent_at = excluded.po_sent_at,
            updated_at = excluded.updated_at,
            fetched_at = excluded.fetched_at,
            expire_at = excluded.expire_at
    `).run(expireAt, merged);
}

/**
 * Get a PO from local cache. Returns null if not cached or expired.
 */
export function getPOCache(poNumber: string): POCacheEntry | null {
    ensureSchema();
    const db = getLocalDb();
    const row = db.prepare(
        `SELECT * FROM po_cache WHERE po_number = ? AND expire_at > datetime('now')`
    ).get(poNumber) as POCacheEntry | undefined;
    return row ?? null;
}

/**
 * Search POs by vendor name (partial match).
 */
export function searchPOCache(vendorName: string): POCacheEntry[] {
    ensureSchema();
    const db = getLocalDb();
    return db.prepare(
        `SELECT * FROM po_cache WHERE vendor_name LIKE ? AND expire_at > datetime('now') ORDER BY po_number DESC`
    ).all(`%${vendorName}%`) as POCacheEntry[];
}

/**
 * Get all cached POs for a vendor.
 */
export function getVendorPOCache(vendorName: string): POCacheEntry[] {
    ensureSchema();
    const db = getLocalDb();
    return db.prepare(
        `SELECT * FROM po_cache WHERE vendor_name = ? AND expire_at > datetime('now') ORDER BY po_number DESC`
    ).all(vendorName) as POCacheEntry[];
}

// ── Invoice Cache ──────────────────────────────────────────────────────────

export interface InvoiceCacheEntry {
    vendor_invoice_id: string | null;
    vendor_name: string;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    po_number: string | null;
    total: number;
    freight: number;
    tax: number;
    status: string;
    line_items: string;          // JSON
    source: string | null;
    matched_po: string | null;
    match_confidence: string | null;
}

/**
 * Upsert an invoice into local cache.
 */
export function upsertInvoiceCache(inv: InvoiceCacheEntry): void {
    ensureSchema();
    const db = getLocalDb();

    const expireAt = new Date(Date.now() + 24 * 3600_000).toISOString(); // 24h TTL
    db.prepare(`
        INSERT INTO invoice_cache (vendor_invoice_id, vendor_name, invoice_number, invoice_date, due_date, po_number, total, freight, tax, status, line_items, source, matched_po, match_confidence, fetched_at, expire_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(vendor_invoice_id) DO UPDATE SET
            vendor_name = excluded.vendor_name,
            invoice_number = excluded.invoice_number,
            invoice_date = excluded.invoice_date,
            due_date = excluded.due_date,
            po_number = excluded.po_number,
            total = excluded.total,
            freight = excluded.freight,
            tax = excluded.tax,
            status = excluded.status,
            line_items = excluded.line_items,
            source = excluded.source,
            matched_po = excluded.matched_po,
            match_confidence = excluded.match_confidence,
            fetched_at = excluded.fetched_at,
            expire_at = excluded.expire_at
    `).run(
        inv.vendor_invoice_id,
        inv.vendor_name,
        inv.invoice_number,
        inv.invoice_date,
        inv.due_date,
        inv.po_number,
        inv.total,
        inv.freight,
        inv.tax,
        inv.status,
        inv.line_items,
        inv.source,
        inv.matched_po,
        inv.match_confidence,
        expireAt,
    );
}

/**
 * Find invoices in cache by vendor name (for matching).
 */
export function getInvoiceCacheByVendor(vendorName: string): InvoiceCacheEntry[] {
    ensureSchema();
    const db = getLocalDb();
    return db.prepare(
        `SELECT * FROM invoice_cache WHERE vendor_name = ? AND expire_at > datetime('now') ORDER BY invoice_date DESC`
    ).all(vendorName) as InvoiceCacheEntry[];
}

/**
 * Find invoice by PO number.
 */
export function getInvoiceCacheByPO(poNumber: string): InvoiceCacheEntry[] {
    ensureSchema();
    const db = getLocalDb();
    return db.prepare(
        `SELECT * FROM invoice_cache WHERE (po_number = ? OR matched_po = ?) AND expire_at > datetime('now') ORDER BY invoice_date DESC`
    ).all(poNumber, poNumber) as InvoiceCacheEntry[];
}

/**
 * Get all unmatched invoices (no PO match yet).
 */
export function getUnmatchedInvoices(): InvoiceCacheEntry[] {
    ensureSchema();
    const db = getLocalDb();
    return db.prepare(
        `SELECT * FROM invoice_cache WHERE (matched_po IS NULL OR matched_po = '') AND expire_at > datetime('now') ORDER BY invoice_date DESC`
    ).all() as InvoiceCacheEntry[];
}

// ── Reconciliation helpers ─────────────────────────────────────────────────

/**
 * Mark a PO as matched to an invoice in local cache.
 */
export function markPOMatched(poNumber: string, invoiceNumber: string, confidence: string): void {
    ensureSchema();
    const db = getLocalDb();
    db.prepare(`
        UPDATE invoice_cache SET matched_po = ?, match_confidence = ?, expire_at = datetime('now', '+24 hours')
        WHERE invoice_number = ?
    `).run(poNumber, confidence, invoiceNumber);
}

/**
 * Get cache stats for monitoring.
 */
export function getPurchasingCacheStats(): {
    pos: number;
    invoices: number;
    unmatched: number;
} {
    ensureSchema();
    const db = getLocalDb();
    const pos = (db.prepare(`SELECT COUNT(*) as c FROM po_cache WHERE expire_at > datetime('now')`).get() as any)?.c ?? 0;
    const invoices = (db.prepare(`SELECT COUNT(*) as c FROM invoice_cache WHERE expire_at > datetime('now')`).get() as any)?.c ?? 0;
    const unmatched = (db.prepare(`SELECT COUNT(*) as c FROM invoice_cache WHERE (matched_po IS NULL OR matched_po = '') AND expire_at > datetime('now')`).get() as any)?.c ?? 0;
    return { pos, invoices, unmatched };
}
