import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let dbInstance: Database.Database | null = null;

export function getLocalDb() {
    if (dbInstance) return dbInstance;

    const dbPath = path.join(process.cwd(), 'aria-local.db');
    
    // Ensure we aren't trying to open a directory
    if (fs.existsSync(dbPath) && fs.lstatSync(dbPath).isDirectory()) {
        throw new Error(`Cannot create database: ${dbPath} is a directory`);
    }

    dbInstance = new Database(dbPath);
    dbInstance.pragma('journal_mode = WAL'); // Better concurrency for multi-process
    dbInstance.pragma('synchronous = NORMAL'); // Balance speed and safety
    dbInstance.pragma('foreign_keys = ON');

    // Initialize Schema
    dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS purchasing_calendar_events (
            po_number TEXT PRIMARY KEY,
            event_id TEXT NOT NULL,
            calendar_id TEXT NOT NULL,
            status TEXT,
            last_tracking TEXT,
            title TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_cal_status ON purchasing_calendar_events(status);

        -- HERMIA(2026-05-28): Cognitive round decision log
        CREATE TABLE IF NOT EXISTS cognitive_rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ran_at TEXT NOT NULL DEFAULT (datetime('now')),
            state_json TEXT NOT NULL DEFAULT '{}',
            decisions_json TEXT NOT NULL DEFAULT '[]',
            duration_ms INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_cog_rounds_at ON cognitive_rounds(ran_at);

        -- KAIZEN(2026-05-29): Persistent dedup cache replacing in-memory Sets.
        -- Survives restarts — no boot-hydration needed.
        -- Namespaces: 'build_completions', 'received_pos', etc.
        -- expire_at allows auto-cleanup; NULL = never expires.
        CREATE TABLE IF NOT EXISTS dedup_cache (
            namespace TEXT NOT NULL,
            value TEXT NOT NULL,
            seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expire_at DATETIME,
            PRIMARY KEY (namespace, value)
        );
        CREATE INDEX IF NOT EXISTS idx_dedup_expire ON dedup_cache(expire_at);

        CREATE TABLE IF NOT EXISTS shipments_cache (
            tracking_number TEXT PRIMARY KEY,
            po_numbers TEXT, -- JSON array
            status_category TEXT,
            status_display TEXT,
            estimated_delivery_at DATETIME,
            delivered_at DATETIME,
            last_checked_at DATETIME,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- KAIZEN(2026-05-29): Browserbase session tracking for free tier usage control.
        -- Free tier = 100 sessions/month. Track usage, warn at 80, block at 95.
        CREATE TABLE IF NOT EXISTS browserbase_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bb_session_id TEXT,
            task_type TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            reused_count INTEGER DEFAULT 0,
            closed_at DATETIME,
            reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bb_monthly ON browserbase_sessions(created_at);
                CREATE INDEX IF NOT EXISTS idx_bb_task_reuse ON browserbase_sessions(task_type, expires_at);

                -- KAIZEN(2026-06-01): Receiving data cache — caches Finale PO shipment
                -- receiving data with TTL to avoid repeated API calls during reconciliation.
                CREATE TABLE IF NOT EXISTS receiving_cache (
                    po_number TEXT PRIMARY KEY,
                    received_qty_total REAL DEFAULT 0,
                    line_items_json TEXT NOT NULL DEFAULT '[]',
                    fully_received INTEGER DEFAULT 0,
                    last_receipt_date TEXT,
                    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    expire_at DATETIME NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_recv_cache_expire ON receiving_cache(expire_at);

        -- KAIZEN(2026-06-01): Crash-safe PO lifecycle cache (write-ahead log)
        -- Written FIRST in transitionLifecycleState before Supabase. Survives
        -- process crashes. Boot-hydrated on restart to catch missed transitions.
        -- KAIZEN(2026-06-18): Local-first AP invoice forwarding queue.
        -- Replaces Supabase ap_inbox_queue as the PRIMARY store for the critical
        -- path (Gmail -> Bill.com). Supabase is optional sync, not a dependency.
        -- Dedup is enforced by UNIQUE(gmail_message_id, pdf_filename).
        --
        -- LIFECYCLE: FORWARDED -> RECONCILED -> COMPLETE
        --   FORWARDED:  PDF sent to Bill.com via Gmail (critical path done)
        --   RECONCILED: Invoice matched to a Finale PO, pricing/shipping verified
        --   COMPLETE:   Invoice fully processed, archived, no further action needed
        --   ERROR:      Forward or processing failed (check error_message)
        CREATE TABLE IF NOT EXISTS ap_local_forwards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            gmail_message_id TEXT NOT NULL,
            email_from TEXT,
            email_subject TEXT,
            pdf_filename TEXT NOT NULL,
            pdf_content_hash TEXT NOT NULL,
            billcom_sent_message_id TEXT,
            status TEXT NOT NULL DEFAULT 'FORWARDED',
            reconciliation_status TEXT DEFAULT NULL,
            matched_po_number TEXT,
            reconciliation_notes TEXT,
            error_message TEXT,
            forwarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reconciled_at DATETIME,
            completed_at DATETIME,
            UNIQUE(gmail_message_id, pdf_filename)
        );

        -- Migration: add columns that may not exist on older DBs (safe — IF NOT EXISTS pattern)
        -- sqlite ALTER TABLE ADD COLUMN IF NOT EXISTS came in 3.35.0 (2021-03-12).
        -- Windows builds often lag; use a safe try/catch at runtime instead.
        -- Columns: ocr_raw_text (for reconciliation engine), vendor_routing_action (skip/dropship tracking),
        -- reconciliation_verdict, reconciliation_result_json (real engine output).

        CREATE INDEX IF NOT EXISTS idx_ap_fwd_status ON ap_local_forwards(status);
        CREATE INDEX IF NOT EXISTS idx_ap_fwd_hash ON ap_local_forwards(pdf_content_hash);
        CREATE INDEX IF NOT EXISTS idx_ap_fwd_recon ON ap_local_forwards(reconciliation_status);

        CREATE TABLE IF NOT EXISTS po_lifecycle_cache (
            po_number TEXT PRIMARY KEY,
            lifecycle_state TEXT NOT NULL DEFAULT 'ORDERED',
            last_transitioned_at TEXT NOT NULL,
            triggered_by TEXT,
            synced_to_supabase INTEGER DEFAULT 0
        );

        -- KAIZEN(2026-07-01): Bill.com reference data — imported from bill.com CSV exports.
        -- Used as a dedup check in ap-forwarder.ts to skip invoices already in Bill.com.
        -- UNIQUE(invoice_number, vendor_name) prevents both import-time and query-time dupes.
        CREATE TABLE IF NOT EXISTS billcom_bills_ref (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT NOT NULL,
            vendor_name TEXT NOT NULL,
            invoice_amount REAL,
            invoice_date TEXT,
            due_date TEXT,
            po_number TEXT,
            chart_of_account TEXT,
            bill_type TEXT,
            payment_status TEXT,
            currency TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(invoice_number, vendor_name)
        );
        CREATE INDEX IF NOT EXISTS idx_billcom_ref_vendor ON billcom_bills_ref(vendor_name);
        CREATE INDEX IF NOT EXISTS idx_billcom_ref_invoice ON billcom_bills_ref(invoice_number);

        -- Boot-time tables for local-first activity logging and shutdown persistence.
        -- Created here (not lazy) so they survive schema drift and are always available
        -- to activity-writer.ts and shutdown-guard.ts respectively.
        CREATE TABLE IF NOT EXISTS ap_activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            intent TEXT NOT NULL,
            action_taken TEXT,
            email_from TEXT,
            metadata TEXT DEFAULT '{}',
            reviewed_action TEXT,
            dismiss_reason TEXT,
            notes TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ap_activity_intent ON ap_activity_log(intent);
        CREATE INDEX IF NOT EXISTS idx_ap_activity_created ON ap_activity_log(created_at);

        CREATE TABLE IF NOT EXISTS sys_chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            role TEXT,
            content TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_source ON sys_chat_logs(source);

        -- KAIZEN(2026-07-15): PO and invoice caches for local-first matching.
        -- Populated by purchasing-cache.ts on read from PostgREST.
        -- TTL-based expiry: 1h for POs, 24h for invoices.
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

        -- KAIZEN(2026-07-15): Unified sync queue: SQLite → PostgREST.
        -- Used by sync-queue.ts for async, retry-capable sync of local cache writes.
        CREATE TABLE IF NOT EXISTS sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL DEFAULT 'upsert',
            payload_json TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 5,
            next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(table_name, record_id, operation)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_retry ON sync_queue(next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_sync_table ON sync_queue(table_name);
    `);

    // ── Lightweight migrations (ALTER TABLE for columns added after initial creation) ──
    // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we check pragma.
    const apCols = dbInstance.pragma("table_info(ap_local_forwards)") as Array<{ name: string }>;
    const apColNames = new Set(apCols.map(c => c.name));
    const apMigrations: Array<[string, string]> = [
        ["reconciliation_status", "ALTER TABLE ap_local_forwards ADD COLUMN reconciliation_status TEXT DEFAULT NULL"],
        ["matched_po_number", "ALTER TABLE ap_local_forwards ADD COLUMN matched_po_number TEXT"],
        ["reconciliation_notes", "ALTER TABLE ap_local_forwards ADD COLUMN reconciliation_notes TEXT"],
        ["reconciled_at", "ALTER TABLE ap_local_forwards ADD COLUMN reconciled_at DATETIME"],
        ["completed_at", "ALTER TABLE ap_local_forwards ADD COLUMN completed_at DATETIME"],
        ["vendor_routing_action", "ALTER TABLE ap_local_forwards ADD COLUMN vendor_routing_action TEXT"],
        ["verified", "ALTER TABLE ap_local_forwards ADD COLUMN verified INTEGER DEFAULT 0"],
        // Phase 3 (2026-07-09): OCR caching + real reconciliation engine output
        ["ocr_raw_text", "ALTER TABLE ap_local_forwards ADD COLUMN ocr_raw_text TEXT"],
        ["reconciliation_verdict", "ALTER TABLE ap_local_forwards ADD COLUMN reconciliation_verdict TEXT"],
        ["reconciliation_result_json", "ALTER TABLE ap_local_forwards ADD COLUMN reconciliation_result_json TEXT"],
    ];
    for (const [col, sql] of apMigrations) {
        if (!apColNames.has(col)) {
            try { dbInstance.exec(sql); } catch { /* already exists */ }
        }
    }

    return dbInstance;
}

// ── Dedup cache helpers (replacing in-memory Sets) ──────────────────────────

/**
 * Check if a value has been seen in a namespace.
 * Returns false if expired or never seen.
 */
export function dedupSeen(namespace: string, value: string): boolean {
    try {
        const db = getLocalDb();
        const row = db.prepare(
            `SELECT 1 FROM dedup_cache
             WHERE namespace = ? AND value = ?
             AND (expire_at IS NULL OR expire_at > datetime('now'))`
        ).get(namespace, value);
        return !!row;
    } catch {
        return false; // on DB error, assume not seen — safer to re-process than silently skip
    }
}

/**
 * Mark a value as seen in a namespace.
 * If ttlHours is provided, the entry auto-expires after that duration.
 * On insert failure, silently no-ops (dedup must never block processing).
 */
export function dedupMark(namespace: string, value: string, ttlHours?: number): void {
    try {
        const db = getLocalDb();
        if (ttlHours) {
            const expireAt = new Date(Date.now() + ttlHours * 3600000).toISOString();
            db.prepare(
                `INSERT OR REPLACE INTO dedup_cache (namespace, value, seen_at, expire_at)
                 VALUES (?, ?, datetime('now'), ?)`
            ).run(namespace, value, expireAt);
        } else {
            db.prepare(
                `INSERT OR REPLACE INTO dedup_cache (namespace, value, seen_at)
                 VALUES (?, ?, datetime('now'))`
            ).run(namespace, value);
        }
    } catch {
        // non-critical — dedup is best-effort
    }
}

/**
 * Count entries in a namespace (for hydration logging after startup).
 */
export function dedupCount(namespace: string): number {
    try {
        const db = getLocalDb();
        const row = db.prepare(
            `SELECT COUNT(*) as cnt FROM dedup_cache
             WHERE namespace = ?
             AND (expire_at IS NULL OR expire_at > datetime('now'))`
        ).get(namespace) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    } catch {
        return 0;
    }
}
