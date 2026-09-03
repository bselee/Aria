/**
 * Apply a SQL migration file to the local Postgres (aria-db).
 * Run: node --env-file=.env.local scripts/run-migration.mjs supabase/migrations/20260812_vendor_invoices_extraction_quality.sql
 */
import fs from "fs";
import pg from "pg";

const { Client } = pg;

function getDsn() {
  const env = fs.readFileSync(".env.local", "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("DATABASE_URL not found in .env.local");
  return m[1].trim();
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node scripts/run-migration.mjs <migration.sql>");
  const sql = fs.readFileSync(file, "utf8");

  const client = new Client({ connectionString: getDsn() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`✅ Applied ${file}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`❌ Migration failed (rolled back): ${e.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
