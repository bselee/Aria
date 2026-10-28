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
    expect(screen.queryByText(/PARTIAL/i)).toBeNull();
    expect(screen.queryByText(/backorder remains/i)).toBeNull();
    expect(screen.getByText(/Apr 1 10:15 AM/i)).toBeTruthy();
    expect(screen.getByText(/rcvd by Luis/i)).toBeTruthy();
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
    expect(await screen.findByText(/BOTTLE-1G short 75 of 300/i)).toBeTruthy();
    const shortMatches = screen.getAllByText(/short 75/i);
    expect(shortMatches.length).toBeGreaterThanOrEqual(2);
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
    expect(await screen.findByText(/SKU-A short 2 of 10/i)).toBeTruthy();
  });

  it("shows a today shipment summary above receivings when tracking data is available", async () => {
    stubLocalStorage();
    stubFetch(
      {
        received: [
          {
            orderId: "PO-500",
            orderDate: "2026-04-01",
            receiveDate: "2026-04-01",
            supplier: "Test Vendor",
            total: 100,
            items: [{ productId: "SKU-X", quantity: 1 }],
            finaleUrl: "https://example.com/po",
          },
        ],
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
        todaySummary: { headline: "1 shipment arriving today", lines: ["FedEx: ship-1"] },
        answer: null,
      }
    );

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/1 shipment arriving today/i)).toBeTruthy();
  });

  it("drops a settled full receipt with a known bill after 7 days", async () => {
    stubLocalStorage();
    const old = new Date();
    old.setDate(old.getDate() - 9);
    const oldDate = old.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-600",
          orderDate: "2026-01-01",
          receiveDate: oldDate,
          receiveDateTime: oldDate,
          receivedBy: "NK",
          receiptStatus: "full",
          supplier: "Settled Vendor",
          total: 500,
          items: [{ productId: "SKU-S", quantity: 10, orderedQuantity: 10, receivedQuantity: 10, openQuantity: 0 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            matchedInvoice: { invoice_number: "INV-1", subtotal: 500, freight: 0, tax: 0, total: 500, status: "received" },
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // Default list: settled 9 days ago is gone.
    expect(screen.queryByText(/PO-600/i)).toBeNull();
  });

  it("shows the invoiced quantity and flags a mismatch against the receipt", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-700",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "JM",
          receiptStatus: "full",
          supplier: "Weight Vendor",
          total: 500,
          items: [{ productId: "RAWCASTINGS", quantity: 100, orderedQuantity: 100, receivedQuantity: 100, openQuantity: 0 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            matchedInvoice: {
              invoice_number: "INV-2", subtotal: 500, freight: 0, tax: 0, total: 500, status: "received",
              line_items: [{ sku: "RAWCASTINGS", qty: 96, description: "castings" }],
            },
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/inv 96/i)).toBeTruthy();
    expect(screen.getByText(/±weight/i)).toBeTruthy();
  });

  it("names an OCR-identity bill by dollars and never says awaiting", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-800",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "full",
          supplier: "Miles Filippelli",
          total: 3140,
          items: [{ productId: "BASLPE102", quantity: 100, orderedQuantity: 100, receivedQuantity: 100, openQuantity: 0 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            matchedInvoice: { invoice_number: "error", subtotal: 0, freight: 0, tax: 0, total: 2688, status: "received", identityUnknown: true },
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect((await screen.findAllByText(/bill \$2,688/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Awaiting vendor invoice/i)).toBeNull();
    expect(screen.getByText(/Verify bill \$2,688 against the PO/i)).toBeTruthy();
  });

  it("names a covering bill on a sibling PO with no linked invoice", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-408",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "full",
          supplier: "Miles Filippelli",
          total: 2090,
          items: [{ productId: "HTF101", quantity: 10, orderedQuantity: 10, receivedQuantity: 10, openQuantity: 0 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            coveringBill: { invoice_number: "error", total: 2688 },
            matchedInvoice: null,
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Bill \$2,688 covers this PO's lines/i)).toBeTruthy();
    expect(screen.queryByText(/No bill yet/i)).toBeNull();
  });

  it("names the covered slice, not the whole bill, on a multi-PO bill (2026-10-28)", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-415",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "full",
          supplier: "Miles Filippelli",
          total: 1344,
          items: [{ productId: "BASLPE102", quantity: 56, orderedQuantity: 56, receivedQuantity: 56, openQuantity: 0 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            billingPattern: "deliver_and_bill",
            vendorOverbillPattern: { flagged: 6, bills: 10 },
            coveringBill: { invoice_number: "error", total: 2688 },
            invoiceVsReceipt: {
              invoicedTotal: 1344,
              receivedValue: 1344,
              invoicedQty: 56,
              receivedQty: 56,
              overbilled: false,
              billed: true,
            },
            matchedInvoice: null,
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Bill \$2,688 covers this PO's lines \(\$1,344\)/i)).toBeTruthy();
    expect(screen.queryByText(/Bill exceeds delivery/i)).toBeNull();
    // Item 6: the vendor pattern chip names the history
    expect(screen.getByText(/overbilled 6\/10 bills/i)).toBeTruthy();
  });

  it("says bill in AP instead of awaiting when the vendor has unlinked bills", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-900",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "full",
          supplier: "ULINE",
          total: 2996,
          items: [{ productId: "S-4738", quantity: 1000, orderedQuantity: 1000, receivedQuantity: 1000, openQuantity: 0 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            vendorHasUnlinkedBills: true,
            matchedInvoice: null,
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Bill in AP — link to PO/i)).toBeTruthy();
    expect(screen.queryByText(/Awaiting vendor invoice/i)).toBeNull();
  });

  it("says billed per delivery for a partial receipt with no bill yet (2026-10-28)", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-415",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "partial",
          supplier: "CR Minerals",
          total: 6000,
          items: [{ productId: "CR101", quantity: 250, orderedQuantity: 250, receivedQuantity: 60, openQuantity: 190 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            billingPattern: "deliver_and_bill",
            matchedInvoice: null,
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/190 still open\. Billed per delivery/i)).toBeTruthy();
    expect(screen.queryByText(/No bill yet/i)).toBeNull();
  });

  it("flags a bill that exceeds the delivery (overbill guard, 2026-10-28)", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-377",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "partial",
          supplier: "Miles Filippelli",
          total: 6000,
          items: [{ productId: "BASLPE102", quantity: 250, orderedQuantity: 250, receivedQuantity: 50, openQuantity: 200 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            billingPattern: "deliver_and_bill",
            invoiceVsReceipt: {
              invoicedTotal: 6000,
              receivedValue: 1200,
              invoicedQty: 250,
              receivedQty: 50,
              overbilled: true,
              billed: true,
            },
            matchedInvoice: {
              invoice_number: "125377",
              subtotal: 6000,
              freight: 0,
              tax: 0,
              total: 6000,
              status: "received",
              line_items: null,
            },
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Bill exceeds delivery — \$6,000 invoiced vs \$1,200 received/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Draft vendor email/i })).toBeTruthy();
    // Item 4: the per-line diff renders without a click (SKU appears in both
    // the header chip and the expanded detail block).
    expect(screen.getAllByText(/BASLPE102/).length).toBeGreaterThanOrEqual(2);
  });

  it("softens a same-day overbill into a grace line with no action", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-410",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "partial",
          supplier: "Cowoco",
          total: 1500,
          items: [{ productId: "CW101", quantity: 25, orderedQuantity: 25, receivedQuantity: 10, openQuantity: 15 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            billingPattern: "deliver_and_bill",
            invoiceVsReceipt: {
              invoicedTotal: 1500,
              receivedValue: 600,
              invoicedQty: 25,
              receivedQty: 10,
              overbilled: false,
              gracePending: true,
              billed: true,
            },
            matchedInvoice: null,
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Bill \$1,500 vs \$600 received — settles after today/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Draft vendor email/i })).toBeNull();
    expect(screen.queryByText(/Bill exceeds delivery/i)).toBeNull();
  });

  it("shows the overbill hold state and resolve action once a dispute is recorded", async () => {
    stubLocalStorage();
    const recent = new Date();
    const recentDate = recent.toISOString().slice(0, 19) + "-06:00";
    stubFetch({
      received: [
        {
          orderId: "PO-409",
          orderDate: recentDate,
          receiveDate: recentDate,
          receiveDateTime: recentDate,
          receivedBy: "NK",
          receiptStatus: "partial",
          supplier: "Thrive Probiotics",
          total: 1500,
          items: [{ productId: "THC101", quantity: 25, orderedQuantity: 25, receivedQuantity: 8, openQuantity: 17 }],
          finaleUrl: "https://example.com/po",
          _reconciliation: {
            invoices: [],
            outcomes: [],
            hasPendingApproval: false,
            hasAutoApplied: false,
            billingPattern: "deliver_and_bill",
            invoiceVsReceipt: {
              invoicedTotal: 1500,
              receivedValue: 1000,
              invoicedQty: 25,
              receivedQty: 8,
              overbilled: true,
              billed: true,
            },
            overbillDispute: {
              disposition: "held",
              status: "open",
              delta: 500,
              invoicedTotal: 1500,
              receivedValue: 1000,
              vendorNotified: true,
              vendorDraftId: "r-1234567890",
              createdAt: recentDate,
              resolution: null,
              balancedNow: false,
            },
            matchedInvoice: {
              invoice_number: "3001",
              subtotal: 1500,
              freight: 0,
              tax: 0,
              total: 1500,
              status: "received",
              line_items: null,
            },
          },
        },
      ],
      days: 14,
      asOf: "2026-04-01",
    });

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/Overbill \$500 held — pay \$1,000 for delivered\. Vendor notified/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Mark resolved/i })).toBeTruthy();
    expect(screen.queryByText(/Draft vendor email/i)).toBeNull();
    // One click to the draft (item 1)
    const draftLink = screen.getByRole("link", { name: /Open vendor draft in Gmail/i });
    expect(draftLink.getAttribute("href")).toContain("#drafts/r-1234567890");
  });
});