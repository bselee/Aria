import { describe, expect, it, vi, beforeEach } from "vitest";

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
    action_taken: "No PDF attachment found — left unread for manual review",
    metadata: {
      reasonCode: "missing_pdf_manual_review",
    },
    intent: "INVOICE",
  },
  {
    id: 12,
    created_at: new Date().toISOString(),
    email_subject: "Need response",
    action_taken: "Human interaction detected on ap inbox — left visible for manual AP review",
    metadata: {
      reasonCode: "human_interaction_manual_review",
    },
    intent: "INVOICE",
  },
];

const makeQuery = (rows: any[]) => {
  const query: any = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
    in: vi.fn().mockReturnThis(),
  };
  return query;
};

const supabase = {
  from: vi.fn((table: string) => {
    if (table === "invoices") return makeQuery(invoicesData);
    if (table === "ap_activity_log") return makeQuery(logData);
    return makeQuery([]);
  }),
};

vi.mock("@/lib/supabase", () => ({
  createClient: () => supabase,
}));

import { GET } from "./route";

describe("Invoice queue API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns needsEyes counts based on ap_activity_log reason codes", async () => {
    const response = await GET({
      nextUrl: new URL("http://localhost/api/dashboard/invoice-queue"),
    } as any);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.needsEyes).toEqual({
      missingPdf: 1,
      humanInteraction: 1,
    });
    expect(body.invoices).toHaveLength(1);
  });
});
