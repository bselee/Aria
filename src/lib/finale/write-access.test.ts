import { describe, expect, it } from "vitest";
import { assertFinaleWriteAllowed, isFinaleWriteAllowed } from "./write-access";

describe("finale write access", () => {
    it("allows dashboard draft creation", () => {
        const context = { source: "dashboard", action: "create_draft_po" } as const;

        expect(isFinaleWriteAllowed(context)).toBe(true);
        expect(() => assertFinaleWriteAllowed(context)).not.toThrow();
    });

    it("allows dashboard commit", () => {
        const context = { source: "dashboard", action: "commit_draft_po" } as const;

        expect(isFinaleWriteAllowed(context)).toBe(true);
        expect(() => assertFinaleWriteAllowed(context)).not.toThrow();
    });

    it("denies slack watchdog draft creation", () => {
        const context = { source: "slack_watchdog", action: "create_draft_po" } as const;

        expect(isFinaleWriteAllowed(context)).toBe(false);
        expect(() => assertFinaleWriteAllowed(context)).toThrowError(
            /Finale write denied: source "slack_watchdog" cannot create_draft_po/
        );
    });

    it("denies cli commit", () => {
        const context = { source: "cli", action: "commit_draft_po" } as const;

        expect(isFinaleWriteAllowed(context)).toBe(false);
        expect(() => assertFinaleWriteAllowed(context)).toThrowError(
            /Finale write denied: source "cli" cannot commit_draft_po/
        );
    });
});
