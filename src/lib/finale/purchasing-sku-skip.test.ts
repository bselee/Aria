/**
 * @file    purchasing-sku-skip.test.ts
 * @purpose Label artwork SKUs must not be sent to Finale.
 */
import { describe, expect, it } from "vitest";
import { isMissingLabelArtworkSku } from "./purchasing-sku-skip";

describe("isMissingLabelArtworkSku", () => {
    it("skips label artwork ids that 404", () => {
        expect(isMissingLabelArtworkSku("OAG207LABELBACK")).toBe(true);
        expect(isMissingLabelArtworkSku("OAG104LABELFRONT")).toBe(true);
        expect(isMissingLabelArtworkSku("OAG109LABELFR")).toBe(true);
    });

    it("does not skip real reorder SKUs", () => {
        expect(isMissingLabelArtworkSku("OAG201BAG")).toBe(false);
        expect(isMissingLabelArtworkSku("MAM101")).toBe(false);
        expect(isMissingLabelArtworkSku("")).toBe(false);
        expect(isMissingLabelArtworkSku(null)).toBe(false);
    });
});
