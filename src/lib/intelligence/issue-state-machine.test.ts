import { describe, expect, it } from "vitest";
import { canTransitionIssue } from "./issue-state-machine";

describe("canTransitionIssue — projection guardrails", () => {
    it("prevents projection from clearing blocked", () => {
        const r = canTransitionIssue({
            from: "blocked",
            to: "working",
            intent: "projection",
            actor: "issue-projection",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("clear_blocker");
    });

    it("prevents projection from setting blocked (must use set_blocker intent)", () => {
        const r = canTransitionIssue({
            from: "working",
            to: "blocked",
            intent: "projection",
            actor: "issue-projection",
        });
        expect(r.ok).toBe(false);
    });

    it("allows projection to advance non-blocked → non-blocked freely", () => {
        expect(canTransitionIssue({
            from: "detected",
            to: "working",
            intent: "projection",
            actor: "issue-projection",
        }).ok).toBe(true);
    });
});

describe("canTransitionIssue — clear_blocker", () => {
    it("allows clear_blocker to resume blocked issue", () => {
        expect(canTransitionIssue({
            from: "blocked",
            to: "working",
            intent: "clear_blocker",
            actor: "will-telegram",
        }).ok).toBe(true);
    });

    it("allows clear_blocker to resume into triaging", () => {
        expect(canTransitionIssue({
            from: "blocked",
            to: "triaging",
            intent: "clear_blocker",
            actor: "ap-reconciler",
        }).ok).toBe(true);
    });
});

describe("canTransitionIssue — set_blocker", () => {
    it("set_blocker is always legal from open states", () => {
        for (const from of ["detected", "triaging", "working", "waiting_external"] as const) {
            expect(canTransitionIssue({
                from,
                to: "blocked",
                intent: "set_blocker",
                actor: "ap-reconciler",
            }).ok).toBe(true);
        }
    });

    it("requires set_blocker intent to enter blocked (rejects bare orchestrator transitions)", () => {
        const r = canTransitionIssue({
            from: "working",
            to: "blocked",
            intent: "orchestrator",
            actor: "issue-orchestrator",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("set_blocker");
    });
});

describe("canTransitionIssue — complete from blocked", () => {
    it("blocked → complete requires clear_blocker first (no force)", () => {
        const r = canTransitionIssue({
            from: "blocked",
            to: "complete",
            intent: "complete",
            actor: "ap-reconciler",
        });
        expect(r.ok).toBe(false);
    });

    it("blocked → complete is allowed with force=true from a human actor (will-*)", () => {
        expect(canTransitionIssue({
            from: "blocked",
            to: "complete",
            intent: "complete",
            actor: "will-telegram",
            force: true,
        }).ok).toBe(true);
    });

    it("blocked → complete with force=true but non-human actor still rejected", () => {
        const r = canTransitionIssue({
            from: "blocked",
            to: "complete",
            intent: "complete",
            actor: "issue-orchestrator",
            force: true,
        });
        expect(r.ok).toBe(false);
    });
});

describe("canTransitionIssue — complete from non-blocked", () => {
    it("complete from working / waiting_external / triaging is legal", () => {
        for (const from of ["working", "waiting_external", "triaging", "detected"] as const) {
            expect(canTransitionIssue({
                from,
                to: "complete",
                intent: "complete",
                actor: "ap-reconciler",
            }).ok).toBe(true);
        }
    });
});

describe("canTransitionIssue — completed-issue immutability", () => {
    it("complete cannot be reopened without force", () => {
        const r = canTransitionIssue({
            from: "complete",
            to: "working",
            intent: "manual_control",
            actor: "will-telegram",
        });
        expect(r.ok).toBe(false);
    });

    it("complete CAN be reopened with force from a human (rare but allowed)", () => {
        expect(canTransitionIssue({
            from: "complete",
            to: "working",
            intent: "manual_control",
            actor: "will-telegram",
            force: true,
        }).ok).toBe(true);
    });
});

describe("canTransitionIssue — no-op transitions", () => {
    it("from === to is always ok (idempotent writes)", () => {
        expect(canTransitionIssue({
            from: "working",
            to: "working",
            intent: "orchestrator",
            actor: "issue-orchestrator",
        }).ok).toBe(true);
    });
});
