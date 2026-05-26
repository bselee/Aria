// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AxiomSkuMappingPanel, { type AxiomOrderTemplate, type AxiomSkuMapping } from "./AxiomSkuMappingPanel";

afterEach(cleanup);

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

const sampleMappings: AxiomSkuMapping[] = [
    {
        axiom_job_name: "GNS11_12",
        finale_skus: ["GNS11", "GNS21"],
        qty_fraction: 0.5,
        description: "GnarBar-Whole 2lb F+B",
    },
];

const sampleTemplates: AxiomOrderTemplate[] = [
    {
        finale_sku: "APL102",
        axiom_job_name: "APL102",
        spec: {
            size: "8.5x11",
            material: "White matte",
            finish: "Standard",
        },
        approved: true,
        auto_order_allowed: true,
        approved_by: "Will",
        approved_at: "2026-05-26T15:00:00.000Z",
    },
    {
        finale_sku: "GNS11",
        axiom_job_name: "GNS11_12",
        spec: {},
        approved: false,
        auto_order_allowed: false,
    },
];

function mockAxiomResponses(options: {
    mappings?: AxiomSkuMapping[];
    templates?: AxiomOrderTemplate[];
}) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url.startsWith("/api/axiom-templates")) {
            if (init?.method === "POST") {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ template: JSON.parse(String(init.body)) }),
                });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ templates: options.templates ?? [] }),
            });
        }
        if (url.startsWith("/api/axiom-sku-mappings")) {
            return Promise.resolve({
                ok: true,
                json: async () => ({ mappings: options.mappings ?? [] }),
            });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
}

describe("AxiomSkuMappingPanel — order completion gate", () => {
    it("renders Finale-SKU-first template status and the intended order workflow", async () => {
        mockAxiomResponses({ mappings: sampleMappings, templates: sampleTemplates });

        render(<AxiomSkuMappingPanel />);

        await waitFor(() => {
            expect(screen.getByText("Axiom Order Completion Gate")).toBeTruthy();
            expect(screen.getByText("Finale SKU demand")).toBeTruthy();
        });

        expect(screen.getAllByText("APL102").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Ready to order").length).toBeGreaterThan(0);
        expect(screen.getAllByText("GNS11_12").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Needs spec approval").length).toBeGreaterThan(0);
        expect(screen.getByText("GNS21")).toBeTruthy();
        expect(screen.getAllByText("Reconciliation only").length).toBeGreaterThan(0);
    });

    it("searches by Finale SKU, not only by Axiom job name", async () => {
        mockAxiomResponses({ mappings: sampleMappings, templates: sampleTemplates });

        render(<AxiomSkuMappingPanel />);
        await waitFor(() => expect(screen.getAllByText("APL102").length).toBeGreaterThan(0));

        fireEvent.change(screen.getByPlaceholderText(/Search Finale SKU/i), {
            target: { value: "GNS21" },
        });

        expect(screen.getByText("GNS21")).toBeTruthy();
        expect(screen.queryAllByText("APL102")).toHaveLength(0);
    });

    it("saves approved order templates through the template endpoint", async () => {
        mockAxiomResponses({ mappings: [], templates: [] });

        render(<AxiomSkuMappingPanel />);
        await waitFor(() => screen.getByText(/No Axiom order templates/i));

        fireEvent.click(screen.getByRole("button", { name: /Add Template/i }));
        fireEvent.change(screen.getByLabelText(/Finale SKU/i), { target: { value: "FM104" } });
        fireEvent.change(screen.getByLabelText(/Axiom Job \/ Template/i), { target: { value: "FM104" } });
        fireEvent.change(screen.getByLabelText(/Spec JSON/i), {
            target: { value: '{"size":"4x6","material":"BOPP"}' },
        });
        fireEvent.click(screen.getByLabelText(/Approved/i));
        fireEvent.click(screen.getByLabelText(/Auto-order allowed/i));
        fireEvent.click(screen.getByRole("button", { name: /Save Template/i }));

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/axiom-templates",
                expect.objectContaining({
                    method: "POST",
                    body: expect.stringContaining('"finale_sku":"FM104"'),
                }),
            );
        });
    });
});
