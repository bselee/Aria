/**
 * Post-build script: patches the buffer polyfill in webpack chunks to
 * support base64url encoding. Run after `next build`.
 *
 * Usage: automatically via `npm run build`
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
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Pattern: isEncoding switch that lists base64 without base64url
    // Matches: case"base64":case"ucs2" or case"base64":case"base64url": (already patched)
    const p1 = /case"base64":case"ucs2"/g;
    if (p1.test(content)) {
      content = content.replace(p1, 'case"base64":case"base64url":case"ucs2"');
      modified = true;
    }

    // Pattern 2: encoding check with "base64","ucs2"
    const p2 = /"base64","ucs2","ucs-2","utf16le","utf-16le":return!0/g;
    if (p2.test(content)) {
      content = content.replace(p2, '"base64","base64url","ucs2","ucs-2","utf16le","utf-16le":return!0');
      modified = true;
    }

    // Pattern 3: raw isEncoding in fromString
    // Matches: case"base64":case"base64url": (already good) or case"base64":case"utf8": (rare)
    const p3 = /case"base64":(?=case"utf8"|case"ascii"|case"latin1"|case"binary"|case"hex")/g;
    if (p3.test(content)) {
      content = content.replace(p3, 'case"base64":case"base64url":');
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(filePath, content, 'utf8');
      patched++;
      console.log(`  [patch-base64url] Patched ${file}`);
    }
  }

  console.log(`  [patch-base64url] ${patched} chunk(s) patched for base64url support`);
}

patchChunks();
