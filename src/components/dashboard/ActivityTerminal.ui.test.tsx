// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apRows = [
    {
        id: "act-1",
        created_at: "2026-05-14T14:00:00Z",
        email_from: "Vendor Support <vendor@example.com>",
        email_subject: "Payment question",
        intent: "EYES_NEEDED",
        action_taken: "Left email visible from Vendor Support <vendor@example.com> - human reply needed",
        metadata: { reasonCode: "human_interaction_manual_review" },
        reviewed_at: null,
        reviewed_action: null,
        human_note: null,
        process_state: null,
        resolution: null,
        learning_candidate: false,
    },
    {
        id: "act-2",
        created_at: "2026-05-14T13:00:00Z",
        email_from: "ULINE <orders@uline.com>",
        email_subject: "Invoice 25428",
        intent: "INVOICE",
        action_taken: "Forwarded to Bill.com",
        metadata: {},
        reviewed_at: null,
        reviewed_action: null,
        human_note: null,
        process_state: null,
        resolution: null,
        learning_candidate: false,
    },
    {
        id: "act-3",
        created_at: "2026-05-14T12:00:00Z",
        email_from: "ULINE <orders@uline.com>",
        email_subject: "Invoice 25428",
        intent: "RECONCILIATION",
        action_taken: "Dashboard review required - awaiting approval",
        metadata: {
            invoiceNumber: "25428",
            orderId: "124800",
            vendorName: "ULINE",
            confidence: "medium",
            totalDollarImpact: 12.44,
            priceChanges: [{ productId: "ULS-1", verdict: "auto_approve" }],
            feeChanges: [{ type: "freight", verdict: "needs_approval", to: 12.44 }],
        },
        reviewed_at: null,
        reviewed_action: null,
        human_note: "Freight moved.",
        process_state: null,
        resolution: null,
        learning_candidate: true,
    },
];

const cronRows: any[] = [];

function makeQuery(rows: any[]) {
    return {
        select: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
    };
}

const supabase = {
    from: vi.fn((table: string) => makeQuery(table === "ap_activity_log" ? apRows : cronRows)),
};

vi.mock("@/lib/supabase", () => ({
    createBrowserClient: () => supabase,
}));

import ActivityTerminal from "./ActivityTerminal";

describe("ActivityTerminal UI workflow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                activity: {
                    id: "act-1",
                    human_note: "Reply after checking statement.",
                    process_state: "opened",
                    resolution: "waiting_on_vendor",
                    learning_candidate: true,
                },
            }),
        }) as any;
    });

    it("pins attention rows above the terminal feed", async () => {
        render(<ActivityTerminal />);

        expect(await screen.findByText("Needs Eyes")).toBeTruthy();
        expect(screen.getByText("Payment question")).toBeTruthy();
        expect(screen.getAllByText("next: review/reply to email from vendor@example.com").length).toBeGreaterThan(0);
    });

    it("saves notes, process state, and teach toggle from an expanded row", async () => {
        render(<ActivityTerminal />);

        fireEvent.click(await screen.findByText(/Left email visible/));
        fireEvent.change(await screen.findByLabelText("Activity note"), {
            target: { value: "Reply after checking statement." },
        });
        fireEvent.click(screen.getByRole("button", { name: "Save note" }));
        fireEvent.click(screen.getByRole("button", { name: "Opened" }));
        fireEvent.click(screen.getByRole("button", { name: "Teach from this" }));

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith(
                "/api/dashboard/activity/act-1/workflow",
                expect.objectContaining({
                    method: "PATCH",
                }),
            );
        });

        expect(global.fetch).toHaveBeenCalledWith(
            "/api/dashboard/activity/act-1/workflow",
            expect.objectContaining({
                body: JSON.stringify({ note: "Reply after checking statement." }),
            }),
        );
        expect(global.fetch).toHaveBeenCalledWith(
            "/api/dashboard/activity/act-1/workflow",
            expect.objectContaining({
                body: JSON.stringify({ processState: "opened" }),
            }),
        );
        expect(global.fetch).toHaveBeenCalledWith(
            "/api/dashboard/activity/act-1/workflow",
            expect.objectContaining({
                body: JSON.stringify({ learningCandidate: true }),
            }),
        );
    });

    it("shows invoice to PO correlation and teach payload for reconciliation rows", async () => {
        render(<ActivityTerminal />);

        fireEvent.click(await screen.findByText("Dashboard review required - awaiting approval"));

        expect(await screen.findByText("Correlation")).toBeTruthy();
        expect(screen.getByText("Invoice 25428 -> PO 124800")).toBeTruthy();
        expect(screen.getByText(/\+ vendor matched ULINE/)).toBeTruthy();
        expect(screen.getByText(/\+ 1 line\/fee signal auto-approved/)).toBeTruthy();
        expect(screen.getByText("Teach payload")).toBeTruthy();
        expect(screen.getByText(/activity_human_correction/)).toBeTruthy();
    });
});
