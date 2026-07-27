/**
 * @file scripts/verify-test-db-isolation.js
 * @purpose Guard against unit tests writing to the LIVE database. Snapshots row counts
 *          of write-prone tables, runs the full vitest suite, then reports any delta.
 *
 *          WHY THIS EXISTS (2026-07-27 incident): src/cron/history.test.ts mocked
 *          `../lib/supabase` while the code under test imported `../lib/db`
 *          (lib/supabase.ts is only a re-export). The mock never engaged, so the test
 *          ran against production. Its fixture payload (duration_ms=1234,
 *          error_message='boom'), combined with an unfiltered-PATCH bug in db.ts,
 *          stamped itself onto 125,202 production cron_runs rows and fabricated a
 *          "99.96% cron failure rate". It also left 32 junk task_name='x' rows.
 *
 *          Run this after touching any test that mocks a DB module.
 *
 *          NOTE ON INTERPRETING RESULTS: this machine runs live PM2 crons that
 *          legitimately write to cron_runs / ap_activity_log during the ~3 min suite
 *          window. A small positive delta on those tables is expected. The unambiguous
 *          red flags are fixture-shaped rows (task_name='x', error_message='boom',
 *          duration_ms=1234) — those are asserted explicitly below.
 *
 * @author Hermia
 * @created 2026-07-27
 * @deps pg, npx vitest
 * @env DATABASE_URL (defaults to the local aria DSN)
 * @usage node scripts/verify-test-db-isolation.js
 */
const { execSync } = require('child_process');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://aria:arialocal@localhost:5432/aria' });

const TABLES = ['cron_runs', 'ap_activity_log', 'purchase_orders', 'agent_task', 'agent_issue',
    'email_inbox_queue', 'invoices', 'vendor_invoices', 'shipments', 'task_history',
    'ops_alert_events', 'qty_recommendations', 'slack_requests', 'documents'];

async function snapshot() {
    const snap = {};
    for (const t of TABLES) {
        try {
            const r = await pool.query(`SELECT COUNT(*)::int n FROM "${t}"`);
            snap[t] = r.rows[0].n;
        } catch { snap[t] = null; }
    }
    return snap;
}

(async () => {
    console.log('snapshotting live row counts...');
    const before = await snapshot();

    console.log('running full vitest suite (this takes ~2-3 min)...');
    try {
        // stdio must be fully detached from a TTY: when this script itself runs as a
        // background process, inheriting stdin yields "stdin is not a tty" and vitest
        // aborts before the post-run count check can execute.
        execSync('npx vitest run --reporter=dot', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 600000,
        });
    } catch (e) { /* non-zero exit expected: pre-existing failures */ }

    const after = await snapshot();

    console.log('\ntable                      before     after     delta');
    for (const t of TABLES) {
        const d = (after[t] ?? 0) - (before[t] ?? 0);
        const flag = d !== 0 ? '  <-- changed (may be live cron activity)' : '';
        console.log(`${t.padEnd(24)} ${String(before[t]).padStart(7)} ${String(after[t]).padStart(9)} ${String(d).padStart(9)}${flag}`);
    }

    // The decisive check: fixture-shaped rows can ONLY come from a test whose DB mock
    // failed to engage. Live crons never produce these values.
    const fixtures = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM cron_runs WHERE task_name = 'x')                    AS junk_task_x,
      (SELECT COUNT(*)::int FROM cron_runs WHERE error_message = 'boom')             AS boom_rows,
      (SELECT COUNT(*)::int FROM cron_runs WHERE duration_ms = 1234)                 AS dur_1234,
      (SELECT COUNT(*)::int FROM cron_runs WHERE task_name ILIKE 'test%'
                                              OR task_name ILIKE '%sentinel%')       AS test_named
  `);
    const f = fixtures.rows[0];
    console.log('\nfixture-shaped rows (must all be 0):');
    for (const [k, v] of Object.entries(f)) console.log(`  ${k.padEnd(12)} ${v}`);

    const leaked = Object.values(f).reduce((a, b) => a + Number(b), 0);
    console.log(leaked === 0
        ? '\nPASS: no test fixture data reached the live database.'
        : `\nFAIL: ${leaked} fixture-shaped row(s) in production — a test mock is not engaging.`);
    await pool.end();
    process.exit(leaked === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
