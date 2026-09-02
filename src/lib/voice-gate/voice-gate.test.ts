/**
 * @file    voice-gate.test.ts
 * @purpose MECHANICAL VOICE GATE (#7, 2026-08-20 assessment).
 *
 *          Fails the suite if outbound-facing template strings contain emoji
 *          or AI-isms — Bill's voice rules, enforced in code instead of by
 *          review memory alone.
 *
 *          SCOPE: strings that reach Bill or vendors (Telegram sends, PO
 *          emails, briefings, task replies). Console.* lines are dev-facing
 *          diagnostics and are deliberately excluded. Comments are excluded.
 *
 *          ADDING A FILE: if you build outbound text in a new file, add it to
 *          OUTBOUND_FILES below. If the gate fires on a legit string, that is
 *          a voice violation — rewrite the string, do not silence the gate.
 *
 * @author  aria-reviewer
 * @created 2026-08-20
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

// Files that construct Bill/vendor-facing text.
const OUTBOUND_FILES = [
    "src/config/persona.ts",                                  // TELEGRAM_CONFIG + SYSTEM_PROMPT
    "src/lib/telegram/bot.ts",                                // ctx.reply responses
    "src/lib/intelligence/telegram-notify.ts",                // notify helper (templates)
    "src/lib/intelligence/services/comms-service.ts",         // daily/weekly summaries
    "src/lib/intelligence/sandbox-watcher.ts",                // sandbox Telegram alerts
    "src/lib/intelligence/supervisor-agent.ts",               // crash escalation Telegram
    "src/lib/purchasing/po-sender.ts",                        // PO email bodies
    "src/lib/purchasing/lead-time-tracker.ts",                // lead time Telegram report
    "src/lib/purchasing/autonomy-engine.ts",                  // draft PO Telegram prompts
    "src/lib/command-board/task-actions.ts",                  // approve/reject/dismiss replies
    "src/lib/reconciliation/notifier.ts",                     // reconciliation run summary
    "src/cron/jobs/index.ts",                                 // cron alert templates
];

// Bill voice rule: NO emojis. Covers the full pictograph/symbol ranges
// including ✅⚠️❌🚨📦🔔 etc. Excludes plain arrows (U+2190-21FF) which are
// legitimate text glyphs, not emojis.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

// Bill voice rule: NO AI-isms. Case-insensitive phrase match.
const AI_ISMS: RegExp[] = [
    /\bplease note\b/i,
    /\bi would recommend\b/i,
    /\bi hope this helps\b/i,
    /\bhope this helps\b/i,
    /\blet me know if you need anything\b/i,
    /\bfeel free to reach out\b/i,
    /\bcertainly\b/i,
    /\bas an ai\b/i,
    /\bhappy to help\b/i,
    /\bi'd be happy to\b/i,
];

function stripComment(line: string): string {
    // Remove // line comments (but not https:// etc. — those contain no emoji anyway)
    const idx = line.indexOf("//");
    return idx >= 0 ? line.slice(0, idx) : line;
}

function isDevLogLine(line: string): boolean {
    return /console\.(log|warn|error|info|debug)/.test(line);
}

function scanSource(file: string): Array<{ line: number; text: string; kind: string }> {
    const abs = resolve(process.cwd(), file);
    const raw = readFileSync(abs, "utf8");
    const hits: Array<{ line: number; text: string; kind: string }> = [];
    raw.split(/\r?\n/).forEach((line, idx) => {
        const code = stripComment(line.trim());
        if (!code) return;                    // blank or comment-only
        if (isDevLogLine(line)) return;       // dev-facing diagnostics
        if (EMOJI_RE.test(code)) {
            hits.push({ line: idx + 1, text: line.trim(), kind: "emoji" });
        }
        for (const re of AI_ISMS) {
            if (re.test(code)) {
                hits.push({ line: idx + 1, text: line.trim(), kind: `ai-ism (${re})` });
                break;
            }
        }
    });
    return hits;
}

describe("voice gate — Bill voice rules in outbound templates", () => {
    for (const file of OUTBOUND_FILES) {
        it(`no emoji or AI-isms in ${file}`, () => {
            const hits = scanSource(file);
            expect(hits).toEqual([]);
        });
    }
});

// Behavioral check on the exported template builders — the static scan cannot
// see string concatenation, so exercise the real functions with fixtures.
describe("voice gate — behavior of exported template builders", () => {
    it("PO email body and text-only body are clean", async () => {
        const { generatePOEmailBody, generateTextOnlyPOEmail } = await import("../purchasing/po-sender");
        const review = {
            orderId: "10001",
            vendorName: "Uline",
            vendorPartyId: "10083",
            orderDate: "2026-08-20",
            total: 1234.5,
            items: [
                { productId: "S-123", productName: "Box", quantity: 2, unitPrice: 617.25, lineTotal: 1234.5 },
            ],
            finaleUrl: "https://app.finaleinventory.com/buildasoilorganics/purchaseOrder?orderId=10001",
            canCommit: true,
        };
        const { subject, body } = generatePOEmailBody(review as any);
        const textOnly = generateTextOnlyPOEmail(review as any);
        for (const s of [subject, body, textOnly]) {
            expect(EMOJI_RE.test(s)).toBe(false);
            for (const re of AI_ISMS) expect(re.test(s)).toBe(false);
        }
    });

    it("Telegram welcome and document-received messages are clean", async () => {
        const { TELEGRAM_CONFIG } = await import("../../config/persona");
        const welcome = TELEGRAM_CONFIG.welcomeMessage("Bill");
        const doc = TELEGRAM_CONFIG.documentReceived("invoice.pdf");
        for (const s of [welcome, doc]) {
            expect(EMOJI_RE.test(s)).toBe(false);
            for (const re of AI_ISMS) expect(re.test(s)).toBe(false);
        }
    });
});
