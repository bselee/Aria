/**
 * @file    po-ref-validator.test.ts
 * @purpose Unit tests for the PO-ref validator (layer c): shape acceptance,
 *          existence backstop, and fail-open nulling of non-PO refs so a
 *          freight "ADV ORDER 4798" can never become a phantom PO.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, maybeSingleMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    maybeSingleMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
    createClient: createClientMock,
}));

import { isPoShaped, validatePoRef, resolveDropshipPOByBase, resolveExtractedPOs } from "./po-ref-validator";

describe("isPoShaped", () => {
    it("accepts standard 6-digit Finale POs starting with 1", () => {
        expect(isPoShaped("125257")).toBe(true);
        expect(isPoShaped("100347")).toBe(true);
        expect(isPoShaped("113179")).toBe(true);
        expect(isPoShaped("125213")).toBe(true);
    });

    it("accepts dropship 8-digit POs starting with 2, with or without suffix", () => {
        expect(isPoShaped("23320587")).toBe(true);
        expect(isPoShaped("21410811")).toBe(true);
        expect(isPoShaped("23320587-DropshipPO")).toBe(true);
        expect(isPoShaped("23268687A-DropshipPO")).toBe(true); // attached letter
        expect(isPoShaped("23333907F1-DropshipPO")).toBe(true); // attached letter+digit
        expect(isPoShaped("23322307-S-DropshipPO")).toBe(true); // dashed segment
        expect(isPoShaped("23322657-SF1-DropshipPO")).toBe(true); // dashed multi-char
        expect(isPoShaped("23356217-SA-DropshipPO")).toBe(true); // dashed multi-char
    });

    it("is case-insensitive on the dropship suffix and letter", () => {
        expect(isPoShaped("23320587-dropshippo")).toBe(true);
        expect(isPoShaped("23268687a-DropshipPO")).toBe(true);
    });

    it("rejects the 9-digit rating-estimate family (shape is anchored)", () => {
        for (const ref of [
            "278411572-1",
            "276170239-1",
            "268244264-1",
            "269178799-1",
            "270404873-1",
            "275691812-1",
            "123456789-1",
        ]) {
            expect(isPoShaped(ref)).toBe(false);
        }
    });

    it("rejects non-PO numbers: 4-digit order refs, box numbers, B.L./PRO digits", () => {
        expect(isPoShaped("4798")).toBe(false);
        expect(isPoShaped("935003")).toBe(false);
        expect(isPoShaped("18700362")).toBe(false);
        expect(isPoShaped("64058931")).toBe(false);
        expect(isPoShaped("71473626-1")).toBe(false); // 8-digit PRO, not a PO
        expect(isPoShaped("")).toBe(false);
        expect(isPoShaped(null)).toBe(false);
        expect(isPoShaped(undefined)).toBe(false);
    });

    it("rejects 5-digit and 7-digit legacy shapes (rely on existence, not shape)", () => {
        expect(isPoShaped("13862")).toBe(false); // 5-digit legacy
        expect(isPoShaped("0400773")).toBe(false); // 7-digit zero-padded
    });

    it("normalizes PO/ORDER/# prefixes before checking shape", () => {
        expect(isPoShaped("PO-125257")).toBe(true);
        expect(isPoShaped("ORDER 125257")).toBe(true);
        expect(isPoShaped("#125257")).toBe(true);
    });
});

describe("validatePoRef", () => {
    beforeEach(() => {
        createClientMock.mockReset();
        maybeSingleMock.mockReset();
        createClientMock.mockReturnValue({
            from: () => ({ select: () => ({ ilike: () => ({ limit: () => ({ maybeSingle: maybeSingleMock }) }) }) }),
        });
    });

    it("accepts shaped refs without touching the DB", async () => {
        const r = await validatePoRef("125257");
        expect(r).toBe("125257");
        expect(maybeSingleMock).not.toHaveBeenCalled();
    });

    it("accepts non-shaped refs that already exist in purchase_orders", async () => {
        maybeSingleMock.mockResolvedValue({ data: { po_number: "0400773" }, error: null });
        const r = await validatePoRef("0400773");
        expect(r).toBe("0400773");
        expect(maybeSingleMock).toHaveBeenCalled();
    });

    it("returns the DB spelling for a legacy dropship PO whose case was mangled", async () => {
        maybeSingleMock.mockResolvedValue({ data: { po_number: "4520-DropshipPO" }, error: null });
        const r = await validatePoRef("4520-DROPSHIPPO", "gmail=xyz");
        expect(r).toBe("4520-DropshipPO");
    });

    it("nulls non-shaped refs missing from purchase_orders", async () => {
        maybeSingleMock.mockResolvedValue({ data: null, error: null });
        const r = await validatePoRef("4798", "gmail=1a16c4a2f0550ba0");
        expect(r).toBeNull();
    });

    it("nulls when the existence check errors (fails open, not closed)", async () => {
        maybeSingleMock.mockResolvedValue({ data: null, error: { message: "db down" } });
        const r = await validatePoRef("4798");
        expect(r).toBeNull();
    });

    it("returns null for empty/null input without a DB call", async () => {
        expect(await validatePoRef(null)).toBeNull();
        expect(await validatePoRef("")).toBeNull();
        expect(maybeSingleMock).not.toHaveBeenCalled();
    });
});

describe("resolveDropshipPOByBase", () => {
    beforeEach(() => {
        createClientMock.mockReset();
        maybeSingleMock.mockReset();
        createClientMock.mockReturnValue({
            from: () => ({ select: () => ({ ilike: () => ({ limit: () => ({ maybeSingle: maybeSingleMock }) }) }) }),
        });
    });

    it("resolves a bare 8-digit base to the DB spelling (prefix match)", async () => {
        maybeSingleMock.mockResolvedValue({ data: { po_number: "23578097A-DropshipPO" }, error: null });
        expect(await resolveDropshipPOByBase("23578097A")).toBe("23578097A-DropshipPO");
    });

    it("rejects a non-2-prefixed 8-digit candidate without a DB round-trip", async () => {
        expect(await resolveDropshipPOByBase("64058931")).toBeNull();
        expect(maybeSingleMock).not.toHaveBeenCalled();
    });

    it("returns null when no base row matches (cancelled sales order)", async () => {
        maybeSingleMock.mockResolvedValue({ data: null, error: null });
        expect(await resolveDropshipPOByBase("23566017")).toBeNull();
    });

    it("returns null when the existence lookup errors (fail closed)", async () => {
        maybeSingleMock.mockResolvedValue({ data: null, error: { message: "db down" } });
        expect(await resolveDropshipPOByBase("23578097")).toBeNull();
    });
});

describe("resolveExtractedPOs", () => {
    beforeEach(() => {
        createClientMock.mockReset();
        maybeSingleMock.mockReset();
        createClientMock.mockReturnValue({
            from: () => ({ select: () => ({ ilike: () => ({ limit: () => ({ maybeSingle: maybeSingleMock }) }) }) }),
        });
    });

    it("keeps standard 5-7 digit refs untouched (no DB call)", async () => {
        const r = await resolveExtractedPOs(["125333", "124833"]);
        expect(r).toEqual(["125333", "124833"]);
        expect(maybeSingleMock).not.toHaveBeenCalled();
    });

    it("resolves an 8-digit dropship candidate to its DB spelling", async () => {
        maybeSingleMock.mockResolvedValue({ data: { po_number: "23581487-S-DropshipPO" }, error: null });
        expect(await resolveExtractedPOs(["23581487"])).toEqual(["23581487-S-DropshipPO"]);
    });

    it("resolves the letter form 23578097A to the DB spelling", async () => {
        maybeSingleMock.mockResolvedValue({ data: { po_number: "23578097A-DropshipPO" }, error: null });
        expect(await resolveExtractedPOs(["23578097A"])).toEqual(["23578097A-DropshipPO"]);
    });

    it("drops an 8-digit candidate with no base row (23566017)", async () => {
        maybeSingleMock.mockResolvedValue({ data: null, error: null });
        expect(await resolveExtractedPOs(["23566017"])).toEqual([]);
    });
});
