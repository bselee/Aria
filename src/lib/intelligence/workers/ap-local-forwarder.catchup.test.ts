/**
 * @file    ap-local-forwarder.catchup.test.ts
 * @purpose Unit tests for the catch-up pass selector. The pipeline's primary
 *          fetch requires INBOX AND UNREAD, which is how DestiNation 9483171 /
 *          9482006 and Evergreen 150323 were never seen (2026-10-07 audit).
 *          The rule that must never regress: a message Aria has already decided
 *          on (forwarded OR skipped) is never re-entered, no matter how the
 *          catch-up query is widened.
 * @author  Hermia
 * @created 2026-10-07
 * @deps    vitest, ap-local-forwarder.ts (pure helper only — no Gmail/DB)
 */

import { describe, expect, it } from "vitest";
import { selectCatchupIds } from "./ap-local-forwarder";

describe("selectCatchupIds — catch-up pass selector", () => {
    it("takes recent mail the primary INBOX+UNREAD fetch cannot see", () => {
        // Gmail filed both DestiNation invoices to CATEGORY_UPDATES with no INBOX
        // label, so labelIds:["INBOX","UNREAD"] never returned them.
        const listed = [{ id: "a" }, { id: "b" }];
        expect(selectCatchupIds(listed, [], [])).toEqual(["a", "b"]);
    });

    it("never re-enters a message already returned by the primary fetch", () => {
        const listed = [{ id: "a" }, { id: "b" }];
        expect(selectCatchupIds(listed, ["a"], [])).toEqual(["b"]);
    });

    it("never re-enters a message already recorded in ap_local_forwards", () => {
        const listed = [{ id: "a" }, { id: "b" }, { id: "c" }];
        expect(selectCatchupIds(listed, [], ["a", "c"])).toEqual(["b"]);
    });

    it("excludes ids recorded as SKIPPED as well as FORWARDED", () => {
        // recordSkippedForward writes rows too; a skipped non-invoice must not be
        // re-examined every cycle.
        const listed = [{ id: "skipped-row" }, { id: "new-row" }];
        expect(selectCatchupIds(listed, [], ["skipped-row"])).toEqual(["new-row"]);
    });

    it("drops entries with no id", () => {
        expect(selectCatchupIds([{ id: null }, {}, { id: "a" }], [], [])).toEqual(["a"]);
    });

    it("applies the per-cycle cap", () => {
        const listed = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
        expect(selectCatchupIds(listed, [], [], 2)).toEqual(["a", "b"]);
    });

    it("caps only what it takes, not what it counts", () => {
        // The caller logs the unrecorded total and the capped batch separately.
        const listed = [{ id: "a" }, { id: "b" }, { id: "c" }];
        const all = selectCatchupIds(listed, [], []);
        expect(all).toHaveLength(3);
        expect(selectCatchupIds(listed, [], [], 1)).toHaveLength(1);
    });

    it("accepts any iterable of recorded ids", () => {
        const listed = [{ id: "a" }, { id: "b" }];
        expect(selectCatchupIds(listed, [], new Set(["b"]))).toEqual(["a"]);
    });
});
