require('dotenv').config({ path: '.env.local' });
const { Client } = require('pg');

console.log('DATABASE_URL:', process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 40) + '...' : 'NOT SET');

const db = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  try {
    await db.connect();
    console.log('Connected successfully!');
    
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
  } catch (e) {
    console.error('Error:', e.message);
  }
  await db.end();
}

main().catch(console.error);