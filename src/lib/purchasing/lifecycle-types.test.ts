import { describe, expect, it } from "vitest";
import { getLifecycleLabel } from "./lifecycle-types";

describe("lifecycle labels", () => {
    it("uses AP review wording instead of AP follow-up wording", () => {
        expect(getLifecycleLabel("ap_follow_up")).toBe("AP Review Needed");
    });
});
