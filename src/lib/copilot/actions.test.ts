import { describe, expect, it } from "vitest";
import { validateWriteIntent } from "./actions";

describe("validateWriteIntent", () => {
    it("returns allowed when explicit verb and one binding", async () => {
        const result = await validateWriteIntent({
            text: "create draft PO for ULINE",
            candidateTargets: ["uline-vendor-id"],
        });

        expect(result.status).toBe("allowed");
    });

    it("returns needs_confirmation when write target is ambiguous", async () => {
        const result = await validateWriteIntent({
            text: "add these items to PO",
            candidateTargets: ["po1", "po2"],
        });

        expect(result.status).toBe("needs_confirmation");
    });

    it("returns no_write when message has no explicit verb", async () => {
        const result = await validateWriteIntent({
            text: "what is the stock for KM106",
            candidateTargets: ["km106"],
        });

        expect(result.status).toBe("no_write");
    });

    it("returns needs_confirmation when explicit verb but no binding", async () => {
        const result = await validateWriteIntent({
            text: "approve this",
            candidateTargets: [],
        });

        expect(result.status).toBe("needs_confirmation");
    });

    it("returns allowed for single-target approve", async () => {
        const result = await validateWriteIntent({
            text: "approve this reconciliation",
            candidateTargets: ["approval-abc"],
        });

        expect(result.status).toBe("allowed");
    });
});
