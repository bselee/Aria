import { describe, expect, it } from "vitest";

import {
    getWorkbenchForIssue,
    getWorkbenchForSource,
    getWorkbenchHref,
    listWorkbenches,
} from "./workbenches";

describe("command-board workbench registry", () => {
    it("maps AP approval sources to the AP workbench", () => {
        expect(getWorkbenchForSource("ap_pending_approvals", "ap-1").id).toBe("ap");
        expect(getWorkbenchForSource("invoices", "inv-1").id).toBe("ap");
    });

    it("maps PO and ordering sources to the Ordering workbench", () => {
        expect(getWorkbenchForSource("purchase_orders", "po-1").id).toBe("ordering");
        expect(getWorkbenchForSource("purchase_requests", "req-1").id).toBe("ordering");
        expect(getWorkbenchForSource("purchasing_recommendations", "rec-1").id).toBe("ordering");
    });

    it("maps receiving sources to the Receivings workbench", () => {
        expect(getWorkbenchForSource("received_items", "recv-1").id).toBe("receivings");
        expect(getWorkbenchForSource("receiving_variances", "var-1").id).toBe("receivings");
    });

    it("maps tracking sources to the Tracking workbench", () => {
        expect(getWorkbenchForSource("tracking_events", "track-1").id).toBe("tracking");
        expect(getWorkbenchForSource("shipments", "ship-1").id).toBe("tracking");
    });

    it("maps build sources to the Builds workbench", () => {
        expect(getWorkbenchForSource("build_risk", "risk-1").id).toBe("builds");
        expect(getWorkbenchForSource("build_schedule", "build-1").id).toBe("builds");
    });

    it("falls back to Issues for unknown or missing sources", () => {
        expect(getWorkbenchForSource("unknown_table", "x").id).toBe("issues");
        expect(getWorkbenchForSource(null, null).id).toBe("issues");
    });

    it("derives workbench from an issue source table", () => {
        const issue = {
            id: "issue-1",
            source_table: "ap_pending_approvals",
            source_id: "ap-1",
        };
        expect(getWorkbenchForIssue(issue).id).toBe("ap");
    });

    it("builds stable dashboard hrefs with source context", () => {
        expect(getWorkbenchHref("ordering", { sourceTable: "purchase_orders", sourceId: "po-1" }))
            .toBe("/dashboard?workbench=ordering&sourceTable=purchase_orders&sourceId=po-1");
    });

    it("lists daily workbenches in command-center order", () => {
        expect(listWorkbenches().map(w => w.id)).toEqual([
            "issues",
            "ordering",
            "receivings",
            "ap",
            "tracking",
            "active-pos",
            "builds",
            "statement-recon",
            "agents",
            "runs",
        ]);
    });
});
