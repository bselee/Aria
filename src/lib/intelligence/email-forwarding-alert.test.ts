import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Hoisted mocks — created before module vi.mock() is evaluated
// ─────────────────────────────────────────────────────────────────────────────
const { createClientMock, dbState, sendCriticalTelegramNotifyMock } = vi.hoisted(
    () => {
        const dbState = {
            data: null as any[] | null,
            error: null as any,
            returnNull: false,
        };

        const createClientMock = vi.fn(() => {
            if (dbState.returnNull) return null;

            // Real Supabase chains are thenables — any method can be awaited and
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
                // Make the chain awaitable (Supabase thenable contract)
                then: vi.fn(
                    (resolve: any) =>
                        resolve({ data: dbState.data, error: dbState.error }),
                ),
            };
            return {
                from: vi.fn(() => chainBase),
            };
        });

        const sendCriticalTelegramNotifyMock = vi.fn();

        return {
            createClientMock,
            dbState,
            sendCriticalTelegramNotifyMock,
        };
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("../db", () => ({
    createClient: createClientMock,
}));

vi.mock("./telegram-notify", () => ({
    sendCriticalTelegramNotify: sendCriticalTelegramNotifyMock,
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

/** Create a DB row shape as returned by ap_inbox_queue.select() */
function dbRow(overrides: Partial<{
    message_id: string;
    extracted_json: Record<string, any> | null;
    status: string;
    created_at: string;
    updated_at: string;
}> = {}) {
    return {
        message_id: "msg-001",
        extracted_json: {
            from: "vendor@example.com",
            vendor_name: "Example Vendor",
            subject: "Invoice #12345",
        },
        status: "ERROR_FORWARDING",
        created_at: new Date(BASE_TIME.getTime() - 3 * 3600000).toISOString(),
        updated_at: new Date(BASE_TIME.getTime() - 2.5 * 3600000).toISOString(),
        ...overrides,
    };
}

const BASE_TIME = new Date("2026-06-05T12:00:00Z");
const THREE_HOURS_AGO = new Date(BASE_TIME.getTime() - 3 * 3600000).toISOString();

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
// getStuckForwardingAlerts
// ─────────────────────────────────────────────────────────────────────────────
describe("getStuckForwardingAlerts", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(BASE_TIME);
        vi.clearAllMocks();
        dbState.data = null;
        dbState.error = null;
        dbState.returnNull = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns [] when createClient returns null (missing env vars)", async () => {
        dbState.returnNull = true;
        const result = await getStuckForwardingAlerts();
        expect(result).toEqual([]);
        expect(createClientMock).toHaveBeenCalledOnce();
    });

    it("returns [] when DB returns empty array", async () => {
        dbState.data = [];
        const result = await getStuckForwardingAlerts();
        expect(result).toEqual([]);
    });

    it("returns [] when DB response has an error", async () => {
        dbState.data = [];
        dbState.error = new Error("connection timeout");
        const result = await getStuckForwardingAlerts();
        expect(result).toEqual([]);
    });

    it("returns [] when DB returns null for data", async () => {
        dbState.data = null;
        const result = await getStuckForwardingAlerts();
        expect(result).toEqual([]);
    });

    it("filters out zombie records with null extracted_json", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-real", extracted_json: { from: "real@vendor.com", vendor_name: "Real Vendor", subject: "Invoice" } }),
            dbRow({ message_id: "msg-zombie", extracted_json: null }),
        ];
        const result = await getStuckForwardingAlerts();
        expect(result).toHaveLength(1);
        expect(result[0].messageId).toBe("msg-real");
    });

    it("filters out zombie records with empty object extracted_json", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-real", extracted_json: { from: "real@vendor.com", vendor_name: "Real Vendor", subject: "Invoice" } }),
            dbRow({ message_id: "msg-zombie", extracted_json: {} }),
        ];
        const result = await getStuckForwardingAlerts();
        expect(result).toHaveLength(1);
        expect(result[0].messageId).toBe("msg-real");
    });

    it("keeps records with extracted_json.from even without vendor_name or subject", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-no-vendor", extracted_json: { from: "vendor@example.com" } }),
        ];
        const result = await getStuckForwardingAlerts();
        expect(result).toHaveLength(1);
        expect(result[0].messageId).toBe("msg-no-vendor");
        expect(result[0].from).toBe("vendor@example.com");
    });

    it("keeps records with extracted_json.vendor_name even without from or subject", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-no-from", extracted_json: { vendor_name: "Vendor Inc" } }),
        ];
        const result = await getStuckForwardingAlerts();
        expect(result).toHaveLength(1);
        expect(result[0].messageId).toBe("msg-no-from");
        expect(result[0].from).toBe("Vendor Inc");
    });

    it("filters out records where extracted_json is a non-object (e.g. string)", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-real", extracted_json: { from: "real@vendor.com", vendor_name: "Real Vendor", subject: "Invoice" } }),
            dbRow({ message_id: "msg-string", extracted_json: "some string" as any }),
        ];
        const result = await getStuckForwardingAlerts();
        expect(result).toHaveLength(1);
        expect(result[0].messageId).toBe("msg-real");
    });

    it("maps all fields correctly for valid records", async () => {
        const created_at = new Date(BASE_TIME.getTime() - 10 * 3600000).toISOString();
        dbState.data = [
            dbRow({
                message_id: "msg-042",
                extracted_json: {
                    from: "bill@acme.com",
                    vendor_name: "Acme Corp",
                    subject: "Invoice INV-2026-042",
                    last_error: "Bill.com API rejected — invalid vendor ID",
                },
                status: "ERROR_FORWARDING",
                created_at,
            }),
        ];

        const result = await getStuckForwardingAlerts();

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            messageId: "msg-042",
            from: "bill@acme.com",
            subject: "Invoice INV-2026-042",
            status: "ERROR_FORWARDING",
            ageHours: 10,
            lastError: "Bill.com API rejected — invalid vendor ID",
        });
    });

    it("falls back to error_message then status when last_error is absent", async () => {
        dbState.data = [
            dbRow({
                extracted_json: {
                    from: "v@v.com",
                    vendor_name: "V",
                    subject: "Inv",
                    error_message: "SMTP connection refused",
                },
            }),
        ];

        const result = await getStuckForwardingAlerts();
        expect(result[0].lastError).toBe("SMTP connection refused");
    });

    it("falls back to status when neither last_error nor error_message exist", async () => {
        dbState.data = [
            dbRow({
                extracted_json: { from: "v@v.com", vendor_name: "V", subject: "Inv" },
            }),
        ];

        const result = await getStuckForwardingAlerts();
        expect(result[0].lastError).toBe("ERROR_FORWARDING");
    });

    it("uses 'unknown sender' when from and vendor_name are both missing", async () => {
        dbState.data = [
            dbRow({
                extracted_json: { subject: "Orphan Invoice" },
            }),
        ];

        const result = await getStuckForwardingAlerts();
        expect(result[0].from).toBe("unknown sender");
    });

    it("calls from() with the correct table name and query chain", async () => {
        dbState.data = [];
        await getStuckForwardingAlerts();

        const fromMock = createClientMock.mock.results[0].value.from;
        expect(fromMock).toHaveBeenCalledWith("ap_inbox_queue");
    });

    it("handles multiple records in a mix of real and zombie", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-1", extracted_json: { from: "a@a.com", vendor_name: "A", subject: "Inv1" } }),
            dbRow({ message_id: "msg-2", extracted_json: null }),
            dbRow({ message_id: "msg-3", extracted_json: {} }),
            dbRow({ message_id: "msg-4", extracted_json: { vendor_name: "B" } }),
            dbRow({ message_id: "msg-5", extracted_json: { from: "c@c.com" } }),
            dbRow({ message_id: "msg-6", extracted_json: { subject: "Inv6" } }),
        ];

        const result = await getStuckForwardingAlerts();

        // 4 real: msg-1, msg-4, msg-5, msg-6
        expect(result).toHaveLength(4);
        expect(result.map((r) => r.messageId).sort()).toEqual([
            "msg-1",
            "msg-4",
            "msg-5",
            "msg-6",
        ]);
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
        dbState.data = null;
        dbState.error = null;
        dbState.returnNull = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not send Telegram when there are no stuck alerts", async () => {
        dbState.data = [];
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

        await runForwardingEscalation();

        expect(sendCriticalTelegramNotifyMock).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledWith(
            "[forwarding-alert] No stuck AP forwards.",
        );

        consoleLog.mockRestore();
    });

    it("sends formatted Telegram message when alerts exist", async () => {
        const created_at = new Date(BASE_TIME.getTime() - 4 * 3600000).toISOString();
        dbState.data = [
            dbRow({
                message_id: "msg-001",
                extracted_json: {
                    from: "acme@acme.com",
                    vendor_name: "Acme Corp",
                    subject: "Invoice INV-042",
                    last_error: "Forward API 503",
                },
                status: "ERROR_FORWARDING",
                created_at,
            }),
        ];

        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

        await runForwardingEscalation();

        expect(sendCriticalTelegramNotifyMock).toHaveBeenCalledOnce();

        const sentText = sendCriticalTelegramNotifyMock.mock.calls[0][0] as string;
        expect(sentText).toContain("🚨 *AP invoice stuck — never reached Bill.com*");
        expect(sentText).toContain("📩 *acme@acme.com*");
        expect(sentText).toContain("Invoice INV-042");
        expect(sentText).toContain("4h ago | ERROR_FORWARDING");

        expect(consoleLog).toHaveBeenCalledWith(
            "[forwarding-alert] Alerted Bill: 1 AP invoice(s) stuck in ERROR_FORWARDING/ERROR_PROCESSING.",
        );

        consoleLog.mockRestore();
    });

    it("sends one Telegram message for multiple alerts", async () => {
        dbState.data = [
            dbRow({ message_id: "msg-1", extracted_json: { from: "a@a.com", vendor_name: "A", subject: "Inv1" } }),
            dbRow({ message_id: "msg-2", extracted_json: { from: "b@b.com", vendor_name: "B", subject: "Inv2" } }),
        ];

        await runForwardingEscalation();

        expect(sendCriticalTelegramNotifyMock).toHaveBeenCalledOnce();
        const sentText = sendCriticalTelegramNotifyMock.mock.calls[0][0] as string;
        expect(sentText).toContain("🚨 *2 AP invoices stuck — never reached Bill.com*");
    });

    it("still formats correctly when no client and skips silently", async () => {
        dbState.returnNull = true;
        const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

        await runForwardingEscalation();

        expect(sendCriticalTelegramNotifyMock).not.toHaveBeenCalled();
        expect(consoleLog).toHaveBeenCalledWith(
            "[forwarding-alert] No stuck AP forwards.",
        );

        consoleLog.mockRestore();
    });
});