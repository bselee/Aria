/**
 * @file    src/lib/intelligence/ap-health-report.test.ts
 * @purpose Unit tests for the local-forwards (24h) section of the morning AP
 *          health report — 2026-09-17 plan 4.2. Verifies the query shape against
 *          a mocked local SQLite so a schema drift or a bad LIKE pattern fails
 *          here instead of silently blanking the morning report.
 * @author  Hermia
 * @created 2026-09-17
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { localDbState } = vi.hoisted(() => ({
    localDbState: {
        counts: { forwarded: 0, nullInv: 0 } as Record<string, number>,
        gateFlags: [] as Array<{ email_subject: string; note: string }>,
        suspects: [] as Array<{ email_subject: string; note: string }>,
        throws: false,
        lastSql: [] as string[],
    },
}));

vi.mock("@/lib/storage/local-db", () => ({
    getLocalDb: vi.fn(() => {
        if (localDbState.throws) throw new Error("sqlite locked");
        return {
            prepare: vi.fn((sql: string) => {
                localDbState.lastSql.push(sql);
                return {
                    get: vi.fn(() => localDbState.counts),
                    all: vi.fn(() =>
                        sql.includes("suspect:") ? localDbState.suspects : localDbState.gateFlags,
                    ),
                };
            }),
        };
    }),
}));

import { getLocalForwardStats24h } from "./ap-health-report";

beforeEach(() => {
    localDbState.counts = { forwarded: 0, nullInv: 0 };
    localDbState.gateFlags = [];
    localDbState.suspects = [];
    localDbState.throws = false;
    localDbState.lastSql = [];
});

describe("getLocalForwardStats24h", () => {
    it("returns zeroes when nothing forwarded in 24h", async () => {
        const stats = await getLocalForwardStats24h();
        expect(stats).toEqual({ forwarded: 0, nullInv: 0, gateFlags: [], suspects: [] });
    });

    it("returns forwarded count and missing-invoice count", async () => {
        localDbState.counts = { forwarded: 7, nullInv: 2 };
        const stats = await getLocalForwardStats24h();
        expect(stats.forwarded).toBe(7);
        expect(stats.nullInv).toBe(2);
    });

    it("coerces a null SUM() to 0 instead of NaN", async () => {
        localDbState.counts = { forwarded: 0, nullInv: null as unknown as number };
        const stats = await getLocalForwardStats24h();
        expect(stats.nullInv).toBe(0);
        expect(Number.isNaN(stats.nullInv)).toBe(false);
    });

    it("scopes every query to the last 24h", async () => {
        await getLocalForwardStats24h();
        expect(localDbState.lastSql).toHaveLength(3);
        for (const sql of localDbState.lastSql) {
            expect(sql).toContain("datetime('now', '-1 day')");
            expect(sql).toContain("ap_local_forwards");
        }
    });

    it("excludes clean passes from the gate-flag query", async () => {
        await getLocalForwardStats24h();
        const gateSql = localDbState.lastSql.find((s) => s.includes("ocr-gate:")) ?? "";
        expect(gateSql).toContain("LIKE '%ocr-gate:%'");
        expect(gateSql).toContain("NOT LIKE '%ocr-gate:pass%'");
    });

    it("surfaces gate flags and suspect subjects", async () => {
        localDbState.gateFlags = [
            { email_subject: "CR ticket scan", note: "ocr-gate:no_invoice_number" },
        ];
        localDbState.suspects = [
            { email_subject: "FedEx Freight vs Buildasoil LLC", note: "suspect:dispute-letter" },
        ];
        const stats = await getLocalForwardStats24h();
        expect(stats.gateFlags).toHaveLength(1);
        expect(stats.gateFlags[0].note).toContain("no_invoice_number");
        expect(stats.suspects).toHaveLength(1);
        expect(stats.suspects[0].note).toContain("dispute-letter");
    });

    it("degrades to zeros if the local ledger is unavailable (never throws)", async () => {
        localDbState.throws = true;
        const stats = await getLocalForwardStats24h();
        expect(stats).toEqual({ forwarded: 0, nullInv: 0, gateFlags: [], suspects: [] });
    });
});
