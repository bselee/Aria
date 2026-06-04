/**
 * @file    next.config.js
 * @purpose Next.js configuration — skips in-build type-checking to prevent OOM.
 *          Type-checking is performed separately via `npm run typecheck`.
 * @author  Will / Antigravity
 * @created 2026-03-09
 * @updated 2026-03-09
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

/** @type {import('next').NextConfig} */
const nextConfig = {
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
};

module.exports = nextConfig;
