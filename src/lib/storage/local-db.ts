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
