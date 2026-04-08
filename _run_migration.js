const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

async function runMigration(sqlPath) {
  const sql = fs.readFileSync(sqlPath, 'utf-8');

  // Strategy 1: Try pooler connection (DATABASE_URL) — preferred
  if (process.env.DATABASE_URL) {
    try {
      console.log('🔌 Connecting via DATABASE_URL (pooler)...');
      const db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      await db.query(sql);
      console.log(`✅ Applied: ${sqlPath}`);
      await db.end();
      return;
    } catch (err) {
      console.warn('⚠️  DATABASE_URL failed, falling back to direct host:', err.message);
    }
  }

  // Strategy 2: Extract project ref from SUPABASE_URL and connect to db.<ref>.supabase.co
  const refMatch = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([^.]+)/);
  if (!refMatch) {
    throw new Error('❌ Cannot extract project ref from NEXT_PUBLIC_SUPABASE_URL');
  }
  const ref = refMatch[1];
  const host = `db.${ref}.supabase.co`;

  const password = process.env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!password) {
    throw new Error('❌ SUPABASE_DB_PASSWORD or SUPABASE_SERVICE_ROLE_KEY required');
  }

  console.log(`🔌 Connecting to ${host}...`);
  const db = new Client({
    host,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await db.connect();
    await db.query(sql);
    console.log(`✅ Applied: ${sqlPath}`);
  } finally {
    await db.end();
  }
}

const migrationFile = process.argv[2];
if (!migrationFile) {
  console.error('Usage: node _run_migration.js <migration-file.sql>');
  process.exit(1);
}

runMigration(migrationFile).catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
