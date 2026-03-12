/**
 * @file    oos-email-trigger.test.ts
 * @purpose Unit tests for OOS report email builder — focus on Internal Builds
 *          section and PO link rendering for blocking components.
 * @author  Aria (Antigravity)
 * @created 2026-03-12
 * @updated 2026-03-12
 * @deps    vitest
 */

import { describe, it, expect } from "vitest";
import { buildEmailBody, relativeETA } from "./oos-email-trigger";
import type { BuildBlockingInfo } from "./oos-email-trigger";
import type { OOSReportResult, EnrichedOOSItem } from "./oos-report";

// ──────────────────────────────────────────────────
// TEST HELPERS
// ──────────────────────────────────────────────────

/** Creates a minimal OOSReportResult for testing sections in isolation. */
function makeResult(overrides: Partial<OOSReportResult> = {}): OOSReportResult {
    return {
        outputPath: "/tmp/test-report.xlsx",
        totalItems: 1,
        needsOrder: [],
        onOrder: [],
        agingPOs: [],
        internalBuild: [],
        notInFinale: [],
        received: [],
        needsReview: [],
        ...overrides,
    };
}

/** Creates a minimal EnrichedOOSItem for internal-build testing. */
function makeBuildItem(sku: string, productName: string): EnrichedOOSItem {
    return {
        sku,
        productName,
        variant: "",
        shopifyVendor: "BuildASoil",
        shopifyCommitted: 0,
        shopifyAvailable: -5,
        shopifyOnHand: 0,
        shopifyIncoming: 0,
        shopifyProductUrl: "",
        finaleStatus: "Active",
        finaleSupplier: "Internal",
        isManufactured: true,
        hasBOM: true,
        leadTimeDays: null,
        openPOs: [],
        actionRequired: "🔧 Internal build needed — schedule manufacturing",
        finaleProductUrl: "",
    };
}

/** Build a Finale PO URL from an orderId (mirrors production logic). */
function finalePoUrl(orderId: string): string {
    const encoded = Buffer.from(`/buildasoilorganics/api/order/${orderId}`).toString("base64");
    return `https://app.finaleinventory.com/buildasoilorganics/sc2/?order/purchase/order/${encoded}`;
}

// ──────────────────────────────────────────────────
// relativeETA
// ──────────────────────────────────────────────────

describe("relativeETA", () => {
    it("should return TBD for null date", () => {
        const result = relativeETA(null);
        expect(result.text).toBe("TBD");
    });

    it("should return Today for today's date", () => {
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
        const result = relativeETA(today);
        expect(result.text).toBe("Today");
        expect(result.color).toBe("#166534");
    });
});

// ──────────────────────────────────────────────────
// buildEmailBody — Internal Builds / PO links
// ──────────────────────────────────────────────────

describe("buildEmailBody — Internal Builds section", () => {
    it("should render 'No BOM in Finale' when blocking info has no BOM", () => {
        const item = makeBuildItem("COWOCO1", "Colorado Worm Company Premium");
        const result = makeResult({ totalItems: 1, internalBuild: ["COWOCO1"] });
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("COWOCO1", {
            sku: "COWOCO1",
            hasBOM: false,
            components: [],
            blockingReason: "No BOM configured — needs setup in Finale",
        });

        const html = buildEmailBody(result, [item], [], blockingMap, "Wednesday, March 12, 2026");

        expect(html).toContain("COWOCO1");
        expect(html).toContain("No BOM in Finale");
    });

    it("should render blocking component SKU with plain 'on order' when no PO data is available", () => {
        const item = makeBuildItem("CRP103", "Nursery Solo Cups");
        const result = makeResult({ totalItems: 1, internalBuild: ["CRP103"] });
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("CRP103", {
            sku: "CRP103",
            hasBOM: true,
            components: [
                {
                    componentSku: "CRP101",
                    onHand: 0,
                    onOrder: 2520,
                    isBlocking: true,
                    incomingPOs: [], // No PO details available
                },
            ],
            blockingReason: "Awaiting: CRP101",
        });

        const html = buildEmailBody(result, [item], [], blockingMap, "Wednesday, March 12, 2026");

        // Should contain the component SKU
        expect(html).toContain("CRP101");
        // Should contain "on order" as plain text (no link)
        expect(html).toContain("2520 on order");
        // Should NOT contain a hyperlink for "on order"
        expect(html).not.toMatch(/href="[^"]*">2520 on order<\/a>/);
    });

    it("should render blocking component with a clickable PO link when PO data is available", () => {
        const item = makeBuildItem("CRP103", "Nursery Solo Cups");
        const result = makeResult({ totalItems: 1, internalBuild: ["CRP103"] });
        const poUrl = finalePoUrl("PO-4001");
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("CRP103", {
            sku: "CRP103",
            hasBOM: true,
            components: [
                {
                    componentSku: "CRP101",
                    onHand: 0,
                    onOrder: 2520,
                    isBlocking: true,
                    incomingPOs: [
                        { orderId: "PO-4001", quantity: 2520, finaleUrl: poUrl },
                    ],
                },
            ],
            blockingReason: "Awaiting: CRP101",
        });

        const html = buildEmailBody(result, [item], [], blockingMap, "Wednesday, March 12, 2026");

        // Should contain a hyperlink wrapping "PO#PO-4001 2520 on order"
        expect(html).toContain(`<a href="${poUrl}"`);
        expect(html).toContain("PO#PO-4001 2520 on order</a>");
        // Should contain the component SKU
        expect(html).toContain("CRP101");
        // Should say "Blocked"
        expect(html).toContain("Blocked");
    });

    it("should render PO link when build is scheduled AND component is blocking with PO", () => {
        const item = makeBuildItem("CRP103", "Nursery Solo Cups");
        const result = makeResult({ totalItems: 1, internalBuild: ["CRP103"] });
        const poUrl = finalePoUrl("PO-5050");
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("CRP103", {
            sku: "CRP103",
            hasBOM: true,
            components: [
                {
                    componentSku: "CRP101",
                    onHand: -10,
                    onOrder: 5000,
                    isBlocking: true,
                    incomingPOs: [
                        { orderId: "PO-5050", quantity: 5000, finaleUrl: poUrl },
                    ],
                },
            ],
            blockingReason: "Awaiting: CRP101",
        });

        // Simulate a scheduled build
        const scheduledBuilds = [
            {
                sku: "CRP103",
                buildDate: "2026-03-20",
                quantity: 500,
                designation: "MFG" as const,
                originalEvent: "Build CRP103 x500",
                confidence: 95,
                eventId: null,
                calendarId: null,
            },
        ];

        const html = buildEmailBody(result, [item], scheduledBuilds, blockingMap, "Wednesday, March 12, 2026");

        // Should contain the PO link in the scheduled-build path (Awaiting, not Blocked)
        expect(html).toContain(`<a href="${poUrl}"`);
        expect(html).toContain("PO#PO-5050 5000 on order</a>");
        // Should say "Awaiting" (scheduled build path), not "Blocked"
        expect(html).toContain("Awaiting");
    });

    it("should render 'Components ready' when all components are in stock with scheduled build", () => {
        const item = makeBuildItem("CRP103", "Nursery Solo Cups");
        const result = makeResult({ totalItems: 1, internalBuild: ["CRP103"] });
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("CRP103", {
            sku: "CRP103",
            hasBOM: true,
            components: [
                {
                    componentSku: "CRP101",
                    onHand: 5000,
                    onOrder: 0,
                    isBlocking: false,
                    incomingPOs: [],
                },
            ],
            blockingReason: "Components in stock — ready to build",
        });

        const scheduledBuilds = [
            {
                sku: "CRP103",
                buildDate: "2026-03-20",
                quantity: 500,
                designation: "MFG" as const,
                originalEvent: "Build CRP103 x500",
                confidence: 95,
                eventId: null,
                calendarId: null,
            },
        ];

        const html = buildEmailBody(result, [item], scheduledBuilds, blockingMap, "Wednesday, March 12, 2026");

        expect(html).toContain("Components ready");
        // Should NOT contain any "on order" or "Blocked" text
        expect(html).not.toContain("on order");
        expect(html).not.toContain("Blocked");
    });

    it("should render 'Ready to schedule' when BOM exists, no blocking components, and no scheduled build", () => {
        const item = makeBuildItem("CRP103", "Nursery Solo Cups");
        const result = makeResult({ totalItems: 1, internalBuild: ["CRP103"] });
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("CRP103", {
            sku: "CRP103",
            hasBOM: true,
            components: [
                {
                    componentSku: "CRP101",
                    onHand: 5000,
                    onOrder: 0,
                    isBlocking: false,
                    incomingPOs: [],
                },
            ],
            blockingReason: "Components in stock — ready to build",
        });

        const html = buildEmailBody(result, [item], [], blockingMap, "Wednesday, March 12, 2026");

        expect(html).toContain("Ready to schedule");
    });

    it("should handle multiple blocking components, showing PO links for those with POs", () => {
        const item = makeBuildItem("BLEND01", "Premium Soil Blend");
        const result = makeResult({ totalItems: 1, internalBuild: ["BLEND01"] });
        const poUrl1 = finalePoUrl("PO-6001");
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("BLEND01", {
            sku: "BLEND01",
            hasBOM: true,
            components: [
                {
                    componentSku: "COMP-A",
                    onHand: 0,
                    onOrder: 1000,
                    isBlocking: true,
                    incomingPOs: [
                        { orderId: "PO-6001", quantity: 1000, finaleUrl: poUrl1 },
                    ],
                },
                {
                    componentSku: "COMP-B",
                    onHand: -50,
                    onOrder: 0,
                    isBlocking: true,
                    incomingPOs: [], // No PO for this one
                },
                {
                    componentSku: "COMP-C",
                    onHand: 500,
                    onOrder: 0,
                    isBlocking: false,
                    incomingPOs: [],
                },
            ],
            blockingReason: "Awaiting: COMP-A, COMP-B",
        });

        const html = buildEmailBody(result, [item], [], blockingMap, "Wednesday, March 12, 2026");

        // COMP-A should have a PO link
        expect(html).toContain("COMP-A");
        expect(html).toContain(`<a href="${poUrl1}"`);
        expect(html).toContain("PO#PO-6001 1000 on order</a>");

        // COMP-B should be shown WITHOUT a PO link (no on order)
        expect(html).toContain("COMP-B");

        // Only 2 blockers shown (slice(0,2)), COMP-C is not blocking so not listed
        expect(html).not.toContain("COMP-C");
    });

    it("should show overflow count when more than 2 blocking components exist", () => {
        const item = makeBuildItem("MIX01", "Big Blend Mix");
        const result = makeResult({ totalItems: 1, internalBuild: ["MIX01"] });
        const blockingMap = new Map<string, BuildBlockingInfo>();
        blockingMap.set("MIX01", {
            sku: "MIX01",
            hasBOM: true,
            components: [
                { componentSku: "X1", onHand: 0, onOrder: 0, isBlocking: true, incomingPOs: [] },
                { componentSku: "X2", onHand: 0, onOrder: 0, isBlocking: true, incomingPOs: [] },
                { componentSku: "X3", onHand: 0, onOrder: 0, isBlocking: true, incomingPOs: [] },
            ],
            blockingReason: "Awaiting: X1, X2 +1 more",
        });

        const html = buildEmailBody(result, [item], [], blockingMap, "Wednesday, March 12, 2026");

        // Should show "+1" overflow
        expect(html).toContain("+1");
        // Should show first two blockers
        expect(html).toContain("X1");
        expect(html).toContain("X2");
        // X3 should NOT be in the rendered output (sliced out)
        expect(html).not.toContain("X3");
    });
});
