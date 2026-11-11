/**
 * @file    scripts/vacuum-sqlite.js
 * @purpose Produce a compact, defragmented copy of a SQLite database using
 *          `VACUUM INTO`. Used by the portability packer (scripts/portability-pack.sh)
 *          so aria-local.db ships lean instead of a 1.1 GB plain copy. Falls back
 *          safely: any failure exits non-zero and the caller plain-copies instead.
 * @usage   node scripts/vacuum-sqlite.js <source.db> <dest.db>
 * @deps    better-sqlite3 (already in the Aria repo's node_modules); Node 24
 *          (bare `node` on this host can resolve to Node 26 and break the
 *          native better-sqlite3 binding — pin Node 24 when invoking).
 * @env     none
 * @author  Hermia
 * @created 2026-11-11
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Copy a SQLite database into a freshly vacuumed file.
 * @param {string} src absolute or relative path to the source database
 * @param {string} dest destination path (must not already exist)
 * @returns {string} the destination path
 * @throws {Error} when args are missing, the source is absent, or dest exists
 */
function vacuumInto(src, dest) {
  if (!src || !dest) {
    throw new Error('usage: node scripts/vacuum-sqlite.js <source.db> <dest.db>');
  }
  const source = path.resolve(src);
  const target = path.resolve(dest);
  if (!fs.existsSync(source)) {
    throw new Error(`source database not found: ${source}`);
  }
  if (fs.existsSync(target)) {
    throw new Error(`destination already exists: ${target}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const Database = require('better-sqlite3');
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    // VACUUM INTO requires the destination as a single-quoted SQL string literal
    // (double quotes parse as identifiers, and bound params are not reliably
    // accepted in the INTO expression) — escape embedded single quotes.
    const literal = target.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${literal}'`);
  } finally {
    db.close();
  }
  return target;
}

if (require.main === module) {
  try {
    const out = vacuumInto(process.argv[2], process.argv[3]);
    const bytes = fs.statSync(out).size;
    console.log(`vacuumed -> ${out} (${(bytes / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    console.error(`vacuum-sqlite: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { vacuumInto };
