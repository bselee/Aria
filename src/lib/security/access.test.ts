import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    getAllowedTelegramIds,
    isTelegramSenderAllowed,
    verifyGithubSignature,
    isSafeCliArg,
    sanitizeCliArg,
} from "./access";
import crypto from "crypto";

describe("getAllowedTelegramIds", () => {
    const orig = { ...process.env };
    afterEach(() => {
        process.env = { ...orig };
    });

    it("reads the owner id and the extra allow-list", () => {
        process.env.TELEGRAM_CHAT_ID = "111";
        process.env.TELEGRAM_ALLOWED_CHAT_IDS = "222, 333";
        const ids = getAllowedTelegramIds();
        expect([...ids].sort()).toEqual([111, 222, 333]);
    });

    it("ignores blanks and zero", () => {
        process.env.TELEGRAM_CHAT_ID = "0";
        process.env.TELEGRAM_ALLOWED_CHAT_IDS = " , 444 , ";
        expect([...getAllowedTelegramIds()]).toEqual([444]);
    });
});

describe("isTelegramSenderAllowed", () => {
    const orig = { ...process.env };
    beforeEach(() => {
        delete process.env.TELEGRAM_CHAT_ID;
        delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    });
    afterEach(() => {
        process.env = { ...orig };
    });

    it("fails closed when no allow-list is configured", () => {
        expect(isTelegramSenderAllowed(999, 999)).toBe(false);
    });

    it("admits the configured owner by sender id", () => {
        process.env.TELEGRAM_CHAT_ID = "111";
        expect(isTelegramSenderAllowed(111, undefined)).toBe(true);
    });

    it("admits by chat id too", () => {
        process.env.TELEGRAM_CHAT_ID = "111";
        expect(isTelegramSenderAllowed(undefined, 111)).toBe(true);
    });

    it("rejects an unknown sender", () => {
        process.env.TELEGRAM_CHAT_ID = "111";
        expect(isTelegramSenderAllowed(222, 222)).toBe(false);
    });
});

describe("verifyGithubSignature", () => {
    const secret = "s3cret";
    const body = JSON.stringify({ action: "opened" });
    const sign = (b: string, sec: string) =>
        "sha256=" + crypto.createHmac("sha256", sec).update(b, "utf8").digest("hex");

    it("accepts a correctly signed payload", () => {
        expect(verifyGithubSignature(body, sign(body, secret), secret)).toBe(true);
    });

    it("rejects when the secret is unset (fail closed)", () => {
        expect(verifyGithubSignature(body, sign(body, secret), undefined)).toBe(false);
    });

    it("rejects a tampered body", () => {
        expect(verifyGithubSignature(body + "x", sign(body, secret), secret)).toBe(false);
    });

    it("rejects a signature made with the wrong secret", () => {
        expect(verifyGithubSignature(body, sign(body, "other"), secret)).toBe(false);
    });

    it("rejects missing or malformed headers", () => {
        expect(verifyGithubSignature(body, null, secret)).toBe(false);
        expect(verifyGithubSignature(body, "garbage", secret)).toBe(false);
    });
});

describe("isSafeCliArg / sanitizeCliArg", () => {
    it("accepts plausible PO ids, paths, and counts", () => {
        for (const v of ["124357", "PO-1234", "/sandbox/fedex.csv", "C:\\tmp\\x.csv", "50"]) {
            expect(isSafeCliArg(v)).toBe(true);
            expect(sanitizeCliArg(v)).toBe(v);
        }
    });

    it("rejects shell metacharacters", () => {
        for (const v of [
            "1234; rm -rf /",
            "$(cat .env.local)",
            "a | b",
            "`whoami`",
            "x && y",
            "a > /etc/passwd",
            "a\nb",
            "a b",
        ]) {
            expect(isSafeCliArg(v)).toBe(false);
            expect(sanitizeCliArg(v)).toBeNull();
        }
    });

    it("rejects empty, oversized, and non-string input", () => {
        expect(isSafeCliArg("")).toBe(false);
        expect(isSafeCliArg("a".repeat(257))).toBe(false);
        expect(isSafeCliArg(undefined)).toBe(false);
        expect(isSafeCliArg(null)).toBe(false);
    });
});
