import { describe, expect, it, beforeEach } from "vitest";
import { defineFlow, flowsForEvent, getFlow, listFlows, _resetRegistry } from "./registry";
import type { FlowDef } from "./types";

function trivialFlow(name: string, on: string[]): FlowDef {
    return {
        name,
        on,
        init: (event) => ({ inputs: event.payload }),
        firstStep: "noop",
        steps: {
            noop: {
                run: async () => ({ kind: "succeeded" }),
            },
        },
    };
}

describe("flow registry", () => {
    beforeEach(() => _resetRegistry());

    it("registers and retrieves a flow by name", () => {
        defineFlow(trivialFlow("a", ["evt.a"]));
        expect(getFlow("a")?.name).toBe("a");
        expect(listFlows()).toHaveLength(1);
    });

    it("indexes flows by event type", () => {
        defineFlow(trivialFlow("a", ["evt.x", "evt.y"]));
        defineFlow(trivialFlow("b", ["evt.x"]));
        expect(flowsForEvent("evt.x").map((d) => d.name)).toEqual(["a", "b"]);
        expect(flowsForEvent("evt.y").map((d) => d.name)).toEqual(["a"]);
        expect(flowsForEvent("evt.z")).toEqual([]);
    });

    it("rejects duplicate names", () => {
        defineFlow(trivialFlow("dup", ["e"]));
        expect(() => defineFlow(trivialFlow("dup", ["e2"]))).toThrow(/already registered/);
    });

    it("rejects a firstStep not in steps", () => {
        expect(() => defineFlow({
            name: "bad",
            on: ["e"],
            init: () => ({ inputs: {} }),
            firstStep: "missing",
            steps: { other: { run: async () => ({ kind: "succeeded" }) } },
        })).toThrow(/firstStep "missing" not in steps/);
    });

    it("rejects empty name", () => {
        expect(() => defineFlow(trivialFlow("", ["e"]))).toThrow(/name required/);
    });
});
