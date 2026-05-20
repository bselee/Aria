// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PurchasingLifecycleProvider, usePurchasingLifecycle } from "./PurchasingLifecycleContext";

function Probe() {
    const lifecycle = usePurchasingLifecycle();
    const matched = lifecycle.matchesFocus({
        vendorName: "Axiom Print",
        orderId: "PO-1",
        productIds: ["JPS102"],
    });

    return (
        <>
            <button
                type="button"
                onClick={() => lifecycle.setFocus({
                    source: "ordering",
                    vendorName: "Axiom Print",
                    productIds: ["JPS102"],
                })}
            >
                focus sku
            </button>
            <span data-testid="match">{String(matched)}</span>
        </>
    );
}

describe("PurchasingLifecycleContext", () => {
    it("matches related lifecycle rows by shared vendor and SKU", async () => {
        render(
            <PurchasingLifecycleProvider>
                <Probe />
            </PurchasingLifecycleProvider>,
        );

        expect(screen.getByTestId("match").textContent).toBe("false");
        fireEvent.click(screen.getByRole("button", { name: "focus sku" }));
        await waitFor(() => {
            expect(screen.getByTestId("match").textContent).toBe("true");
        });
    });
});
