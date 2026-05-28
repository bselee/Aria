// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { POStepper, type StepperPO } from "./POStepper";

function makePO(overrides: Partial<StepperPO> = {}): StepperPO {
    return {
        orderId: "124790",
        vendorName: "Colorful Packaging Ltd",
        status: "Committed",
        orderDate: "2026-05-06",
        expectedDate: "2026-05-20",
        receiveDate: null,
        total: 250,
        isReceived: false,
        completionState: "in_transit",
        sentVerification: {
            verified: false,
            sentAt: null,
            source: null,
            evidence: [],
        },
        ...overrides,
    };
}

describe("POStepper", () => {
    it("does not mark the PO sent step complete from orderDate alone", () => {
        render(<POStepper po={makePO()} />);

        const sentLabels = screen.getAllByText("Sent");

        expect(sentLabels.length).toBeGreaterThan(0);
        expect(sentLabels.every((label) => label.className.includes("text-cyan"))).toBe(true);
        expect(sentLabels.every((label) => !label.className.includes("text-emerald"))).toBe(true);
    });
});
