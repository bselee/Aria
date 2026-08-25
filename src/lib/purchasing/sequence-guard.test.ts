/**
 * @file    src/lib/purchasing/sequence-guard.test.ts
 * @purpose Contract tests for checkSequences(): a desynced sequence must be
 *          AUTO-HEALED (setval called with seq, maxId, true) and reported;
 *          a healthy DB must return healed=[] without touching setval.
 *          pg is fully mocked — no live DB.
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    vitest, ./sequence-guard
 * @env     none (pg mocked)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSequences } from "./sequence-guard";

let mockRows: any[] = [];
let mockQueryError: Error | null = null;
let mockSetvalCalls: Array<{ sql: string; params?: any[] }> = [];

vi.mock("pg", () => ({
    Client: class {
        connect = vi.fn(async () => {});
        query = vi.fn(async (sql: string, params?: any[]) => {
            if (mockQueryError) throw mockQueryError;
            if (sql.trimStart().toUpperCase().startsWith("SELECT SETVAL")) {
                mockSetvalCalls.push({ sql, params });
                return { rows: [{ setval: 1 }] };
            }
            return { rows: mockRows };
        });
        end = vi.fn(async () => {});
    },
}));

beforeEach(() => {
    mockRows = [];
    mockQueryError = null;
    mockSetvalCalls = [];
});

describe("checkSequences", () => {
    it("auto-heals a desynced sequence via setval(seq, maxId, true) and reports the heal", async () => {
        mockRows = [
            {
                table_name: "qty_recommendations",
                column_name: "id",
                seq_name: "qty_recommendations_id_seq",
                seq_last: 14986,
                max_id: 49689,
            },
        ];

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(1);
        expect(mockSetvalCalls[0].params).toEqual(["qty_recommendations_id_seq", 49689]);
        expect(mockSetvalCalls[0].sql).toMatch(/setval\(\$1, \$2, true\)/i);
        expect(result).toEqual({
            checked: 1,
            healed: [
                {
                    table: "qty_recommendations",
                    column: "id",
                    seq: "qty_recommendations_id_seq",
                    oldLast: 14986,
                    maxId: 49689,
                },
            ],
        });
    });

    it("returns healed=[] and never calls setval when no sequences are desynced", async () => {
        mockRows = [];

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(0);
        expect(result).toEqual({ checked: 0, healed: [] });
    });

    it("never throws on connection/query failure — returns checked=0, healed=[]", async () => {
        mockQueryError = new Error("connection refused");

        const result = await checkSequences();

        expect(mockSetvalCalls).toHaveLength(0);
        expect(result).toEqual({ checked: 0, healed: [] });
    });
});
