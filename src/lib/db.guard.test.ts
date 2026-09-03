/**
 * @file    src/lib/db.guard.test.ts
 * @purpose Proves the test-isolation guardrails actually engage. If these tests
 *          fail, unmocked DB access is silently reaching a real endpoint again.
 * @author  Hermia
 * @created 2026-07-28
 * @deps    vitest, vitest.setup.ts, src/lib/db.ts
 */
import { describe, expect, it } from "vitest";

import { createClient, probePostgrest } from "./db";

describe("test-isolation guardrails", () => {
    it("points DB env vars at an unroutable address, never the real PostgREST", () => {
        // vitest.setup.ts must have overridden these. localhost:5434 is the developer's
        // REAL PostgREST — if it ever appears here, the guard is not engaging and any
        // unmocked test can read/write live data.
        expect(process.env.PGRST_URL).toBe("http://127.0.0.1:1");
        expect(process.env.PGRST_URL).not.toContain("5434");
        expect(process.env.SUPABASE_URL).not.toContain("5434");
    });

    it("neutralizes outbound side-effect credentials", () => {
        // Empty => the notify/send helpers no-op instead of really contacting a service.
        expect(process.env.TELEGRAM_BOT_TOKEN).toBe("");
        expect(process.env.FINALE_API_KEY).toBe("");
        // The Bill.com forwarder gate must stay off unless a test opts in explicitly.
        expect(process.env.DEPRECATED_FORWARDER_ENABLED).not.toBe("true");
    });

    it("never uses a real-looking secret in tests", () => {
        expect(process.env.PGRST_JWT_SECRET).toBe("test-only-not-a-real-secret");
        expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe("test-only-not-a-real-key");
    });

    it("collapses the retry budget so unmocked access fails fast, not by timeout", () => {
        // Default is 3 attempts with 1s/2s/4s backoff (7s+), which exceeds vitest's 5s
        // testTimeout and disguises a clean "no DB" signal as a confusing timeout.
        expect(process.env.ARIA_DB_MAX_RETRIES).toBe("1");
    });

    it("returns an error (not live data) when an unmocked query executes", async () => {
        const db = createClient();
        expect(db).toBeTruthy();

        const { data, error } = await db!.from("purchase_orders").select("*").limit(1);

        // The whole point: an unmocked query must NOT come back with real rows.
        expect(error).toBeTruthy();
        expect(data).toBeFalsy();
    });

    it("probePostgrest reports the DB as unavailable instead of throwing", async () => {
        // Callers use this as a cheap gate and several treat a throw as fatal, so it
        // must stay non-throwing even while the guard is active.
        await expect(probePostgrest(500)).resolves.toBe(false);
    });
});
