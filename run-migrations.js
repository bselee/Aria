const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const client = new Client({
    host: "db.wvpgkyrbhvywdxnuxymn.supabase.co",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: "wtw!teh2ybp2mqg8QFR",
    ssl: { rejectUnauthorized: false },
});

const MIGRATIONS_DIR = path.join("c:", "Users", "BuildASoil", "Documents", "Projects", "aria", "supabase", "migrations");

async function main() {
    await client.connect();
    console.log("Connected to Supabase Postgres");

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    console.log("Migrations to run:", files);

    for (const file of files) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
        console.log("\n--- " + file + " ---");
        try {
            await client.query(sql);
            console.log("  OK");
        } catch (err) {
            console.log("  ERROR: " + err.message);
        }
    }

    // Verify tables exist
    console.log("\n=== Verification ===");
    const tables = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('ap_activity_log', 'vendor_profiles', 'invoices')"
    );
    console.log("Tables found:", tables.rows.map(r => r.table_name));

    // Check invoices columns
    const cols = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices' AND column_name IN ('tariff', 'labor', 'tracking_numbers')"
    );
    console.log("Invoice columns:", cols.rows.map(r => r.column_name));

    await client.query("NOTIFY pgrst, 'reload schema'");
    console.log("Schema cache reloaded.");

    await client.end();
    console.log("\nDone.");
}

main().catch(err => { console.error(err); process.exit(1); });
