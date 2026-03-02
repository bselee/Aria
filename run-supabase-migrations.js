/**
 * Run Supabase migrations via the Management API /query endpoint.
 * This uses the service role key to authenticate.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "Users", "BuildASoil", "Documents", "Projects", "aria", ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = SUPABASE_URL?.match(/https:\/\/([^.]+)/)?.[1];

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY");
    process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, "..", "Users", "BuildASoil", "Documents", "Projects", "aria", "supabase", "migrations");

async function runSQL(sql, label) {
    console.log(`\n=== Running: ${label} ===`);

    // Try the pg/query endpoint (Supabase v2 Management API)
    const url = `${SUPABASE_URL}/rest/v1/rpc/exec_sql`;

    // Actually, use direct fetch to the Supabase SQL endpoint
    // The /pg endpoint requires the management API key, not service role
    // Let's try creating tables via the PostgREST API indirectly
    // by using the service role key with the SQL endpoint

    const pgUrl = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

    try {
        const resp = await fetch(pgUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${SERVICE_KEY}`,
            },
            body: JSON.stringify({ query: sql }),
        });

        if (resp.ok) {
            const data = await resp.json();
            console.log(`  ✅ Success`);
            return true;
        } else {
            const text = await resp.text();
            console.log(`  ❌ Management API failed (${resp.status}): ${text.slice(0, 200)}`);
            return false;
        }
    } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        return false;
    }
}

async function main() {
    console.log(`Project: ${PROJECT_REF}`);
    console.log(`URL: ${SUPABASE_URL}`);
    console.log(`Migrations dir: ${MIGRATIONS_DIR}`);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    console.log(`Found ${files.length} migration files: ${files.join(", ")}`);

    let allSuccess = true;
    for (const file of files) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
        const ok = await runSQL(sql, file);
        if (!ok) allSuccess = false;
    }

    if (!allSuccess) {
        console.log("\n⚠️  Some migrations failed via Management API.");
        console.log("Trying alternative: direct SQL via Supabase pooler...\n");

        // Try pg module if available
        try {
            const { Client } = require("pg");
            const client = new Client({
                host: `db.${PROJECT_REF}.supabase.co`,
                port: 5432,
                database: "postgres",
                user: "postgres",
                password: SERVICE_KEY,
                ssl: { rejectUnauthorized: false },
            });
            await client.connect();
            console.log("Connected via pg!");

            for (const file of files) {
                const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
                try {
                    await client.query(sql);
                    console.log(`  ✅ ${file} - Success`);
                } catch (err) {
                    console.log(`  ❌ ${file} - ${err.message}`);
                }
            }

            await client.end();
        } catch (pgErr) {
            console.log("pg module not available: " + pgErr.message);
            console.log("\nFinal fallback: Please run these in the Supabase SQL Editor.");
        }
    }
}

main();
