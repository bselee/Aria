import 'dotenv/config';
import { getDatabase } from './src/lib/storage/vendor-invoices.js';

const db = getDatabase();
const res = await db.query(
  "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'skills' ORDER BY ordinal_position"
);
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

db.end();