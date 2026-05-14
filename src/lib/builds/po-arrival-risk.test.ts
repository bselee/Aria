import { describe, expect, it } from "vitest";
import { classifyVendorCommState, detectAtRiskPOs } from "./po-arrival-risk";

function makePO(overrides: any = {}): any {
    return {
        orderId: "PO-001",
        vendorName: "Test Vendor",
        orderDate: "2026-05-01",
        expectedDate: "2026-05-30",
        leadProvenance: "14d (Finale)",
        isReceived: false,
        completionState: "in_transit",
        items: [{ productId: "SKU-A", quantity: 100 }],
        trackingNumbers: [],
        shipments: [],
        vendorAcknowledgedAt: null,
        humanReplyDetectedAt: null,
        etaProfile: {},
        ...overrides,
    };
}

function makeIntel(overrides: any = {}): any {
    return {
        productId: "SKU-A",
        productName: "Widget A",
        stockOnHand: 30,
        dailyRate: 1, // 30-day runway
        runwayDays: 30,
        ...overrides,
    };
}

describe("classifyVendorCommState", () => {
    const today = "2026-05-14";

    it("returns 'none' when silent — no ack, no eta, no tracking", () => {
        expect(classifyVendorCommState(makePO(), today)).toBe("none");
    });

    it("returns 'auto_acknowledged' when system ack but no human reply", () => {
        expect(classifyVendorCommState(
            makePO({ vendorAcknowledgedAt: "2026-05-05" }),
            today,
        )).toBe("auto_acknowledged");
    });

    it("returns 'recent_human_reply' when a human at the vendor replied in last 7d", () => {
        expect(classifyVendorCommState(
            makePO({
                vendorAcknowledgedAt: "2026-05-02",
                humanReplyDetectedAt: "2026-05-12", // 2 days ago
            }),
            today,
        )).toBe("recent_human_reply");
    });

    it("'auto_acknowledged' wins when human reply is older than 7d", () => {
        expect(classifyVendorCommState(
            makePO({
                vendorAcknowledgedAt: "2026-04-20",
                humanReplyDetectedAt: "2026-04-25", // ~19 days ago
            }),
            today,
        )).toBe("auto_acknowledged");
    });

    it("returns 'eta_stated_no_tracking' when ETA present but no tracking", () => {
        expect(classifyVendorCommState(
            makePO({ etaProfile: { vendorPromisedEta: "2026-05-25" } }),
            today,
        )).toBe("eta_stated_no_tracking");
    });

    it("returns 'tracking_no_movement' when tracking exists but no shipment movement", () => {
        expect(classifyVendorCommState(
            makePO({
                trackingNumbers: ["1Z999"],
                shipments: [{ status_category: "label_created" }],
            }),
            today,
        )).toBe("tracking_no_movement");
    });

    it("returns 'shipped_past_eta' when promised ETA is in the past and not received", () => {
        expect(classifyVendorCommState(
            makePO({
                etaProfile: { vendorPromisedEta: "2026-05-01" },
                trackingNumbers: ["1Z999"],
                shipments: [{ status_category: "in_transit" }],
                isReceived: false,
            }),
            today,
        )).toBe("shipped_past_eta");
    });

    it("does not return 'shipped_past_eta' when already received", () => {
        const state = classifyVendorCommState(
            makePO({
                etaProfile: { vendorPromisedEta: "2026-05-01" },
                isReceived: true,
            }),
            today,
        );
        // Past ETA + received = different bucket (we don't flag received POs anyway)
        expect(state).not.toBe("shipped_past_eta");
    });

    it("'shipped_past_eta' takes precedence over 'tracking_no_movement'", () => {
        expect(classifyVendorCommState(
            makePO({
                etaProfile: { vendorPromisedEta: "2026-05-01" },
                trackingNumbers: ["1Z999"],
                shipments: [{ status_category: "label_created" }],
            }),
            today,
        )).toBe("shipped_past_eta");
    });
});

describe("detectAtRiskPOs", () => {
    const today = "2026-05-14";

    it("flags a PO arriving after stockout", () => {
        // runway 10 days → stockout 2026-05-24; PO arrival 2026-05-30 → 6 days short
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ expectedDate: "2026-05-30", items: [{ productId: "SKU-A", quantity: 100 }] })],
            purchasingItems: [makeIntel({ stockOnHand: 10, runwayDays: 10 })],
        });
        expect(result).toHaveLength(1);
        expect(result[0].atRiskItems).toHaveLength(1);
        expect(result[0].atRiskItems[0].daysShort).toBe(6);
        expect(result[0].commState).toBe("none");
    });

    it("does NOT flag a PO arriving before stockout with wide buffer", () => {
        // runway 60 days → stockout 2026-07-13; PO arrival 2026-05-30 → -44d (plenty)
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ expectedDate: "2026-05-30" })],
            purchasingItems: [makeIntel({ stockOnHand: 60, runwayDays: 60 })],
        });
        expect(result).toEqual([]);
    });

    it("respects the minDaysShort threshold to cut noise", () => {
        // runway 27 days → stockout 2026-06-10; PO arrival 2026-06-12 → 2 days short
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ expectedDate: "2026-06-12" })],
            purchasingItems: [makeIntel({ stockOnHand: 27, runwayDays: 27 })],
            minDaysShort: 3,
        });
        expect(result).toEqual([]);
    });

    it("tags severity=at_risk for >=3 days short", () => {
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ expectedDate: "2026-05-30", items: [{ productId: "SKU-A", quantity: 1 }] })],
            purchasingItems: [makeIntel({ stockOnHand: 10, runwayDays: 10 })],
        });
        expect(result[0].severity).toBe("at_risk");
        expect(result[0].worstDaysShort).toBe(6);
    });

    it("tags severity=soon_at_risk when margin is thin but stockout hasn't crossed", () => {
        // runway 30 days → stockout 2026-06-13; PO arrival 2026-06-08 → -5 days short (5d buffer)
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ expectedDate: "2026-06-08", items: [{ productId: "SKU-A", quantity: 1 }] })],
            purchasingItems: [makeIntel({ stockOnHand: 30, runwayDays: 30 })],
        });
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe("soon_at_risk");
        expect(result[0].worstDaysShort).toBe(-5);
    });

    it("excludes POs with buffer wider than PROACTIVE_WINDOW (14d)", () => {
        // runway 60 days → stockout 2026-07-13; PO arrival 2026-06-08 → -35 days short (plenty of buffer)
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ expectedDate: "2026-06-08" })],
            purchasingItems: [makeIntel({ stockOnHand: 60, runwayDays: 60 })],
        });
        expect(result).toEqual([]);
    });

    it("skips received POs", () => {
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ isReceived: true })],
            purchasingItems: [makeIntel({ stockOnHand: 5, runwayDays: 5 })],
        });
        expect(result).toEqual([]);
    });

    it("skips POs whose vendor has already invoiced (vendor has shipped)", () => {
        // Vendor sent an invoice — they've shipped or are about to. Not at risk.
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ orderId: "PO-123", expectedDate: "2026-05-30" })],
            purchasingItems: [makeIntel({ stockOnHand: 10, runwayDays: 10 })], // 6d short
            poNumbersWithInvoice: new Set(["PO-123"]),
        });
        expect(result).toEqual([]);
    });

    it("skips POs whose completionState is past in_transit", () => {
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({ completionState: "delivered_awaiting_receipt" })],
            purchasingItems: [makeIntel({ stockOnHand: 5, runwayDays: 5 })],
        });
        expect(result).toEqual([]);
    });

    it("skips SKUs with no daily-rate signal", () => {
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO()],
            purchasingItems: [makeIntel({ dailyRate: 0, runwayDays: Infinity })],
        });
        expect(result).toEqual([]);
    });

    it("sorts worst-first by daysShort", () => {
        const result = detectAtRiskPOs({
            today,
            activePOs: [
                makePO({ orderId: "PO-A", expectedDate: "2026-05-30", items: [{ productId: "SKU-A", quantity: 1 }] }),
                makePO({ orderId: "PO-B", expectedDate: "2026-06-15", items: [{ productId: "SKU-B", quantity: 1 }] }),
            ],
            purchasingItems: [
                makeIntel({ productId: "SKU-A", stockOnHand: 10, runwayDays: 10 }), // 6 days short
                makeIntel({ productId: "SKU-B", stockOnHand: 10, runwayDays: 10 }), // 22 days short
            ],
        });
        expect(result.map((r) => r.poId)).toEqual(["PO-B", "PO-A"]);
    });

    it("captures multiple at-risk SKUs on the same PO", () => {
        const result = detectAtRiskPOs({
            today,
            activePOs: [makePO({
                items: [
                    { productId: "SKU-A", quantity: 1 },
                    { productId: "SKU-B", quantity: 1 },
                ],
            })],
            purchasingItems: [
                makeIntel({ productId: "SKU-A", stockOnHand: 10, runwayDays: 10 }),
                makeIntel({ productId: "SKU-B", stockOnHand: 5, runwayDays: 5 }),
            ],
        });
        expect(result).toHaveLength(1);
        expect(result[0].atRiskItems.map((i) => i.sku).sort()).toEqual(["SKU-A", "SKU-B"]);
    });
});
