// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

import ReceivedItemsPanel from "./ReceivedItemsPanel";

function stubLocalStorage(initialHeight = "280") {
  const store = new Map<string, string>([["aria-dash-recv-h", initialHeight]]);
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    removeItem: vi.fn((key: string) => store.delete(key)),
  });
}

function stubFetch(
  payload: Record<string, unknown>,
  trackingPayload?: Record<string, unknown>,
  postResponse?: { ok?: boolean; status?: number; body?: unknown },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init && init.method === "POST") {
        const p = postResponse ?? {
          ok: true,
          body: { completed: true, orderId: "PO-100", finalStatus: "ORDER_COMPLETED" },
        };
        return Promise.resolve({
          ok: p.ok ?? true,
          status: p.status ?? 200,
          json: () => Promise.resolve(p.body ?? {}),
        });
      }
      if (url.includes("/api/dashboard/tracking")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              trackingPayload ?? {
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
              },
            ),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    }),
  );
}

/** Minimal PO with a matched invoice and a non-clean variance (review row). */
function reviewPO(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "125138",
    orderDate: "2026-08-01",
    receiveDate: "2026-08-07",
    receiveDateTime: "2026-08-07T11:00:00-06:00",
    receivedBy: "Luis",
    receiptStatus: "full",
    supplier: "Grassroots Fabric Pots",
    total: 2233.5,
    subtotal: 2013.5,
    items: [{ productId: "SKU-1", quantity: 1 }],
    finaleUrl: "https://example.com/po/125138",
    _reconciliation: {
      invoices: [],
      outcomes: [],
      hasPendingApproval: false,
      hasAutoApplied: false,
      matchedInvoice: {
        id: "uuid-125138",
        invoice_number: "32654",
        vendor_name: "Grassroots Fabric Pots",
        subtotal: 0,
        freight: 0,
        tax: 0,
        total: 2235.1,
        status: "matched_review",
        pdf_storage_path: null,
        pdfAvailable: false,
      },
      threeWayMatch: { canApprove: false },
      variance: {
        netDelta: 221.6,
        byKind: { unexplained: 221.6 },
        clean: false,
        hasBlocking: false,
        headline: "Unexplained +$221.60",
        items: [
          {
            kind: "unexplained",
            label: "Order total",
            poAmount: 2013.5,
            invoiceAmount: 2235.1,
            delta: 221.6,
            blocking: false,
            message: "Goods differ by +$221.60 — invoice $2235.10 vs PO $2013.50.",
          },
        ],
      },
      chargesComparison: {
        po: { subtotal: 2013.5, freight: 220, tax: 0, tariffs: 0, total: 2233.5 },
        invoice: { subtotal: 0, freight: 0, tax: 0, tariffs: 0, total: 2235.1 },
        diffs: { subtotal: -2013.5, freight: -220, tax: 0, tariffs: 0, total: 1.6 },
      },
    },
    ...overrides,
  };
}

/** Minimal PO with a clean 3-way match (ready row). */
function readyPO(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "125080",
    orderDate: "2026-07-20",
    receiveDate: "2026-07-24",
    receiveDateTime: "2026-07-24T09:30:00-06:00",
    receiptStatus: "full",
    supplier: "Rootwise Soil Dynamics",
    total: 4141.09,
    subtotal: 3780,
    items: [{ productId: "TX7101", quantity: 12 }],
    finaleUrl: "https://example.com/po/125080",
    _reconciliation: {
      invoices: [],
      outcomes: [],
      hasPendingApproval: false,
      hasAutoApplied: false,
      matchedInvoice: {
        id: "uuid-125080",
        invoice_number: "300047111691",
        vendor_name: "Rootwise Soil Dynamics",
        subtotal: 0,
        freight: 361.09,
        tax: 0,
        total: 361.09,
        status: "matched_approved",
        pdf_storage_path: null,
        pdfAvailable: false,
      },
      threeWayMatch: { canApprove: true },
      variance: {
        netDelta: 0,
        byKind: {},
        clean: true,
        hasBlocking: false,
        headline: "No differences",
        items: [],
      },
    },
    ...overrides,
  };
}

/** Minimal PO with no invoice at all (settled dump). */
function settledPO(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "125169",
    orderDate: "2026-08-10",
    receiveDate: "2026-08-12",
    receiveDateTime: "2026-08-12T08:00:00-06:00",
    receiptStatus: "partial",
    supplier: "Miles Filippelli",
    total: 2400,
    items: [
      { productId: "BOTTLE-1G", quantity: 300, orderedQuantity: 300, receivedQuantity: 225, openQuantity: 75 },
    ],
    finaleUrl: "https://example.com/po/125169",
    ...overrides,
  };
}

function basePayload(received: unknown[], matchSuggestions: unknown[] = []) {
  return {
    received,
    days: 30,
    range: "rolling_30d",
    startDate: "2026-07-13",
    asOf: "2026-08-12",
    matchSuggestions,
    freightClasses: {},
    recentAutoCompletions: [],
  };
}

describe("ReceivedItemsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("restores persisted body height from localStorage", async () => {
    stubLocalStorage("320");
    stubFetch(basePayload([settledPO()]));

    const { container } = render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const scrollArea = container.querySelector('[style*="height: 320px"]');
    expect(scrollArea).toBeTruthy();
  });

  it("shows a today shipment summary above receivings when tracking data is available", async () => {
    stubLocalStorage();
    stubFetch(
      basePayload([settledPO()]),
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
      },
    );

    render(<ReceivedItemsPanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await screen.findByText(/1 shipment arriving today/i)).toBeTruthy();
  });

  it("renders a review row collapsed and expands to variance items + Apply & Complete", async () => {
    stubLocalStorage();
    stubFetch(basePayload([reviewPO()]));

    render(<ReceivedItemsPanel />);

    // Collapsed: verdict line with net delta + variance chips + visible Review button,
    // no item details yet
    expect(await screen.findByText(/PO 125138/i)).toBeTruthy();
    expect(screen.getByText(/Inv #32654/i)).toBeTruthy();
    expect(screen.getByText("+$221.60")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(screen.queryByText(/Goods differ by/i)).toBeNull();
    expect(screen.queryByText(/Apply Invoice & Complete/i)).toBeNull();

    // Click the Review button → variance item message + resolution hint + action button
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(await screen.findByText(/Goods differ by/i)).toBeTruthy();
    // Resolution hint tells the human what to do about the unexplained variance
    expect(screen.getByText(/Compare PO line items to invoice/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Apply Invoice & Complete/i })).toBeTruthy();
  });

  it("sorts blocking variance rows first and shows the block banner", async () => {
    stubLocalStorage();
    const blocking = reviewPO({
      orderId: "125051",
      supplier: "American Extracts",
      _reconciliation: {
        ...reviewPO()._reconciliation,
        matchedInvoice: {
          ...reviewPO()._reconciliation.matchedInvoice,
          id: "uuid-125051",
          invoice_number: "SF4474",
          vendor_name: "American Extracts",
          total: 6956.65,
          pdf_storage_path: "local/storage/INVOICE/American Extracts/2026-07-24/SF4474.pdf",
          pdfAvailable: true,
        },
        variance: {
          netDelta: 6237,
          byKind: { sku_unknown: 6237 },
          clean: false,
          hasBlocking: true,
          headline: "Unknown SKU +$6237.00",
          items: [
            {
              kind: "sku_unknown",
              label: "TX7101",
              poAmount: null,
              invoiceAmount: 6237,
              delta: 6237,
              blocking: true,
              message: "TX7101: invoiced but not present on the PO. Check for a SKU alias.",
            },
          ],
        },
      },
    });
    const plain = reviewPO();
    stubFetch(basePayload([plain, blocking]));

    render(<ReceivedItemsPanel />);

    // Blocking row (125051) must render ABOVE the plain review row (125138)
    await screen.findByText(/PO 125051/i);
    const first = screen.getByText(/PO 125051/i);
    const second = screen.getByText(/PO 125138/i);
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Blocking row shows BLOCKED label and expands to the BLOCK chip
    fireEvent.click(first.closest('[role="button"]') as HTMLElement);
    expect((await screen.findAllByText(/BLOCK/i)).length).toBeGreaterThanOrEqual(1);
  });

  it("renders PDF link only for allowlisted vendors with a file, and mounts hover preview", async () => {
    stubLocalStorage();
    const withPdf = reviewPO({
      orderId: "125051",
      supplier: "American Extracts",
      _reconciliation: {
        ...reviewPO()._reconciliation,
        matchedInvoice: {
          ...reviewPO()._reconciliation.matchedInvoice,
          id: "uuid-125051",
          invoice_number: "SF4474",
          vendor_name: "American Extracts",
          total: 6956.65,
          pdf_storage_path: "local/storage/INVOICE/American Extracts/2026-07-24/SF4474.pdf",
          pdfAvailable: true,
        },
        variance: {
          netDelta: 6237,
          byKind: { sku_unknown: 6237 },
          clean: false,
          hasBlocking: true,
          headline: "Unknown SKU +$6237.00",
          items: [
            {
              kind: "sku_unknown",
              label: "TX7101",
              poAmount: null,
              invoiceAmount: 6237,
              delta: 6237,
              blocking: true,
              message: "TX7101: invoiced but not present on the PO.",
            },
          ],
        },
      },
    });
    // Non-allowlist vendor (Lind Marine via "Unknown Vendor" on the invoice row) — no PDF
    const noPdf = reviewPO({
      orderId: "125101",
      supplier: "Lind Marine, INC",
      _reconciliation: {
        ...reviewPO()._reconciliation,
        matchedInvoice: {
          ...reviewPO()._reconciliation.matchedInvoice,
          id: "uuid-125101",
          invoice_number: "9464879",
          vendor_name: "Unknown Vendor",
          total: 5200,
          pdf_storage_path: "local/storage/INVOICE/Lind Marine/2026-08-21/9464879.pdf",
          pdfAvailable: false,
        },
      },
    });
    stubFetch(basePayload([noPdf, withPdf]));

    render(<ReceivedItemsPanel />);

    await screen.findByText(/PO 125051/i);
    // Only the allowlisted row gets a PDF control
    const pdfLinks = screen.getAllByRole("link", { name: "PDF" });
    expect(pdfLinks).toHaveLength(1);
    expect((pdfLinks[0] as HTMLAnchorElement).href).toContain(
      "/api/storage/invoice-pdf?id=uuid-125051",
    );

    // Hover mounts the iframe preview; leaving unmounts it
    const wrapper = pdfLinks[0].parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(await screen.findByTitle(/PDF preview/i)).toBeTruthy();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByTitle(/PDF preview/i)).toBeNull();
  });

  it("renders ready rows with an inline Complete button and shows a green toast", async () => {
    stubLocalStorage();
    stubFetch(basePayload([readyPO()]));

    render(<ReceivedItemsPanel />);

    expect(await screen.findByText(/PO 125080/i)).toBeTruthy();
    expect(screen.getByText(/matched Inv #300047111691 — ready/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Complete" }));

    expect(await screen.findByText(/PO 125080 completed in Finale/i)).toBeTruthy();
    // The row stays hidden even after the follow-up refetch returns it
    // (Finale still lists completed POs in the received window).
    await waitFor(() => expect(screen.queryByText(/matched Inv #300047111691 — ready/i)).toBeNull());
    // POST was issued to the receivings API
    const postCalls = (
      fetch as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }
    ).mock.calls.filter(
      (c) => c[1]?.method === "POST" && String(c[0]).includes("/api/dashboard/receivings"),
    );
    expect(postCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(String(postCalls[0][1]?.body))).toMatchObject({
      action: "complete_po",
      orderId: "125080",
      vendorName: "Rootwise Soil Dynamics",
    });
  });

  it("ready row shows amount verification and Unmatch undoes a wrong match", async () => {
    stubLocalStorage();
    const ready = readyPO({
      total: 877.5,
      _reconciliation: {
        ...readyPO()._reconciliation,
        matchedInvoice: {
          ...readyPO()._reconciliation.matchedInvoice,
          id: "uuid-inv-ready",
          total: 877.5,
        },
      },
    });
    stubFetch(basePayload([ready]));

    render(<ReceivedItemsPanel />);

    // Verification evidence inline: invoice total vs PO total
    // (fmtDollars rounds to whole dollars: 877.5 → $878)
    expect(await screen.findByText(/PO 125080/i)).toBeTruthy();
    expect(screen.getByText(/\$878 vs \$878/i)).toBeTruthy();

    // Unmatch posts unmatch_invoice and returns the invoice to the Match list
    fireEvent.click(screen.getByRole("button", { name: "Unmatch" }));

    const postCalls = (
      fetch as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }
    ).mock.calls.filter(
      (c) => c[1]?.method === "POST" && String(c[0]).includes("/api/dashboard/receivings"),
    );
    expect(postCalls.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(String(postCalls[0][1]?.body))).toMatchObject({
      action: "unmatch_invoice",
      invoiceId: "uuid-inv-ready",
    });
  });

  it("shows a block toast with the gate detail on 409, plus a persistent banner", async () => {
    stubLocalStorage();
    stubFetch(
      basePayload([reviewPO()]),
      undefined,
      {
        ok: false,
        status: 409,
        body: { error: "3-way match gate refused completion", detail: "Freight differs: +$221.60", completed: false },
      },
    );

    render(<ReceivedItemsPanel />);

    const header = (await screen.findByText(/PO 125138/i)).closest('[role="button"]') as HTMLElement;
    fireEvent.click(header);
    fireEvent.click(await screen.findByRole("button", { name: /Apply Invoice & Complete/i }));

    // Toast AND persistent per-row banner both surface the gate detail
    expect((await screen.findAllByText(/Freight differs: \+.*221\.60/i)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/3-Way Match Gate Refused/i)).toBeTruthy();
  });

  it("renders match suggestion rows with Match button and manual PO input", async () => {
    stubLocalStorage();
    const suggestion = {
      invoiceId: "uuid-sug-1",
      invoiceNumber: "32751",
      vendorName: "Grassroots Fabric Pots",
      invoiceTotal: 522.25,
      invoiceDate: "2026-08-09",
      pdfStoragePath: null,
      pdfAvailable: false,
      candidates: [
        {
          orderId: "124731",
          vendorName: "Grassroots Fabric Pots",
          orderDate: "2026-08-01",
          total: 3966.24,
          status: "open",
          score: 70,
          reasons: ["vendor + amount match"],
          isOpen: true,
        },
        {
          orderId: "124705",
          vendorName: "Grassroots Fabric Pots",
          orderDate: "2026-08-02",
          total: 2489.7,
          status: "open",
          score: 60,
          reasons: ["vendor match"],
          isOpen: true,
        },
      ],
      autoApplyReady: false,
    };
    stubFetch(basePayload([], [suggestion]));

    render(<ReceivedItemsPanel />);

    // Collapsed: invoice + top candidate + Match button on the row
    expect(await screen.findByText(/Inv 32751/i)).toBeTruthy();
    expect(screen.getByText(/→ 124731/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Match" })).toBeTruthy();

    // Expand → invoice items + alternative candidates + manual input
    const header = screen.getByText(/Inv 32751/i).closest('[role="button"]') as HTMLElement;
    fireEvent.click(header);
    expect(await screen.findByText(/124705/i)).toBeTruthy();
    expect(screen.getByPlaceholderText("PO #")).toBeTruthy();

    // Matching the top candidate hides the suggestion and keeps it hidden
    // after the follow-up refetch returns the same payload.
    fireEvent.click(screen.getAllByRole("button", { name: "Match" })[0]);
    await waitFor(() => expect(screen.queryByText(/Inv 32751/i)).toBeNull());
  });

  it("educated match: shows invoice items vs candidate PO items with SKU overlap", async () => {
    stubLocalStorage();
    const suggestion = {
      invoiceId: "uuid-sug-2",
      invoiceNumber: "212277431",
      vendorName: "ULINE",
      invoiceTotal: 1553.67,
      invoiceDate: "2026-08-19",
      pdfStoragePath: null,
      pdfAvailable: false,
      invoiceLineItems: [
        { sku: "S-15625", qty: 72, description: "SECURITY TAPE" },
        { sku: "ULS455", qty: 240, description: "CORRUGATED BOXES" },
      ],
      candidates: [
        {
          orderId: "9125221",
          vendorName: "ULINE",
          orderDate: "2026-08-10",
          total: 1553.67,
          status: "open",
          score: 70,
          reasons: ["OCR PO# candidate"],
          isOpen: true,
          items: [
            { productId: "S-15625", quantity: 72 },
            { productId: "ULS455", quantity: 240 },
            { productId: "S-9999", quantity: 10 },
          ],
        },
      ],
      autoApplyReady: false,
    };
    stubFetch(basePayload([], [suggestion]));

    render(<ReceivedItemsPanel />);
    expect(await screen.findByText(/Inv 212277431/i)).toBeTruthy();

    const header = screen.getByText(/Inv 212277431/i).closest('[role="button"]') as HTMLElement;
    fireEvent.click(header);

    // Invoice items block with SKUs
    expect(await screen.findByText(/Invoice items \(2\)/i)).toBeTruthy();
    expect(screen.getByText("S-15625")).toBeTruthy();
    expect(screen.getByText("ULS455")).toBeTruthy();

    // PO candidate items with overlap markers
    expect(screen.getByText(/2\/3 SKU match/i)).toBeTruthy();
    expect(screen.getAllByText("on invoice").length).toBe(2);
    expect(screen.getByText(/not on invoice/i)).toBeTruthy();
  });

  it("match row without invoice line items explains and lists ALL candidates with evidence", async () => {
    stubLocalStorage();
    const suggestion = {
      invoiceId: "uuid-sug-noitems",
      invoiceNumber: "300419889380",
      vendorName: "Concentrates, Inc",
      invoiceTotal: 916.33,
      invoiceDate: "2026-08-19",
      pdfStoragePath: null,
      pdfAvailable: false,
      invoiceLineItems: [], // OCR got no line items — must say so, not fake 0/N
      candidates: [
        {
          orderId: "125184",
          vendorName: "Concentrates Inc.",
          orderDate: "2026-08-11",
          total: 5261.68,
          status: "received",
          score: 62,
          reasons: ["vendor match", "8d apart"],
          isOpen: false,
          items: [{ productId: "SB104", quantity: 100 }],
        },
        {
          orderId: "124909",
          vendorName: "Concentrates, Inc",
          orderDate: "2026-06-10",
          total: 8451.75,
          status: "received",
          score: 60,
          reasons: ["previously confirmed by user (vendor=Concentrates, Inc, PO=124909) (amount differs from PO)"],
          isOpen: false,
          items: [{ productId: "FM104", quantity: 55 }, { productId: "SB104", quantity: 80 }],
        },
        {
          orderId: "124856",
          vendorName: "Concentrates, Inc",
          orderDate: "2026-05-26",
          total: 2328,
          status: "received",
          score: 60,
          reasons: ["previously confirmed by user"],
          isOpen: false,
        },
        {
          orderId: "124578",
          vendorName: "Concentrates, Inc",
          orderDate: "2026-03-31",
          total: 3204.19,
          status: "received",
          score: 60,
          reasons: ["previously confirmed by user"],
          isOpen: false,
        },
      ],
      autoApplyReady: false,
    };
    stubFetch(basePayload([], [suggestion]));

    render(<ReceivedItemsPanel />);
    expect(await screen.findByText(/Inv 300419889380/i)).toBeTruthy();

    const header = screen.getByText(/Inv 300419889380/i).closest('[role="button"]') as HTMLElement;
    fireEvent.click(header);

    // Honest "no line items" note instead of a fake 0/N SKU counter
    expect(await screen.findByText(/No line items on invoice/i)).toBeTruthy();
    expect(screen.queryByText(/0\/1 SKU match/i)).toBeNull();

    // ALL candidates render (no slice(0,3) cap) — 4th PO visible
    expect(screen.getByText("125184")).toBeTruthy();
    expect(screen.getByText("124578")).toBeTruthy();

    // Evidence line: invoice amount vs PO amount + delta + date + status
    expect(screen.getByText(/Inv \$916 vs PO \$5,262/i)).toBeTruthy();
    expect(screen.getAllByText(/Δ/).length).toBeGreaterThan(0);
    expect(screen.getByText(/2026-08-11/)).toBeTruthy();
  });

  it("shows the true unmatched backlog in the context strip (not the scored slice)", async () => {
    stubLocalStorage();
    // 3 unmatched invoices; API scores only the newest 2 (paint budget).
    // The panel must still show the full count + dollars in the header line.
    const suggestion = {
      invoiceId: "uuid-sug-3",
      invoiceNumber: "1001",
      vendorName: "CR Mineral Company, LLC",
      invoiceTotal: 2403.12,
      invoiceDate: "2026-08-25",
      pdfStoragePath: null,
      pdfAvailable: false,
      candidates: [
        {
          orderId: "124310",
          vendorName: "CR Mineral Company, LLC",
          orderDate: "2026-08-01",
          total: 2403.12,
          status: "open",
          score: 95,
          reasons: ["vendor + amount match"],
          isOpen: true,
        },
      ],
      autoApplyReady: false,
    };
    // Tabs render only when visiblePos.length > 0 — settled PO provides the
    // canvas without creating review/ready action rows.
    stubFetch({ ...basePayload([settledPO()], [suggestion]), unmatchedTotal: 32, unmatchedDollars: 65674.2 });

    render(<ReceivedItemsPanel />);

    // Match tab shows the TRUE count (32), not the scored slice (1)
    await screen.findByText(/32 Match/i);
    // Context strip carries the backlog dollars
    expect(screen.getByText(/32 unmatched/i)).toBeTruthy();
    expect(screen.getByText(/\$65,674/i)).toBeTruthy();
  });

  it("shows invoice-less POs only under Awaiting invoice (no Settled tab)", async () => {
    stubLocalStorage();
    stubFetch(basePayload([settledPO()]));

    render(<ReceivedItemsPanel />);

    // No action rows + one awaiting-invoice PO → the empty-state banner must
    // NOT claim "nothing needs attention" or treat the PO as settled.
    expect(
      await screen.findByText(/No invoices to match — 1 PO received, awaiting vendor invoice/i),
    ).toBeTruthy();

    // No "Settled" tab exists — invoice-less POs are an open AP item, not settled.
    expect(screen.queryByRole("button", { name: /Settled/ })).toBeNull();

    // Awaiting invoice section is collapsed by default (PO hidden until expanded).
    await screen.findByText(/Awaiting invoice \(1\)/i);
    expect(screen.queryByText("125169")).toBeNull();

    // Expand to reveal the PO, its partial-receipt badge, and discrepancy.
    fireEvent.click(screen.getByText(/▸ Awaiting invoice/i));
    expect(screen.getAllByText("125169").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/BOTTLE-1G short 75 of 300/i)).toBeTruthy();
  });

  it("auto-clears the complete toast after 5 seconds", async () => {
    stubLocalStorage();
    stubFetch(basePayload([readyPO()]));

    vi.useFakeTimers();
    try {
      render(<ReceivedItemsPanel />);
      // Flush microtasks so the initial fetch + paint complete under fake timers
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      fireEvent.click(screen.getByRole("button", { name: "Complete" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(screen.getByText(/PO 125080 completed in Finale/i)).toBeTruthy();
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.queryByText(/PO 125080 completed in Finale/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
