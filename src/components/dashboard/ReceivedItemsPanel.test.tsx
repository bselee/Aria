// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import ReceivedItemsPanel from "./ReceivedItemsPanel";

function stubLocalStorage(initialHeight = "280") {
  const store = new Map<string, string>([["aria-dash-recv-h", initialHeight]]);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    removeItem: vi.fn((key: string) => store.delete(key)),
  });
}

function stubFetch(payload: any, trackingPayload?: any) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/dashboard/tracking")
      ? (trackingPayload ?? {
          board: {
            arrivingToday: [],
            outForDelivery: [],
            deliveredAwaitingReceipt: [],
            exceptions: [],
            stale: [],
            recentlyDelivered: [],
          },
          shipments: [],
          asOf: "2026-04-01T12:00:00.000Z",
          todaySummary: null,
          answer: null,
        })
      : payload;

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
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
          receivedBy: "Luis",
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
    expect(screen.getByText(/Apr 1 10:15 AM/i)).toBeTruthy();
    expect(screen.getByText(/rcvd by Luis/i)).toBeTruthy();
    expect(screen.getByText(/short on BPM01/i)).toBeTruthy();
  });

  it("renders partial receipt history and open quantities", async () => {
    stubLocalStorage();
    stubFetch({
      received: [
        {
          orderId: "PO-300",
          orderDate: "2026-05-01",
          receiveDate: "2026-05-06",
          receiveDateTime: "2026-05-07T11:00:00-06:00",
          receiptStatus: "partial",
          supplier: "Bottle Vendor",
          total: 900,
          items: [
            { productId: "BOTTLE-1G", quantity: 300, orderedQuantity: 300, receivedQuantity: 225, openQuantity: 75 },
          ],
          receiptHistory: [
            {
              shipmentId: "rcv-1",
              receiveDate: "2026-05-06",
              receiveDateTime: "2026-05-06T09:00:00-06:00",
              receivedBy: "Luis",
              items: [{ productId: "BOTTLE-1G", quantity: 150 }],
            },
            {
              shipmentId: "rcv-2",
              receiveDate: "2026-05-07",
              receiveDateTime: "2026-05-07T11:00:00-06:00",
              receivedBy: "Mia",
              items: [{ productId: "BOTTLE-1G", quantity: 75 }],
            },
          ],
          finaleUrl: "https://example.com/po",
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/225 \/ 300 received/i)).toBeTruthy();
    expect(screen.getByText(/75 open/i)).toBeTruthy();
  });

  it("sorts receivings newest first and summarizes multiple short SKUs", async () => {
    stubLocalStorage();
    stubFetch({
      received: [
        {
          orderId: "PO-400",
          orderDate: "2026-06-01",
          receiveDate: "2026-06-02",
          supplier: "Multi Vendor",
          total: 500,
          items: [
            { productId: "SKU-A", quantity: 10, orderedQuantity: 10, receivedQuantity: 8, openQuantity: 2 },
            { productId: "SKU-B", quantity: 20, orderedQuantity: 20, receivedQuantity: 18, openQuantity: 2 },
          ],
          finaleUrl: "https://example.com/po",
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/2 short SKUs/i)).toBeTruthy();
  });

  it("shows a today shipment summary above receivings when tracking data is available", async () => {
    stubLocalStorage();
    stubFetch(
      {
        received: [],
        days: 14,
        asOf: "2026-04-01",
      },
      {
        board: {
          arrivingToday: [{ id: "ship-1", carrier: "FedEx", status: "in_transit" }],
          outForDelivery: [],
          deliveredAwaitingReceipt: [],
          exceptions: [],
          stale: [],
          recentlyDelivered: [],
        },
        shipments: [],
        asOf: "2026-04-01T12:00:00.000Z",
        todaySummary: { count: 1, carriers: ["FedEx"] },
        answer: null,
      }
    );

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/1 shipment arriving today/i)).toBeTruthy();
  });
});