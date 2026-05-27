/**
 * @file    smoke.js
 * @purpose Cross-platform Node.js replacement for scripts/smoke.sh.
 *          Verifies PM2 process logs and checks Next.js chunk consistency.
 * @author  Will / Antigravity
 * @created 2026-05-27
 */

const { execSync } = require('child_process');
const http = require('http');

const proc = process.argv[2];
if (!proc) {
    console.error('Usage: node scripts/smoke.js <pm2-process-name>');
    process.exit(1);
}

console.log(`[smoke] starting post-restart check for PM2 process: ${proc}`);

// 1. Wait briefly for restart to settle
execSync('node -e "setTimeout(() => {}, 5000)"');

// 2. Check PM2 logs for current-hour errors
try {
    const logOutput = execSync(`pm2 logs ${proc} --lines 200 --nostream`, { encoding: 'utf8' });
    const now = new Date();
    // format as YYYY-MM-DD HH:
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const date = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const hourPrefix = `${year}-${month}-${date} ${hour}:`;

    const lines = logOutput.split('\n');
    const errorLines = lines.filter(line => {
        // filter for current hour, check error keywords, exclude openrouter fallback warnings
        const hasHour = line.includes(hourPrefix);
        const hasError = /error|failed|unhandled|ECONNREFUSED/i.test(line);
        const isExcluded = /openrouter.*falling back|info\s/i.test(line);
        return hasHour && hasError && !isExcluded;
    });

    if (errorLines.length > 0) {
        console.error(`[smoke][${proc}] Errors detected in current-hour window:`);
        console.error(errorLines.join('\n'));
        process.exit(1);
    }
} catch (logErr) {
    console.warn(`[smoke][${proc}] Warning: Could not read PM2 logs: ${logErr.message}`);
}

// 3. Dashboard-specific HTTP probe
if (proc === 'aria-dashboard') {
    const url = 'http://localhost:3001/dashboard';
    console.log(`[smoke][${proc}] Pinging live dashboard at ${url}...`);

    http.get(url, (res) => {
        if (res.statusCode !== 200) {
            console.error(`[smoke][${proc}] Dashboard returned HTTP ${res.statusCode} — expected 200`);
            process.exit(1);
        }

        let html = '';
        res.on('data', (chunk) => { html += chunk; });
        res.on('end', () => {
            if (!html) {
                console.error(`[smoke][${proc}] Dashboard returned empty HTML`);
                process.exit(1);
            }

            // Extract dashboard page chunk matching Next.js compile patterns
            const match = html.match(/\/_next\/static\/chunks\/app\/dashboard\/page-[a-f0-9]+\.js/);
            if (!match) {
                console.error(`[smoke][${proc}] Served HTML has no dashboard page chunk reference`);
                process.exit(1);
            }

            const chunkPath = match[0];
            console.log(`[smoke][${proc}] Found active JS chunk path: ${chunkPath}`);

            // Fetch the static chunk to verify it exists on disk and is not stale
            const chunkUrl = `http://localhost:3001${chunkPath}`;
            http.get(chunkUrl, (chunkRes) => {
                if (chunkRes.statusCode !== 200) {
                    console.error(`[smoke][${proc}] Static chunk ${chunkPath} returned HTTP ${chunkRes.statusCode} — rebuild required`);
                    process.exit(1);
                }
                console.log(`[smoke][${proc}] Clean. Chunk verified with HTTP 200.`);
                process.exit(0);
            }).on('error', (chunkErr) => {
                console.error(`[smoke][${proc}] Failed to fetch static chunk: ${chunkErr.message}`);
                process.exit(1);
            });
        });
    }).on('error', (err) => {
        console.error(`[smoke][${proc}] Dashboard did not respond on :3001: ${err.message}`);
        process.exit(1);
    });
} else {
    console.log(`[smoke][${proc}] Clean.`);
    process.exit(0);
}
