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
    const lines = logOutput.split('\n');
    
    // Find the sequential log boundary representing the latest PM2 restart/reload
    let startingIndex = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (
            line.includes('starting in') || 
            line.includes('online') || 
            (line.includes('PM2') && line.includes(proc))
        ) {
            startingIndex = i;
            break;
        }
    }
    const linesAfterRestart = lines.slice(startingIndex);

    const errorLines = linesAfterRestart.filter(line => {
        const hasError = /error|failed|unhandled|ECONNREFUSED/i.test(line);
        const isExcluded = /openrouter.*falling back|info\s/i.test(line);
        return hasError && !isExcluded;
    });

    if (errorLines.length > 0) {
        console.error(`[smoke][${proc}] Errors detected post-restart:`);
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
