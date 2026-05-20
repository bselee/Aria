// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AxiomSkuMappingPanel, { type AxiomSkuMapping } from "./AxiomSkuMappingPanel";

afterEach(cleanup);

const fetchMock = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

const sampleMappings: AxiomSkuMapping[] = [
    {
        axiom_job_name: "APL102",
        finale_skus: ["APL102"],
        qty_fraction: 1.0,
        description: "3.0 Soil Cubic Foot Label",
    },
    {
        axiom_job_name: "GNS11_12",
        finale_skus: ["GNS11", "GNS21"],
        qty_fraction: 0.5,
        description: "GnarBar-Whole 2lb F+B",
    },
];

function mockMappingsResponse(mappings: AxiomSkuMapping[]) {
    fetchMock.mockImplementation((url: string) => {
        if (url.startsWith("/api/axiom-sku-mappings")) {
            return Promise.resolve({
                ok: true,
                json: async () => ({ mappings }),
            });
        }
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
}

describe("AxiomSkuMappingPanel — general rendering", () => {
    it("should render mapping records fetched from the Next.js API route successfully", async () => {
        mockMappingsResponse(sampleMappings);
        render(<AxiomSkuMappingPanel />);

        await waitFor(() => {
            expect(screen.getByText("3.0 Soil Cubic Foot Label")).toBeTruthy();
            expect(screen.getByText("GNS11_12")).toBeTruthy();
        });

        expect(screen.getAllByText("APL102").length).toBe(2);
        expect(screen.getByText("GnarBar-Whole 2lb F+B")).toBeTruthy();
        expect(screen.getByText("GNS11")).toBeTruthy();
        expect(screen.getByText("GNS21")).toBeTruthy();
    });

    it("should filter the mapping items matching search query inputs correctly", async () => {
        mockMappingsResponse(sampleMappings);
        render(<AxiomSkuMappingPanel />);

        await waitFor(() => screen.getByText("3.0 Soil Cubic Foot Label"));

        const searchInput = screen.getByPlaceholderText(/Search mappings by Job Name, SKUs, or Notes.../i);
        fireEvent.change(searchInput, { target: { value: "GnarBar" } });

        // GNS11_12 matches "GnarBar" in description; APL102 does not match.
        expect(screen.getByText("GNS11_12")).toBeTruthy();
        expect(screen.queryByText("3.0 Soil Cubic Foot Label")).toBeNull();
    });

    it("should open the creation form card when Clicking the Add Mapping button", async () => {
        mockMappingsResponse([]);
        render(<AxiomSkuMappingPanel />);

        await waitFor(() => {
            expect(screen.getByText(/No mappings found/i)).toBeTruthy();
        });

        const addBtn = screen.getByRole("button", { name: /Add Mapping/i });
        fireEvent.click(addBtn);

        expect(screen.getByText("Register New SKU Correlation")).toBeTruthy();
        expect(screen.getByLabelText(/Axiom Job Name/i)).toBeTruthy();
        expect(screen.getByLabelText(/Target Finale SKU\(s\)/i)).toBeTruthy();
    });

    it("should open the form populated with values when Edit is clicked on a row", async () => {
        mockMappingsResponse(sampleMappings);
        render(<AxiomSkuMappingPanel />);

        await waitFor(() => screen.getByText("3.0 Soil Cubic Foot Label"));

        const editBtns = screen.getAllByTitle("Edit Mapping");
        expect(editBtns.length).toBe(2);

        fireEvent.click(editBtns[0]); // Edit APL102 row

        expect(screen.getByText("Modify Mapping Definition")).toBeTruthy();
        const nameInput = screen.getByLabelText(/Axiom Job Name/i) as HTMLInputElement;
        expect(nameInput.value).toBe("APL102");
        expect(nameInput.disabled).toBe(true); // Should be disabled during edit
    });

    it("should prompt with confirmation buttons when Delete is clicked on a row", async () => {
        mockMappingsResponse(sampleMappings);
        render(<AxiomSkuMappingPanel />);

        await waitFor(() => screen.getByText("3.0 Soil Cubic Foot Label"));

        const deleteBtns = screen.getAllByTitle("Delete Mapping");
        expect(deleteBtns.length).toBe(2);

        fireEvent.click(deleteBtns[0]); // Click delete APL102

        expect(screen.getByText("Confirm delete?")).toBeTruthy();
        expect(screen.getByRole("button", { name: /^Delete$/i })).toBeTruthy();
        expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
    });
});
