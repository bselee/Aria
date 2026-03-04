require("dotenv").config({ path: __dirname + "/.env.local" });
const { Client } = require("pg");
async function run() {
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log("Tables:", r.rows.map(r => r.table_name).join(", "));
    const r2 = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='ap_activity_log' AND column_name IN ('reviewed_at','reviewed_action','dismiss_reason')");
    console.log("\nap_activity_log new columns:", r2.rows.map(r => r.column_name).join(", "));
    const r3 = await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='vendor_profiles' AND column_name IN ('auto_approve_threshold','reconciliation_count','approval_count','dismiss_count','avg_dollar_impact','last_reconciliation_at','default_dismiss_action')");
    console.log("vendor_profiles new columns:", r3.rows.map(r => r.column_name).join(", "));
    await c.end();
}
run().catch(e => console.error(e.message));
