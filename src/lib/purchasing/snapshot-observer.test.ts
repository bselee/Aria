/**
 * @file    src/lib/purchasing/snapshot-observer.test.ts
 * @purpose Contract tests for checkSnapshotPersistence(): healthy iff at least
 *          one qty_recommendations row was written in the last 24h. pg is
 *          fully mocked — no live DB.
 *
 * @author  Hermia
 * @created 2026-08-25
 * @deps    vitest, ./snapshot-observer
 * @env     none (pg mocked)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSnapshotPersistence } from "./snapshot-observer";

let mockCount: number = 0;
let mockQueryError: Error | null = null;

vi.mock("pg", () => ({
    Client: class {
        connect = vi.fn(async () => {});
        query = vi.fn(async () => {
            if (mockQueryError) throw mockQueryError;
            return { rows: [{ n: mockCount }] };
        });
        end = vi.fn(async () => {});
    },
}));

beforeEach(() => {
    mockCount = 0;
    mockQueryError = null;
});

describe("checkSnapshotPersistence", () => {
    it("reports healthy=true when rows were written in the last 24h", async () => {
        mockCount = 42;

        const result = await checkSnapshotPersistence();

        expect(result).toEqual({ count24h: 42, healthy: true });
    });

    it("reports healthy=false when zero rows were written in the last 24h", async () => {
        mockCount = 0;

        const result = await checkSnapshotPersistence();

        expect(result).toEqual({ count24h: 0, healthy: false });
    });

    it("never throws on connection/query failure — fails closed to healthy=false", async () => {
        mockQueryError = new Error("connection refused");

        const result = await checkSnapshotPersistence();

        expect(result).toEqual({ count24h: 0, healthy: false });
    });
});
