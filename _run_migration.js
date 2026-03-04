/**
 * @file    _run_migration.js
 * @purpose Apply one or more Supabase SQL migration files.
 *          Tries strategies in order: (1) direct pg, (2) Supabase Management API,
 *          (3) prints SQL for manual paste into the SQL Editor.
 * @author  Will
 * @created 2026-03-04
 * @updated 2026-03-04
 * @deps    dotenv, pg
 * @env     NEXT_PUBLIC_SUPABASE_URL, SUPABASE_DB_PASSWORD (or SUPABASE_SERVICE_ROLE_KEY)
 *
 * Usage:   node _run_migration.js supabase/migrations/<file1>.sql [file2.sql ...]
 * Example: node _run_migration.js supabase/migrations/20260304_add_reconciliation_review_columns.sql
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD || SERVICE_KEY;
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || null;

if (!SUPABASE_URL || !DB_PASSWORD) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_DB_PASSWORD in .env.local");
    process.exit(1);
}

const PROJECT_REF = SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1];
if (!PROJECT_REF) {
    console.error("Could not parse project ref from SUPABASE_URL:", SUPABASE_URL);
    process.exit(1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error("Usage: node _run_migration.js <path-to-sql-file> [file2.sql ...]");
    process.exit(1);
}

// Validate all files exist before attempting any
const migrations = files.map(f => {
    const full = path.resolve(f);
    if (!fs.existsSync(full)) {
        console.error("File not found:", full);
        process.exit(1);
    }
    return { name: path.basename(full), sql: fs.readFileSync(full, "utf-8") };
});

// ── Strategy 0: DATABASE_URL pooler connection (preferred) ─────────────────
async function tryPooler() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return false;
    console.log("Strategy 0: DATABASE_URL pooler connection");

    const { Client } = require("pg");
    const client = new Client({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
    });

    await client.connect();
    console.log("  Connected.\n");

    for (const m of migrations) {
        try {
            await client.query(m.sql);
            console.log("  ✅ " + m.name);
        } catch (err) {
            console.error("  ❌ " + m.name + " — " + err.message);
        }
    }

    await client.end();
    return true;
}

// ── Strategy 1: Direct pg connection ───────────────────────────────────────
async function tryPg() {
    const { Client } = require("pg");
    const host = "db." + PROJECT_REF + ".supabase.co";
    console.log("Strategy 1: Direct pg → " + host);

    const client = new Client({
        host,
        port: 5432,
        database: "postgres",
        user: "postgres",
        password: DB_PASSWORD,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
    });

    await client.connect();
    console.log("  Connected.\n");

    for (const m of migrations) {
        try {
            await client.query(m.sql);
            console.log("  ✅ " + m.name);
        } catch (err) {
            console.error("  ❌ " + m.name + " — " + err.message);
        }
    }

    await client.end();
    return true;
}

// ── Strategy 2: Supabase Management API ────────────────────────────────────
async function tryManagementAPI() {
    if (!MANAGEMENT_TOKEN) return false;
    console.log("Strategy 2: Supabase Management API");

    for (const m of migrations) {
        const url = "https://api.supabase.com/v1/projects/" + PROJECT_REF + "/database/query";
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + MANAGEMENT_TOKEN,
            },
            body: JSON.stringify({ query: m.sql }),
        });

        if (resp.ok) {
            console.log("  ✅ " + m.name);
        } else {
            const text = await resp.text();
            console.error("  ❌ " + m.name + " — " + resp.status + ": " + text.slice(0, 200));
        }
    }
    return true;
}

// ── Strategy 3: Fallback — print SQL for manual paste ──────────────────────
function printFallback() {
    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Could not connect via pg or Management API.");
    console.log("  Paste the SQL below into the Supabase SQL Editor:");
    console.log("  https://supabase.com/dashboard/project/" + PROJECT_REF + "/sql/new");
    console.log("══════════════════════════════════════════════════════════\n");

    for (const m of migrations) {
        console.log("-- ═══ " + m.name + " ═══");
        console.log(m.sql);
        console.log("");
    }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
    console.log("Project: " + PROJECT_REF);
    console.log("Migrations: " + migrations.map(m => m.name).join(", ") + "\n");

    try {
        const ok = await tryPooler();
        if (ok) return;
    } catch (err) {
        console.log("  pooler failed: " + err.message + "\n");
    }

    try {
        await tryPg();
        return;
    } catch (err) {
        console.log("  pg failed: " + err.message + "\n");
    }

    try {
        const ok = await tryManagementAPI();
        if (ok) return;
        console.log("  No SUPABASE_ACCESS_TOKEN set.\n");
    } catch (err) {
        console.log("  Management API failed: " + err.message + "\n");
    }

    printFallback();
}

main().catch(err => {
    console.error("Unexpected error:", err.message);
    process.exit(1);
});
