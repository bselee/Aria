/**
 * @file    src/lib/finale/core-client-queue.test.ts
 * @purpose Queue-lane tests: interactive Finale calls must outrank background
 *          scan work, and a starved background item must still get through.
 * @author  Hermia
 * @created 2026-10-29
 * @deps    vitest
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FinaleCoreClient } from "./core-client";

const queue = () => (FinaleCoreClient as any).requestQueue as Array<{
    run: () => Promise<void>;
    low: boolean;
    enqueuedAt: number;
}>;

function entry(low: boolean, ageMs = 0) {
    return { run: async () => {}, low, enqueuedAt: Date.now() - ageMs };
}

describe("FinaleCoreClient queue lanes", () => {
    beforeEach(() => {
        queue().length = 0;
    });

    it("runs interactive work before older background work", () => {
        queue().push(entry(true));
        queue().push(entry(false));

        const next = (FinaleCoreClient as any).takeNext();

        expect(next.low).toBe(false);
        expect(queue()).toHaveLength(1);
        expect(queue()[0].low).toBe(true);
    });

    it("still runs background work when nothing interactive is waiting", () => {
        queue().push(entry(true));

        const next = (FinaleCoreClient as any).takeNext();

        expect(next.low).toBe(true);
        expect(queue()).toHaveLength(0);
    });

    it("promotes a background item that has starved past 45s", () => {
        queue().push(entry(true, 60_000));
        queue().push(entry(false));

        const next = (FinaleCoreClient as any).takeNext();

        expect(next.low).toBe(true);
    });

    it("marks work inside runLowPriority as background", async () => {
        const store = await FinaleCoreClient.runLowPriority(async () =>
            (FinaleCoreClient as any).bgContext.getStore(),
        );

        expect(store).toBe(true);
        expect((FinaleCoreClient as any).bgContext.getStore()).toBeUndefined();
    });
});
