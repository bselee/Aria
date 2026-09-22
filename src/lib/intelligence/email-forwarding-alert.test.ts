import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mocks — created before module vi.mock() is evaluated
// ─────────────────────────────────────────────────────────────────────────────
const { createClientMock, dbState, localDbState, sendTelegramNotifyMock } = vi.hoisted(
    () => {
        const dbState = {
            data: null as any[] | null,
            error: null as any,
            returnNull: false,
        };

        const createClientMock = vi.fn(() => {
            if (dbState.returnNull) return null;

            // Real PostgREST chains are thenables — any method can be awaited and
            // resolves to { data, error }. Add .then() so `await chain.in(...)` works.
            const chainBase: any = {
                gte: vi.fn(() => chainBase),
                eq: vi.fn(() => chainBase),
                lt: vi.fn(() => chainBase),
                in: vi.fn(() => chainBase),
                order: vi.fn(() => chainBase),
                limit: vi.fn(() => chainBase),
                select: vi.fn(() => chainBase),
                insert: vi.fn(() =>
                    Promise.resolve({ data: null, error: null }) as any,
                ),
                // Make the chain awaitable (PostgREST thenable contract)
                then: vi.fn(
                    (resolve: any) =>
                        resolve({ data: dbState.data, error: dbState.error }),
                ),
            };
            return {
                from: vi.fn(() => chainBase),
            };
        });

        // Local SQLite mock — ap_local_forwards is the stuck-forward source of
        // truth since the Supabase ap_inbox_queue pipeline was retired.
        const localDbState = {
            rows: [] as any[],
            throws: false,
        };

        const sendTelegramNotifyMock = vi.fn();

        return {
            createClientMock,
            dbState,
            localDbState,
            sendTelegramNotifyMock,
        };
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("../db", () => ({
    createClient: createClientMock,
}));

vi.mock("@/lib/storage/local-db", () => ({
    getLocalDb: vi.fn(() => {
        if (localDbState.throws) throw new Error("sqlite unavailable");
        return {
            prepare: vi.fn(() => ({
                all: vi.fn(() => localDbState.rows),
                get: vi.fn(() => undefined),
                run: vi.fn(),
            })),
        };
    }),
}));

vi.mock("./notify", () => ({
    notify: sendTelegramNotifyMock,
}));

// ─────────────────────────────────────────────────────────────────────────────
// Subject under test
// ─────────────────────────────────────────────────────────────────────────────
import {
    formatForwardingAlerts,
    getStuckForwardingAlerts,
    runForwardingEscalation,
    type StuckForwardAlert,
} from "./email-forwarding-alert";

// Helpers ─────────────────────────────────────────────────────────────────────

const BASE_TIME = new Date("2026-06-05T12:00:00Z");

/** Create a local ap_local_forwards row shape as returned by prepare().all() */
function localRow(overrides: Partial<{
    id: number;
    email_from: string | null;
    email_subject: string | null;
    status: string;
    error_message: string | null;
    forwarded_at: string | null;
}> = {}) {
    return {
        id: 1,
        email_from: "vendor@example.com",
        email_subject: "Invoice #12345",
        status: "ERROR",
        error_message: null,
        forwarded_at: new Date(BASE_TIME.getTime() - 3 * 3600000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19),
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// formatForwardingAlerts
// ─────────────────────────────────────────────────────────────────────────────
describe("formatForwardingAlerts", () => {
    it("returns empty string for empty alerts array", () => {
        expect(formatForwardingAlerts([])).toBe("");
    });

    it("formats a single alert with header, vendor, subject, and age", () => {
        const alert: StuckForwardAlert = {
            messageId: "msg-001",
            from: "Acme Corp",
            subject: "Invoice INV-2026-001",
            status: "ERROR_FORWARDING",
            ageHours: 3,
            lastError: "ERROR_FORWARDING",
        };

        const result = formatForwardingAlerts([alert]);

        expect(result).toContain("🚨 *AP invoice stuck — never reached Bill.com*");
        expect(result).toContain("📩 *Acme Corp*");
        expect(result).toContain("Invoice INV-2026-001");
        expect(result).toContain("3h ago | ERROR_FORWARDING");
        expect(result).toContain(
            "💡 These will NOT appear in Bill.com. Forward manually or fix the pipeline.",
        );
    });

    it("formats multiple alerts with count header and up to 5 items", () => {
        const alerts: StuckForwardAlert[] = [
            {
                messageId: "msg-001",
                from: "Vendor A",
                subject: "Invoice A-001",
                status: "ERROR_FORWARDING",
                ageHours: 3,
                lastError: "ERROR_FORWARDING",
            },
            {
                messageId: "msg-002",
                from: "Vendor B",
                subject: "Invoice B-002",
                status: "ERROR_PROCESSING",
                ageHours: 5,
                lastError: "PO match failed",
            },
            {
                messageId: "msg-003",
                from: "Vendor C",
                subject: "Invoice C-003",
                status: "ERROR_FORWARDING",
                ageHours: 7,
                lastError: "ERROR_FORWARDING",
            },
        ];

        const result = formatForwardingAlerts(alerts);

        expect(result).toContain("🚨 *3 AP invoices stuck — never reached Bill.com*");
        expect(result).toContain("📩 *Vendor A* (3h)");
        expect(result).toContain("📩 *Vendor B* (5h)");
        expect(result).toContain("📩 *Vendor C* (7h)");
        expect(result).toContain(
            "💡 These will NOT appear in Bill.com. Forward manually or fix the pipeline.",
        );
        // Should NOT have the "and N more" line when ≤ 5
        expect(result).not.toContain("...and");
    });

    it("shows only first 5 items and appends '...and N more' when > 5", () => {
        const alerts: StuckForwardAlert[] = Array.from({ length: 8 }, (_, i) => ({
            messageId: `msg-${String(i + 1).padStart(3, "0")}`,
            from: `Vendor ${String.fromCharCode(65 + i)}`,
            subject: `Invoice #${1000 + i}`,
            status: "ERROR_FORWARDING",
            ageHours: 2 + i,
            lastError: "ERROR_FORWARDING",
        }));

        const result = formatForwardingAlerts(alerts);

        // Header shows total count
        expect(result).toContain("🚨 *8 AP invoices stuck — never reached Bill.com*");

        // First 5 are listed
        expect(result).toContain("📩 *Vendor A* (2h)");
        expect(result).toContain("📩 *Vendor B* (3h)");
        expect(result).toContain("📩 *Vendor C* (4h)");
        expect(result).toContain("📩 *Vendor D* (5h)");
        expect(result).toContain("📩 *Vendor E* (6h)");

        // Last 3 are not listed individually
        expect(result).not.toContain("📩 *Vendor F*");
        expect(result).not.toContain("📩 *Vendor G*");
        expect(result).not.toContain("📩 *Vendor H*");

        // "and N more" line present
        expect(result).toContain("...and 3 more — check /aphealth");
    });

    it("truncates long subjects to 60 characters in multi-item view", () => {
        const longSubject = "A".repeat(120);
        const alerts: StuckForwardAlert[] = [
            {
                messageId: "msg-001",
                from: "Verbose Vendor",
                subject: longSubject,
                status: "ERROR_FORWARDING",
                ageHours: 4,
                lastError: "ERROR_FORWARDING",
            },
            {
                messageId: "msg-002",
                from: "Another Vendor",
                subject: "Short subject",
                status: "ERROR_PROCESSING",
                ageHours: 2,
                lastError: "PO match failed",
            },
        ];

        const result = formatForwardingAlerts(alerts);

        // First item's subject should be truncated to 60 chars
        expect(result).toContain("A".repeat(60));
        expect(result).not.toContain("A".repeat(61));

        // Second item's short subject appears in full
        expect(result).toContain("Short subject");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getStuckForwardingAlerts (local SQLite ap_local_forwards)
// ─────────────────────────────────────────────────────────────────────────────
describe("getStuckForwardingAlerts", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        vi.clearAllMocks();
        localDbState.rows = [];
        localDbState.throws = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns [] when the local DB is unavailable", async () => {
        localDbState.throws = true;
        const result = await getStuckForwardingAlerts();
        expect(result).toEqual([]);
    });

    it("returns [] when there are no stuck rows", async () => {
        localDbState.rows = [];
        const result = await getStuckForwardingAlerts();
        expect(result).toEqual([]);
    });

    it("maps all fields correctly for a stuck row", async () => {
        const forwarded_at = new Date(BASE_TIME.getTime() - 10 * 3600000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19);
        localDbState.rows = [
            localRow({
                id: 42,
                email_from: "bill@acme.com",
                email_subject: "Invoice INV-2026-042",
                status: "ERROR",
                error_message: "Bill.com API rejected — invalid vendor ID",
                forwarded_at,
            }),
        ];

        const result = await getStuckForwardingAlerts();

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            messageId: "42",
            from: "bill@acme.com",
            subject: "Invoice INV-2026-042",
            status: "ERROR",
            ageHours: 10,
            lastError: "Bill.com API rejected — invalid vendor ID",
        });
    });

    it("falls back to status when error_message is absent", async () => {
        localDbState.rows = [localRow({ error_message: null, status: "CLAIMED" })];
        const result = await getStuckForwardingAlerts();
        expect(result[0].lastError).toBe("CLAIMED");
    });

    it("uses 'unknown sender' when email_from is null", async () => {
        localDbState.rows = [localRow({ email_from: null })];
        const result = await getStuckForwardingAlerts();
        expect(result[0].from).toBe("unknown sender");
    });

    it("handles multiple rows", async () => {
        localDbState.rows = [
            localRow({ id: 1 }),
            localRow({ id: 2, email_from: "b@b.com", email_subject: "Inv2" }),
            localRow({ id: 3, email_from: "c@c.com", email_subject: "Inv3" }),
        ];

        const result = await getStuckForwardingAlerts();

        expect(result).toHaveLength(3);
        expect(result.map((r) => r.messageId)).toEqual(["1", "2", "3"]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// runForwardingEscalation
// ─────────────────────────────────────────────────────────────────────────────
describe("runForwardingEscalation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        vi.clearAllMocks();
        localDbState.rows = [];
        localDbState.throws = false;
        dbState.data = null;
        dbState.error = null;
        dbState.returnNull = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not send Telegram when there are no stuck alerts", async () => {
        localDbState.rows = [];
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

        await runForwardingEscalation();

        expect(sendTelegramNotifyMock).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledWith(
            "[forwarding-alert] No stuck AP forwards.",
        );

        consoleLog.mockRestore();
    });

    it("sends formatted Telegram message when alerts exist", async () => {
        const forwarded_at = new Date(BASE_TIME.getTime() - 4 * 3600000)
            .toISOString()
            .replace("T", " ")
            .slice(0, 19);
        localDbState.rows = [
            localRow({
                id: 1,
                email_from: "acme@acme.com",
                email_subject: "Invoice INV-042",
                status: "ERROR",
                error_message: "Forward API 503",
                forwarded_at,
            }),
        ];
        dbState.data = []; // no recent escalations → proceed to send

        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

        await runForwardingEscalation();

        expect(sendTelegramNotifyMock).toHaveBeenCalledOnce();

        const sentText = sendTelegramNotifyMock.mock.calls[0][0] as string;
        expect(sentText).toContain("🚨 *AP invoice stuck — never reached Bill.com*");
        expect(sentText).toContain("📩 *acme@acme.com*");
        expect(sentText).toContain("Invoice INV-042");
        expect(sentText).toContain("4h ago | ERROR");

        consoleLog.mockRestore();
    });

    it("sends one Telegram message for multiple alerts", async () => {
        localDbState.rows = [
            localRow({ id: 1, email_from: "a@a.com", email_subject: "Inv1" }),
            localRow({ id: 2, email_from: "b@b.com", email_subject: "Inv2" }),
        ];
        dbState.data = [];

        await runForwardingEscalation();

        expect(sendTelegramNotifyMock).toHaveBeenCalledOnce();
        const sentText = sendTelegramNotifyMock.mock.calls[0][0] as string;
        expect(sentText).toContain("🚨 *2 AP invoices stuck — never reached Bill.com*");
    });

    it("still formats correctly when no client and skips silently", async () => {
        localDbState.rows = [];
        dbState.returnNull = true;
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

        await runForwardingEscalation();

        expect(sendTelegramNotifyMock).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledWith(
            "[forwarding-alert] No stuck AP forwards.",
        );

        consoleLog.mockRestore();
    });
});
