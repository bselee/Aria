/**
 * @file    vitest.setup.ts
 * @purpose Test-isolation guardrails. Runs before every test file.
 * @author  Hermia
 * @created 2026-07-28
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * vitest does not load .env.local, so before this guard existed PGRST_URL was
 * undefined during tests and src/lib/db.ts fell through to a hardcoded
 * "http://localhost:5434". That made createClient() return a FULLY WORKING client
 * pointed at the developer's real PostgREST — so a test that forgot to mock the DB
 * did not fail loudly, it silently succeeded against LIVE DATA.
 *
 * Two files were caught doing exactly that (po-receipt-recheck.test.ts,
 * po-lifecycle.test.ts — zero vi.mock() calls between them, printing "9 POs
 * checked" from nine real purchase orders). Because their assertions are shape-only
 * (toHaveProperty, >= 0), any real DB response satisfied them; they could only fail
 * on infrastructure timing, which is what made the suite nondeterministic — the set
 * of failing files changed between identical runs under load.
 *
 * Those paths only read. The same fallback applies to WRITES, which is precisely how
 * a unit test previously wrote to production data in this repo.
 *
 * WHAT THIS DOES
 * --------------
 * Points every DB/network-ish env var at a deliberately unroutable address, so any
 * unmocked access fails FAST and OBVIOUSLY instead of quietly hitting a real system.
 * Combined with the guard in src/lib/db.ts (which throws rather than inventing an
 * endpoint under a test runner), unmocked DB access is now a hard error.
 *
 * ESCAPE HATCH — genuine integration tests opt in explicitly:
 *   ARIA_TEST_ALLOW_LIVE_DB=true npx vitest run <file>
 * When set, this file leaves the environment untouched so the real .env values
 * (or whatever the caller exported) apply.
 */

const ALLOW_LIVE = process.env.ARIA_TEST_ALLOW_LIVE_DB === "true";

if (!ALLOW_LIVE) {
  // 127.0.0.1:1 is reserved/unbound — connections fail immediately with ECONNREFUSED
  // rather than hanging until a timeout, which keeps the failure fast and legible.
  const DEAD = "http://127.0.0.1:1";

  process.env.PGRST_URL = DEAD;
  process.env.PGREST_URL = DEAD;
  process.env.SUPABASE_URL = DEAD;
  process.env.NEXT_PUBLIC_SUPABASE_URL = DEAD;
  process.env.DATABASE_URL = "postgresql://unrouted@127.0.0.1:1/nonexistent";

  // db.ts retries transient failures (incl. connection-refused) 3x with 1s/2s/4s
  // backoff — 7s+ of waiting, which blows vitest's default 5s testTimeout and turns
  // a clean "no DB here" signal into a confusing timeout. Collapse retries to a
  // single attempt so unmocked access fails FAST and legibly under test.
  process.env.ARIA_DB_MAX_RETRIES = "1";

  // Deterministic, obviously-fake credentials. Never real secrets: if a test somehow
  // does reach a live service, it must be rejected rather than authenticated.
  process.env.PGRST_JWT_SECRET = "test-only-not-a-real-secret";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-real-key";

  // Outbound side effects that must never fire from a unit test. Empty values make
  // the notify/send helpers no-op instead of contacting Telegram/Slack/Finale for real.
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.TELEGRAM_CHAT_ID = "";
  process.env.SLACK_BOT_TOKEN = "";
  process.env.SLACK_ACCESS_TOKEN = "";
  process.env.FINALE_API_KEY = "";
  process.env.FINALE_API_SECRET = "";

  // The AP forwarder is gated behind this and must stay OFF unless a test opts in,
  // so no test can accidentally exercise a Bill.com send path.
  process.env.DEPRECATED_FORWARDER_ENABLED = "false";
}
