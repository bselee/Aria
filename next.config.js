/**
 * @file    next.config.js
 * @purpose Next.js configuration — skips in-build type-checking to prevent OOM.
 *          Type-checking is performed separately via `npm run typecheck`.
 * @author  Will / Antigravity
 * @created 2026-03-09
 * @updated 2026-06-11
 *
 * DECISION(2026-03-09): The project has ~112 TS files importing heavy typed
 * dependencies (telegraf, @googleapis/*, @slack/bolt, pinecone, openai, etc.).
 * Combined with large files (ops-manager.ts 112KB, start-bot.ts 107KB), the
 * TypeScript compiler exceeds 8GB heap during `next build`. Skipping the
 * in-build type-check and running it separately with the CLI excluded keeps
 * memory under control.
 * Alternative considered: splitting the monolith files — deferred because
 * the CLI/lib boundary fix is sufficient for now.
 */

const path = require('path');
const webpack = require('webpack');

/**
 * Regex for packages that require Node built-ins
 * crypto, stream, etc.) and MUST be externalized from the webpack server
 * bundle. Next.js's `serverExternalPackages` only handles top-level packages
 * in node_modules/. These patterns catch nested transitive dependencies
 * from @googleapis/*, agent-base, and other Node-native stacks.
 *
 * HERMIA(2026-06-11): Without this, webpack tries to bundle jws/jwa/
 * https-proxy-agent and fails because it can't resolve Node built-ins.
 */
const NODE_RUNTIME_EXTERNALS = [
    /^@googleapis\//,
    /^agent-base/,
    /^https?-proxy-agent/,
    /^gaxios/,
    /^google-auth-library/,
    /^googleapis-common/,
    /^jws\/?/,
    /^jwa\/?/,
    /^buffer-equal-constant-time/,
    /^ecdsa-sig-formatter/,
    /^pg\/?/,
    /^pgpass/,
    /^pg-connection-string/,
    /^pg-pool\/?/,
    /^pg-protocol/,
    /^pg-int8/,
    /^pg-types/,
    /^@supabase\//,
    /^supabase-js/,
];

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Lock workspace root to this project — prevents Next.js from traversing
    // parent directories when a stray package-lock.json exists at ~/BuildASoil/.
    outputFileTracingRoot: __dirname,
    async redirects() {
        return [
            {
                source: "/",
                destination: "/dashboard",
                permanent: false,
            },
        ];
    },
    typescript: {
        // DECISION(2026-03-09): Skip type-checking during `next build`.
        // Type-check separately: `npm run typecheck` (tsconfig.json — app code only).
        // The build OOM is caused by tsc resolving ~112 files + heavy deps in a
        // single pass. Next.js's built-in type-check duplicates this work.
        ignoreBuildErrors: true,
    },
    eslint: {
        // Also skip ESLint during build — run separately via `npm run lint`.
        ignoreDuringBuilds: true,
    },
    // DECISION(2026-03-09): Suppress punycode deprecation and other noisy
    // Node.js warnings that clutter build output.
    serverExternalPackages: [
        'telegraf',
        '@slack/bolt',
        '@slack/web-api',
        '@googleapis/gmail',
        '@googleapis/calendar',
        'node-cron',
        'chokidar',
        // HERMIA(2026-05-28): pdfkit MUST be external — it resolves font AFMs
        // (Helvetica.afm etc.) via `__dirname + '/data/...'`. When bundled by
        // Next.js into .next/server/chunks/, __dirname points to the chunk
        // directory which has no font data → PO PDF generation fails →
        // Gmail PO-email fallback broken. Keeping it external lets pdfkit
        // find its shipped fonts at node_modules/pdfkit/js/data/.
        'pdfkit',
    ],
    webpack: (config, { isServer }) => {
        // Use the 'buffer' polyfill package in the browser bundle
        // (Node's base64url encoding isn't supported by webpack's built-in polyfill)
        if (!isServer) {
            config.resolve.fallback = config.resolve.fallback || {};
            config.resolve.fallback.buffer = require.resolve('buffer/');
            config.plugins = config.plugins || [];
            config.plugins.push(
                new (webpack.ProvidePlugin)({
                    Buffer: ['buffer', 'Buffer'],
                })
            );
        }
        config.resolve.alias['@'] = isServer ? path.join(__dirname, 'src') : path.join(__dirname, '..', 'src');
        if (isServer) {
            // HERMIA(2026-06-11): Externalize the googleapis runtime stack
            // from the server webpack bundle. These packages require Node
            // built-ins (http, https, net, tls, crypto, stream) which
            // webpack can't resolve. Node handles them natively at runtime.
            config.externals = config.externals || [];
            config.externals.push(({ request }, callback) => {
                if (request && NODE_RUNTIME_EXTERNALS.some(re => re.test(request))) {
                    return callback(null, `commonjs ${request}`);
                }
                callback();
            });
            // HERMIA(2026-06-11): Node built-in modules must remain external
            // in the server bundle. Without this, webpack tries to resolve
            // require('fs'), require('path'), require('crypto') etc. and fails.
            const builtins = ['async_hooks', 'buffer', 'child_process', 'cluster',
                'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events',
                'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module',
                'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
                'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
                'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers',
                'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util',
                'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'];
            config.externals.push(({ request }, callback) => {
                if (request && (builtins.includes(request) || request.startsWith('node:'))) {
                    return callback(null, `commonjs ${request}`);
                }
                callback();
            });
        }
        return config;
    },
};

module.exports = nextConfig;
