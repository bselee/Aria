import 'dotenv/config';
import pg from 'pg';
const { Client } = pg;

console.log('NEXT_PUBLIC_SUPABASE_URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);

const refMatch = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/https:\/\/([^.]+)/);
console.log('refMatch:', refMatch);
const ref = refMatch?.[1];
const host = `db.${ref}.supabase.co`;
const password = process.env.SUPABASE_DB_PASSWORD || process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('Host:', host);
console.log('Has password:', !!password);

const db = new Client({
  host,
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password,
  ssl: { rejectUnauthorized: false },
});

await db.connect();

const res = await db.query(
  "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'skills' ORDER BY ordinal_position"
);
console.log('Columns:');
console.log(JSON.stringify(res.rows, null, 2));

const idxRes = await db.query(
  "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'skills'"
);
console.log('\nIndexes:');
console.log(JSON.stringify(idxRes.rows, null, 2));

const conRes = await db.query(
  "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'skills'::regclass"
);
console.log('\nConstraints:');
console.log(JSON.stringify(conRes.rows, null, 2));

await db.end();