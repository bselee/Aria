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
    `);

    return dbInstance;
}
