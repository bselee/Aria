import { describe, expect, it, vi } from "vitest";
import { buildPoCandidates, resolveFinalePo } from "./po-resolver";

describe("buildPoCandidates", () => {
    it("returns the raw token first", () => {
        expect(buildPoCandidates("124302")[0]).toBe("124302");
    });

    it("adds the parenthesized prefix variant for B-prefixed tokens", () => {
        const cs = buildPoCandidates("B123402");
        expect(cs).toContain("B123402");
        expect(cs).toContain("B(123402)");
        expect(cs).toContain("123402"); // digits-only
        expect(cs).toContain("(123402)"); // parens-only
    });

    it("generates adjacent-digit-swap variants for OCR transposition recovery", () => {
        const cs = buildPoCandidates("B123402");
        // 123402 → 213402, 132402, 124302, 123042, 123420
        expect(cs).toContain("213402");
        expect(cs).toContain("132402");
        expect(cs).toContain("124302"); // the famous Riceland flip
        expect(cs).toContain("123042");
        expect(cs).toContain("123420");
    });

    it("dedups within a single token's variant set", () => {
        const cs = buildPoCandidates("12345");
        const unique = new Set(cs);
        expect(cs.length).toBe(unique.size);
    });

    it("splits on whitespace when invoice prints multiple POs ('B7732 B123402')", () => {
        const cs = buildPoCandidates("B7732 B123402");
        expect(cs).toContain("B7732");
        expect(cs).toContain("B123402");
        expect(cs).toContain("7732");
        expect(cs).toContain("123402");
    });
});

describe("resolveFinalePo", () => {
    const makeClient = (validIds: string[], suppliersByOrderId: Record<string, string> = {}) => ({
        getOrderDetails: vi.fn(async (id: string) => {
            if (validIds.includes(id)) return { orderId: id };
            throw new Error(`PO ${id} not found`);
        }),
        getOrderSummary: vi.fn(async (id: string) => {
            if (validIds.includes(id)) return { orderId: id, total: 0, status: "open", supplier: suppliersByOrderId[id] ?? "Unknown" };
            return null;
        }),
    });

    it("returns the exact match when it exists", async () => {
        const client = makeClient(["124302"]);
        const r = await resolveFinalePo("124302", null, client as any);
        expect(r.orderId).toBe("124302");
        expect(r.note).toContain("Exact match");
    });

    it("recovers from a single adjacent-digit transposition", async () => {
        // OCR read 123402; actual Finale PO is 124302 (3↔4 swap)
        const client = makeClient(["124302"]);
        const r = await resolveFinalePo("123402", null, client as any);
        expect(r.orderId).toBe("124302");
        expect(r.note).toContain("Resolved");
    });

    it("recovers via parenthesized format for B-prefixed tokens", async () => {
        // Vendor printed "B123402"; Finale stores it as "B(123402)"
        const client = makeClient(["B(123402)"]);
        const r = await resolveFinalePo("B123402", null, client as any);
        expect(r.orderId).toBe("B(123402)");
    });

    it("disambiguates by vendor name when multiple candidates resolve", async () => {
        // Both 123402 and 124302 exist in Finale; vendor is "Riceland Foods"
        const client = makeClient(
            ["123402", "124302"],
            { "123402": "Pioneer Propane", "124302": "Riceland USA" },
        );
        const r = await resolveFinalePo("123402", "Riceland Foods", client as any);
        expect(r.orderId).toBe("124302"); // wins on shared "riceland" word
        expect(r.note).toContain("disambiguated by vendor");
    });

    it("returns null with diagnostic note when nothing matches", async () => {
        const client = makeClient([]);
        const r = await resolveFinalePo("99999", null, client as any);
        expect(r.orderId).toBeNull();
        expect(r.note).toContain("No Finale PO matched");
        expect(r.triedCandidates.length).toBeGreaterThan(0);
    });

    it("handles multi-token printed PO ('B7732 B123402')", async () => {
        // Vendor printed two refs; the second is the real Finale PO
        const client = makeClient(["B(123402)"]);
        const r = await resolveFinalePo("B7732 B123402", null, client as any);
        expect(r.orderId).toBe("B(123402)");
    });
});
