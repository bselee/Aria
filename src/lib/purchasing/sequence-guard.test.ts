/**
 * @file    src/lib/purchasing/sequence-guard.test.ts
 * @purpose Contract tests for checkSequences(): a desynced sequence must be
 *          AUTO-HEALED (setval called with seq, maxId, true) and reported;
 *          a healthy DB must return healed=[] without touching setval.
 *          pg is fully mocked — no live DB. The mock dispatches on the SQL
 *          text to mirror the per-table loop (serials → last_value → MAX → setval).
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    vitest, ./sequence-guard
 * @env     none (pg mocked)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSequences } from "./sequence-guard";

let serials: any[] = [];
let lastValue: number | null = null;
let maxId: number = 0;
let mockConnectError: Error | null = null;
let mockSetvalCalls: Array<{ sql: string; params?: any[] }> = [];

vi.mock("pg", () => ({
    Client: class {
        connect = vi.fn(async () => {
            if (mockConnectError) throw mockConnectError;
        });
        query = vi.fn(async (sql: string, params?: any[]) => {
            if (/setval/i.test(sql)) {
                mockSetvalCalls.push({ sql, params });
                return { rows: [{ setval: 1 }] };
            }
            if (/pg_sequences/.test(sql)) {
                return { rows: lastValue == null ? [] : [{ last_value: lastValue }] };
            }
            if (/MAX\(/.test(sql)) {
                return { rows: [{ max_id: maxId }] };
            }
            // SERIAL_COLUMNS_SQL
            return { rows: serials };
        });
        end = vi.fn(async () => {});
    },
}));

beforeEach(() => {
    serials = [];
    lastValue = null;
    maxId = 0;
    mockConnectError = null;
    mockSetvalCalls = [];
});

const SERIAL_ROW = {
    schema_name: "public",
    table_name: "qty_recommendations",
    column_name: "id",
    seq_name: "public.qty_recommendations_id_seq",
};

describe("checkSequences", () => {
    it("auto-heals a desynced sequence via setval(seq, maxId, true) and reports the heal", async () => {
        serials = [SERIAL_ROW];
        lastValue = 14986;
        maxId = 49689;

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(1);
        expect(mockSetvalCalls[0].params).toEqual(["public.qty_recommendations_id_seq", 49689]);
        expect(mockSetvalCalls[0].sql).toMatch(/setval\(\$1, \$2, true\)/i);
        expect(result).toEqual({
            checked: 1,
            healed: [
                {
                    table: "qty_recommendations",
                    column: "id",
                    seq: "public.qty_recommendations_id_seq",
                    oldLast: 14986,
                    maxId: 49689,
                },
            ],
        });
    });

    it("does not heal when max(id) is not past the sequence", async () => {
        serials = [SERIAL_ROW];
        lastValue = 51572;
        maxId = 51572;

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(0);
        expect(result.healed).toEqual([]);
        expect(result.checked).toBe(1);
    });

    it("heals when the sequence has never been called (last_value absent)", async () => {
        serials = [SERIAL_ROW];
        lastValue = null;
        maxId = 100;

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(1);
        expect(result.healed[0].maxId).toBe(100);
    });

    it("returns healed=[] and never calls setval when no serial columns exist", async () => {
        serials = [];

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(0);
        expect(result).toEqual({ checked: 0, healed: [] });
    });

    it("never throws on connection failure — returns checked=0, healed=[]", async () => {
        mockConnectError = new Error("connection refused");

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(0);
        expect(result).toEqual({ checked: 0, healed: [] });
    });
});
