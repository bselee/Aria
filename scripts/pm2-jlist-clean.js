// pm2-jlist-clean.js
// Reads pm2 jlist JSON from stdin, deduplicates keys, writes clean JSON to stdout.
// Usage: pm2 jlist | node pm2-jlist-clean.js | ConvertFrom-Json
process.stdin.resume();
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => process.stdout.write(JSON.stringify(JSON.parse(d))));
