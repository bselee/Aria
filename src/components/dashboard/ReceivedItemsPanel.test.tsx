// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import ReceivedItemsPanel from "./ReceivedItemsPanel";

const browserClientMock = {
  from: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [] }),
  })),
};

vi.mock("@/lib/supabase", () => ({
  createBrowserClient: () => browserClientMock,
}));

function stubLocalStorage(initialHeight = "280") {
  const store = new Map<string, string>([["aria-dash-recv-h", initialHeight]]);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    removeItem: vi.fn((key: string) => store.delete(key)),
  });
}

function stubFetch(payload: any) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(payload),
  }));
}

describe("ReceivedItemsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores persisted body height from localStorage", async () => {
    stubLocalStorage("320");
    stubFetch({
      received: [
        {
          orderId: "PO-101",
          orderDate: "2026-04-01",
          receiveDate: "2026-04-01",
          supplier: "Berger",
          total: 100,
          items: [{ productId: "SKU-1", quantity: 1 }],
          finaleUrl: "https://example.com/po",
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    const { container } = render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const scrollArea = container.querySelector('[style*="height: 320px"]');
    expect(scrollArea).toBeTruthy();
  });

  it("renders receipt status and receive time when provided", async () => {
    stubLocalStorage();
    stubFetch({
      received: [
        {
          orderId: "PO-100",
          orderDate: "2026-04-01",
          receiveDate: "2026-04-01T10:15:00-06:00",
          receiveDateTime: "2026-04-01T10:15:00-06:00",
          receiptStatus: "partial",
          supplier: "Berger",
          total: 13378,
          items: [{ productId: "BPM01", quantity: 26 }],
          finaleUrl: "https://example.com/po",
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getAllByText(/PARTIAL/i)[0]).toBeTruthy();
    expect(screen.getByText(/Today 10:15 AM|Today 10:15/i)).toBeTruthy();
    expect(screen.getByText(/short on BPM01/i)).toBeTruthy();
  });

  it("sorts receivings newest first and summarizes multiple short SKUs", async () => {
    stubLocalStorage();
    stubFetch({
      received: [
        {
          orderId: "PO-OLD",
          orderDate: "2026-04-01",
          receiveDate: "2026-04-01T08:00:00-06:00",
          receiveDateTime: "2026-04-01T08:00:00-06:00",
          receiptStatus: "full",
          supplier: "Older Vendor",
          total: 500,
          items: [{ productId: "OLD-1", quantity: 3 }],
          finaleUrl: "https://example.com/old",
        },
        {
          orderId: "PO-NEW",
          orderDate: "2026-04-01",
          receiveDate: "2026-04-01T11:30:00-06:00",
          receiveDateTime: "2026-04-01T11:30:00-06:00",
          receiptStatus: "partial",
          supplier: "Newest Vendor",
          total: 900,
          items: [
            { productId: "SKU-A", quantity: 2 },
            { productId: "SKU-B", quantity: 5 },
            { productId: "SKU-C", quantity: 1 },
          ],
          finaleUrl: "https://example.com/new",
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const supplierRows = screen.getAllByText(/Vendor/).map(node => node.textContent);
    expect(supplierRows[0]).toMatch(/Newest Vendor/);
    expect(screen.getByText(/short on SKU-A, SKU-B \+1 more/i)).toBeTruthy();
  });
});
