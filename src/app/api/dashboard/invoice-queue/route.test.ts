import { beforeEach, describe, expect, it, vi } from "vitest";

const invoicesData = [
  {
    id: 1,
    invoice_number: "INV-100",
    vendor_name: "Vendor A",
    total: 120,
    subtotal: 110,
    freight: 5,
    tax: 5,
    tariff: null,
    labor: null,
    status: "matched_review",
    po_number: "PO-1",
    created_at: new Date().toISOString(),
    discrepancies: null,
  },
];

const logData = [
  {
    id: 10,
    created_at: new Date().toISOString(),
    email_subject: "INV-100",
    action_taken: "queued for Bill.com forward",
    reviewed_action: null,
    metadata: {
      invoiceNumber: "INV-100",
      reasonCode: "queued_for_billcom",
    },
    intent: "INVOICE",
  },
  {
    id: 11,
    created_at: new Date().toISOString(),
    email_subject: "Missing PDF",
    action_taken: "No PDF attachment found - left unread for manual review",
    reviewed_action: null,
    metadata: {
      reasonCode: "missing_pdf_manual_review",
    },
    intent: "INVOICE",
  },
  {
    id: 12,
    created_at: new Date().toISOString(),
    email_subject: "Need response",
    action_taken: "Human interaction detected on ap inbox - left visible for manual AP review",
    reviewed_action: null,
    metadata: {
      reasonCode: "human_interaction_manual_review",
    },
    intent: "HUMAN_INTERACTION",
  },
];

const queryState = {
  intentFilter: null as string[] | null,
  apLogInCalls: [] as string[][],
};

const makeQuery = (rows: any[], table: string) => {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      if (table !== "ap_activity_log" || !queryState.intentFilter) {
        return Promise.resolve({ data: rows, error: null });
      }

      return Promise.resolve({
        data: rows.filter((row) => queryState.intentFilter!.includes(row.intent)),
        error: null,
      });
    }),
    in: vi.fn().mockImplementation((_column: string, values: string[]) => {
      queryState.intentFilter = values;
      queryState.apLogInCalls.push(values);
      return query;
    }),
  };
  return query;
};

const supabase = {
  from: vi.fn((table: string) => {
    if (table === "invoices") return makeQuery(invoicesData, table);
    if (table === "ap_activity_log") return makeQuery(logData, table);
    return makeQuery([], table);
  }),
};

vi.mock("@/lib/supabase", () => ({
  createClient: () => supabase,
}));

import { GET } from "./route";

describe("invoice queue route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryState.intentFilter = null;
    queryState.apLogInCalls = [];
  });

  it("returns needsEyes counts using AP manual-review reason codes", async () => {
    const response = await GET({
      nextUrl: new URL("http://localhost/api/dashboard/invoice-queue?bust=1"),
    } as any);

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.needsEyes).toEqual({
      missingPdf: 1,
      humanInteraction: 1,
    });
    expect(body.invoices).toHaveLength(1);
    expect(queryState.apLogInCalls).toContainEqual([
      "INVOICE",
      "RECONCILIATION",
      "HUMAN_INTERACTION",
    ]);
  });

  it("filters invoices out of the queue when the latest linked review is dismissed", async () => {
    logData[0] = {
      ...logData[0],
      action_taken: "queued for review",
      reviewed_action: "dismissed",
    };

    const response = await GET({
      nextUrl: new URL("http://localhost/api/dashboard/invoice-queue?bust=1"),
    } as any);

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.invoices).toHaveLength(0);
  });
});
