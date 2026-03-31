// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import InvoiceQueuePanel from "./InvoiceQueuePanel";

const baseResponse = {
  invoices: [],
  stats: {
    totalToday: 0,
    autoApproved: 0,
    needsApproval: 0,
    unmatched: 0,
    totalDollarImpact: 0,
  },
  needsEyes: {
    missingPdf: 0,
    humanInteraction: 0,
  },
  cachedAt: new Date().toISOString(),
};

const stubFetch = (payload: any) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(payload),
  }));
};

const stubLocalStorage = () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(() => null),
    removeItem: vi.fn(() => null),
  });
};

describe("InvoiceQueuePanel Needs Eyes badge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render the badge when counts are zero", async () => {
    stubLocalStorage();
    stubFetch(baseResponse);

    render(<InvoiceQueuePanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Needs Eyes/i)).toBeNull();
  });

  it("renders the badge when counts exist", async () => {
    stubLocalStorage();
    stubFetch({
      ...baseResponse,
      needsEyes: { missingPdf: 2, humanInteraction: 1 },
    });

    render(<InvoiceQueuePanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/Needs Eyes/i)).toBeTruthy();
    expect(screen.getByText(/2 PDF/)).toBeTruthy();
    expect(screen.getByText(/1 HUMAN/)).toBeTruthy();
  });

  it("omits zero-valued subcounts in the badge text", async () => {
    stubLocalStorage();
    stubFetch({
      ...baseResponse,
      needsEyes: { missingPdf: 0, humanInteraction: 1 },
    });

    render(<InvoiceQueuePanel />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByText(/Needs Eyes/i)).toBeTruthy();
    expect(screen.queryByText(/0 PDF/)).toBeNull();
    expect(screen.getByText(/1 HUMAN/)).toBeTruthy();
  });
});
