/**
 * Tests for writeReconciliationOutcome helper.
 * Verifies the "never throws" contract and basic payload shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeReconciliationOutcome } from "./reconciliation-outcomes";

// ── Mock createClient ──────────────────────────────────────────────────────────

vi.mock("@/lib/supabase", () => ({
    createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase";
const mockCreateClient = vi.mocked(createClient);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInsertMock(error: { message: string } | null = null) {
    return {
        from: vi.fn().mockReturnValue({
            insert: vi.fn().mockResolvedValue({ error }),
        }),
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("writeReconciliationOutcome", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("does NOT throw when supabase is null (env vars missing)", async () => {
        mockCreateClient.mockReturnValue(null);
        await expect(
            writeReconciliationOutcome({
                runId: crypto.randomUUID(),
                outcome: "auto_applied",
                invoiceId: "INV-001",
                poId: "PO-001",
            })
        ).resolves.toBeUndefined();
    });

    it("does NOT throw when supabase.from().insert() rejects", async () => {
        mockCreateClient.mockReturnValue({
            from: vi.fn().mockReturnValue({
                insert: vi.fn().mockRejectedValue(new Error("network error")),
            }),
        } as any);

        await expect(
            writeReconciliationOutcome({
                runId: crypto.randomUUID(),
                outcome: "match_failed",
                vendorName: "Test Vendor",
            })
        ).resolves.toBeUndefined();
    });

    it("does NOT throw when supabase.from().insert() returns an error object", async () => {
        mockCreateClient.mockReturnValue(makeInsertMock({ message: "relation does not exist" }) as any);

        await expect(
            writeReconciliationOutcome({
                runId: crypto.randomUUID(),
                outcome: "rejected_10x",
                poId: "PO-123",
            })
        ).resolves.toBeUndefined();
    });

    it("calls insert with the expected payload shape on success", async () => {
        const mockClient = makeInsertMock(null) as any;
        mockCreateClient.mockReturnValue(mockClient);

        const runId = crypto.randomUUID();
        const resolvedAt = new Date("2026-05-04T12:00:00Z");

        await writeReconciliationOutcome({
            runId,
            outcome: "auto_applied",
            invoiceId: "INV-42",
            poId: "PO-9999",
            vendorName: "Test Vendor Inc",
            outcomeMeta: { total_impact: 123.45, price_delta_pct: 2.1 },
            durationMs: 450,
            resolvedAt,
        });

        expect(mockClient.from).toHaveBeenCalledWith("reconciliation_outcomes");
        const insertCall = mockClient.from.mock.results[0].value.insert;
        expect(insertCall).toHaveBeenCalledWith({
            run_id: runId,
            invoice_id: "INV-42",
            po_id: "PO-9999",
            vendor_name: "Test Vendor Inc",
            outcome: "auto_applied",
            outcome_meta: { total_impact: 123.45, price_delta_pct: 2.1 },
            duration_ms: 450,
            resolved_at: "2026-05-04T12:00:00.000Z",
        });
    });

    it("sends null for optional fields when not provided", async () => {
        const mockClient = makeInsertMock(null) as any;
        mockCreateClient.mockReturnValue(mockClient);

        await writeReconciliationOutcome({
            runId: "run-uuid-001",
            outcome: "pending_approval",
        });

        const insertCall = mockClient.from.mock.results[0].value.insert;
        expect(insertCall).toHaveBeenCalledWith(
            expect.objectContaining({
                invoice_id: null,
                po_id: null,
                vendor_name: null,
                outcome_meta: null,
                duration_ms: null,
                resolved_at: null,
            })
        );
    });
});

describe("resolvePendingReconciliationOutcomeBySource", () => {
    it("updates only the pending outcome linked to the source activity log id", async () => {
        const isMock = vi.fn().mockResolvedValue({ error: null });
        const updateMock = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
                contains: vi.fn().mockReturnValue({
                    is: isMock,
                }),
            }),
        });
        const mockClient = {
            from: vi.fn().mockReturnValue({ update: updateMock }),
        };
        mockCreateClient.mockReturnValue(mockClient as any);

        const { resolvePendingReconciliationOutcomeBySource } = await import("./reconciliation-outcomes");
        const resolvedAt = new Date("2026-05-04T12:00:00Z");

        await resolvePendingReconciliationOutcomeBySource({
            sourceActivityLogId: "activity-123",
            resolution: "approved_by_user",
            resolvedAt,
        });

        expect(mockClient.from).toHaveBeenCalledWith("reconciliation_outcomes");
        expect(updateMock).toHaveBeenCalledWith({
            resolved_at: "2026-05-04T12:00:00.000Z",
        });
    });
});
