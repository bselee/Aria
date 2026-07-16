/**
 * Post-build script: patches the buffer polyfill in webpack chunks to
 * support base64url encoding. Run after `next build`.
 *
 * The buffer polyfill v6.x doesn't support Node's 'base64url' encoding.
 * Strategy: Add 'case"base64url":' after EVERY occurrence of 'case"base64":'
 * and '"base64url"' after EVERY '"base64"' in encoding lists.
 */
const fs = require('fs');
const path = require('path');

const CHUNKS_DIR = path.join(__dirname, '..', '.next', 'static', 'chunks');

function patchChunks() {
  if (!fs.existsSync(CHUNKS_DIR)) {
    console.log('  [patch-base64url] Chunks dir not found — skipping');
    return;
  }

  const files = fs.readdirSync(CHUNKS_DIR).filter(f => f.endsWith('.js'));
  let patched = 0;

  for (const file of files) {
    const filePath = path.join(CHUNKS_DIR, file);
    let c = fs.readFileSync(filePath, 'utf8');
    const orig = c;
    let mods = 0;

    // Pattern 1: case"base64": (anywhere in the file) — add case"base64url": after it
    // Only if base64url doesn't already follow
    c = c.replace(/case"base64":(?!case"base64url")/g, 'case"base64":case"base64url":');
    mods += (c.match(/case"base64url":/g) || []).length - (orig.match(/case"base64url":/g) || []).length;

    // Pattern 2: "base64" in encoding list strings — add "base64url" after it
    // Matches "base64","ucs2" etc.
    c = c.replace(/"base64","ucs2"/g, '"base64","base64url","ucs2"');
    c = c.replace(/"base64","ascii"/g, '"base64","base64url","ascii"');
    c = c.replace(/"base64","hex"/g, '"base64","base64url","hex"');

    // Pattern 3: "base64" as part of array-like encoding checks
    c = c.replace(/"base64","ucs2","ucs-2","utf16le","utf-16le"/g, '"base64","base64url","ucs2","ucs-2","utf16le","utf-16le"');
    c = c.replace(/"base64","ucs2","ucs-2","utf16le","utf-16le","raw"/g, '"base64","base64url","ucs2","ucs-2","utf16le","utf-16le","raw"');

    if (c !== orig) {
      fs.writeFileSync(filePath, c, 'utf8');
      patched++;
      const added = (c.match(/base64url/g) || []).length - (orig.match(/base64url/g) || []).length;
      const total = (c.match(/base64url/g) || []).length;
      console.log(`  [patch-base64url] ${file}: +${added} base64url, total ${total}`);
    }
  }

  console.log(`  [patch-base64url] Patched ${patched} chunk(s)`);
}

patchChunks();
