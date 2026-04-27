import { describe, expect, it } from "vitest";
import { canonicalize, inputHash } from "./agent-task-hash";

describe("canonicalize", () => {
    it("sorts keys lexicographically", () => {
        expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    });

    it("recurses into nested objects", () => {
        expect(canonicalize({ z: { b: 2, a: 1 }, y: 0 })).toBe('{"y":0,"z":{"a":1,"b":2}}');
    });

    it("preserves array order", () => {
        expect(canonicalize({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
    });

    it("handles empty object", () => {
        expect(canonicalize({})).toBe("{}");
    });
});

describe("inputHash", () => {
    it("is deterministic across key orderings", () => {
        const h1 = inputHash({ a: 1, b: 2 });
        const h2 = inputHash({ b: 2, a: 1 });
        expect(h1).toBe(h2);
    });

    it("differs for different content", () => {
        expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
    });

    it("returns a 64-char hex string", () => {
        const h = inputHash({ x: 1 });
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
});
