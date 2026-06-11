/**
 * @file    access.ts
 * @purpose Centralized access-control primitives for Aria's external surfaces:
 *          the Telegram bot, the GitHub webhook, and CLI command execution.
 *
 * These run on the Node runtime (bot + API routes). The dashboard edge
 * middleware (src/middleware.ts) is intentionally self-contained because it
 * cannot import Node's `crypto`.
 */

import crypto from "crypto";

// ────────────────────────────────────────────────────────────────────────────
// Telegram sender allow-list
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse the set of Telegram chat/user IDs permitted to control the bot.
 * Sources `TELEGRAM_CHAT_ID` (the owner) plus an optional comma-separated
 * `TELEGRAM_ALLOWED_CHAT_IDS` for additional trusted operators.
 */
export function getAllowedTelegramIds(): Set<number> {
    const ids = new Set<number>();
    const push = (raw: string | undefined) => {
        if (!raw) return;
        for (const part of raw.split(",")) {
            const n = Number(part.trim());
            if (Number.isFinite(n) && n !== 0) ids.add(n);
        }
    };
    push(process.env.TELEGRAM_CHAT_ID);
    push(process.env.TELEGRAM_ALLOWED_CHAT_IDS);
    return ids;
}

/**
 * Returns true if the given sender/chat id is allowed to control the bot.
 *
 * Fail-closed: if no allow-list is configured the bot answers nobody and logs
 * a loud warning, because an unconfigured allow-list on a money-moving bot is
 * a misconfiguration, not a reason to open the doors.
 */
export function isTelegramSenderAllowed(
    senderId: number | undefined,
    chatId: number | undefined,
): boolean {
    const allowed = getAllowedTelegramIds();
    if (allowed.size === 0) {
        console.error(
            "[security] No TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_CHAT_IDS configured — " +
                "rejecting ALL Telegram input. Set TELEGRAM_CHAT_ID in .env.local.",
        );
        return false;
    }
    return (
        (senderId !== undefined && allowed.has(senderId)) ||
        (chatId !== undefined && allowed.has(chatId))
    );
}

// ────────────────────────────────────────────────────────────────────────────
// GitHub webhook signature verification
// ────────────────────────────────────────────────────────────────────────────

/**
 * Verify a GitHub webhook's `x-hub-signature-256` header against the raw
 * request body using HMAC-SHA256.
 *
 * Returns true only when the secret is configured AND the signature matches.
 * When `GITHUB_WEBHOOK_SECRET` is unset the verification fails closed — callers
 * decide how strict to be, but a configured production secret is required to
 * accept any webhook.
 */
export function verifyGithubSignature(
    rawBody: string,
    signatureHeader: string | null | undefined,
    secret: string | undefined,
): boolean {
    if (!secret) return false;
    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

    const expected = "sha256=" +
        crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ────────────────────────────────────────────────────────────────────────────
// CLI argument safety (command-injection guard)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Allow-list for values interpolated into spawned CLI commands (e.g. the
 * Telegram `/vendor` command's `--po`, `--csv`, `--limit` flags). Permits the
 * characters that legitimately appear in PO ids, file paths, and counts while
 * rejecting shell metacharacters (`; | & $ \` < > ( ) ' " newline`).
 */
const SAFE_CLI_ARG = /^[A-Za-z0-9_./:\\-]+$/;

export function isSafeCliArg(value: string | null | undefined): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256 &&
        SAFE_CLI_ARG.test(value);
}

/**
 * Returns the value if safe, otherwise null. Use at the call site to drop an
 * unsafe flag rather than passing it to a child process.
 */
export function sanitizeCliArg(value: string | null | undefined): string | null {
    return isSafeCliArg(value) ? value : null;
}
