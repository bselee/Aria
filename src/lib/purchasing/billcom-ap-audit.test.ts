/**
 * @file    src/lib/purchasing/billcom-ap-audit.test.ts
 * @purpose Unit tests for the Bill.com All Bills vs AP audit rules. Fixtures are
 *          the real cases from the 2026-10-07 audit (NewMoon aliasing, the AAA
 *          Cooper Pro# vs account#, Benny's repeated amount, FedEx's no-bill
 *          rule, the Evergreen 150323 stuck claim).
 * @author  Hermia
 * @created 2026-10-07
 */

import { describe, it, expect } from "vitest";
import {
  classifyNoRecord,
  deriveInvoice,
  findApRecord,
  invoicesMatch,
  normInvoice,
  normVendor,
  parseDay,
  parseDollars,
  selectStuckRowsToClose,
  vendorsMatch,
  withinDays,
  type AuditFacts,
  type ForwardRow,
  type RefRow,
} from "./billcom-ap-audit";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function fwd(over: Partial<ForwardRow>): ForwardRow {
  return {
    id: 1,
    forwarded_at: "2026-10-05 17:15:07",
    status: "FORWARDED",
    email_from: "vendor@example.com",
    email_subject: "Invoice 1",
    pdf_filename: "invoice.pdf",
    ocr_vendor_name: null,
    ocr_invoice_number: null,
    ocr_total: null,
    ...over,
  };
}

function bill(over: Partial<RefRow>): RefRow {
  return {
    vendor_name: "Vendor",
    invoice_number: "1",
    invoice_amount: 100,
    invoice_date: "2026-10-05",
    ...over,
  };
}

function facts(over: Partial<AuditFacts>): AuditFacts {
  return { forwards: [], cache: [], vendorInvoices: [], ref: [], ...over };
}

// ── Normalization / matching ────────────────────────────────────────────────

describe("normVendor / normInvoice", () => {
  it("strips entity suffixes and punctuation", () => {
    expect(normVendor("Evergreen Growers Supply, LLC.")).toBe("evergreen growers");
    expect(normVendor("AAA COOPER TRANSPORTATION™")).toBe("aaa cooper transportation");
  });

  it("reduces an invoice number to significant digits", () => {
    expect(normInvoice("PO_125377")).toBe("125377");
    expect(normInvoice("002967")).toBe("2967");
    expect(normInvoice("9-341-49252")).toBe("934149252");
    expect(normInvoice("Invoice #KM-099672-01")).toBe("9967201");
  });
});

describe("vendorsMatch", () => {
  it("matches a personal-name sender to its company through the alias map", () => {
    // NewMoon Development Company bills from Kyle Takahashi <kylednf@gmail.com>.
    const haystack = "Kyle Takahashi | gmail | Invoice PO#125377";
    expect(vendorsMatch(haystack, "NewMoon Development Company")).toBe(true);
  });

  it("matches carrier name variants", () => {
    expect(vendorsMatch("AAA Cooper Transportation", "AAA COOPER TRANSPORTATION")).toBe(true);
  });

  it("does not match two vendors that share only a generic token", () => {
    // Shared "equipment" once made Century Equipment read as Welch Equipment.
    expect(vendorsMatch("Century Equipment Company", "Welch Equipment")).toBe(false);
  });

  it("does not merge vendors on a single shared word from a forward subject", () => {
    // WWEX writes "Worldwide Express Invoices 07/22/2026 for BUILD A SOIL" - the
    // word "worldwide" alone must not make that Invico Worldwide's forward.
    expect(vendorsMatch("Worldwide Express | wwex | Worldwide Express Invoices", "Invico Worldwide")).toBe(false);
    // Malibu Compost's invoice subject vs SeaCoast Compost.
    expect(vendorsMatch("Invoice 5600 from Malibu Compost", "SeaCoast Compost")).toBe(false);
    // A person's surname ("Cooper Didier" on a Sustainable Village thread) vs AAA Cooper.
    expect(vendorsMatch("Cooper Didier | sustainablevillage", "AAA Cooper Transportation")).toBe(false);
  });

  it("still matches WWEX and AAA Cooper to themselves", () => {
    expect(vendorsMatch("Worldwide Express | wwex", "Worldwide Express")).toBe(true);
    expect(vendorsMatch("AAA COOPER TRANSPORTATION | aaacooper", "AAA Cooper Transportation")).toBe(true);
  });

  it("does not match on an empty side", () => {
    expect(vendorsMatch("", "Uline")).toBe(false);
    expect(vendorsMatch("Uline", null)).toBe(false);
  });
});

describe("invoicesMatch", () => {
  it("matches a filename-wrapped invoice number", () => {
    expect(invoicesMatch("PO_125377", "125377")).toBe(true);
  });

  it("matches a dashed FedEx number to its digits", () => {
    expect(invoicesMatch("9-341-49252", "934149252")).toBe(true);
  });

  it("matches a truncated FedEx number to its full sibling", () => {
    expect(invoicesMatch("9-444-759", "9-444-75902")).toBe(true);
  });

  it("does not match two different invoices of the same length", () => {
    expect(invoicesMatch("136501", "136605")).toBe(false);
  });

  it("does not treat a short shared suffix as a match", () => {
    expect(invoicesMatch("12519", "19")).toBe(false);
  });
});

describe("deriveInvoice", () => {
  it("prefers the subject Pro# over OCR of the account number", () => {
    // AAA Cooper scans OCR the customer number; the subject carries the Pro#.
    const row = fwd({
      email_subject: "Invoice Stmt - Cust 0001159492 Pro#: 64058919",
      ocr_invoice_number: "1159492",
    });
    expect(deriveInvoice(row)).toBe("64058919");
  });

  it("prefers an explicit subject invoice number over an OCR PO number", () => {
    const row = fwd({
      email_subject: "Concentrates, Inc - Invoice# 3084520",
      ocr_invoice_number: "1081435",
    });
    expect(deriveInvoice(row)).toBe("3084520");
  });

  it("falls back to the OCR invoice number", () => {
    expect(deriveInvoice(fwd({ ocr_invoice_number: "APUS-247846" }))).toBe("APUS-247846");
  });

  it("returns empty when there is nothing to derive", () => {
    expect(deriveInvoice(fwd({ email_subject: "", pdf_filename: "", email_from: "" }))).toBe("");
  });
});

describe("parseDay / parseDollars / withinDays", () => {
  it("parses the three date shapes present in the sources", () => {
    expect(parseDay("2026-10-05")).toBe(Date.UTC(2026, 9, 5));
    expect(parseDay("2026-10-05 17:15:07")).toBe(Date.UTC(2026, 9, 5));
    expect(parseDay("10/05/2026")).toBe(Date.UTC(2026, 9, 5));
    expect(parseDay("not a date")).toBeNull();
  });

  it("parses money and rejects fragments", () => {
    expect(parseDollars("1,234.56")).toBe(1234.56);
    expect(parseDollars("$988.71")).toBe(988.71);
    expect(parseDollars("7")).toBe(7);
    expect(parseDollars("")).toBeNull();
    expect(parseDollars(null)).toBeNull();
  });

  it("bounds a date window", () => {
    const a = parseDay("2026-10-05");
    expect(withinDays(a, parseDay("2026-10-12"), 10)).toBe(true);
    expect(withinDays(a, parseDay("2026-09-01"), 10)).toBe(false);
    expect(withinDays(a, null, 10)).toBe(false);
  });
});

// ── Direction 2 ─────────────────────────────────────────────────────────────

describe("findApRecord", () => {
  it("finds a forward by invoice number", () => {
    const b = bill({ vendor_name: "DestiNation Transport LLC", invoice_number: "9482661", invoice_amount: 7600, invoice_date: "2026-10-02" });
    const f = facts({
      forwards: [fwd({
        email_from: '"smtp@destinationtrans.com" <smtp@destinationtrans.com>',
        email_subject: "Destination Transport Invoice _9482661",
        pdf_filename: "9482661.pdf",
        ocr_invoice_number: "9482661",
        ocr_total: "7600",
      })],
    });
    const ev = findApRecord(b, f);
    expect(ev.map((e) => e.source)).toContain("forward");
  });

  it("finds a bill with no invoice number by vendor + amount inside the date window", () => {
    // Berger's PDF carries no invoice number; the bill and forward agree at $140.55.
    const b = bill({ vendor_name: "Berger Horticultural Products LTD", invoice_number: "224973IN", invoice_amount: 140.55, invoice_date: "2026-09-30" });
    const f = facts({
      forwards: [fwd({
        forwarded_at: "2026-10-01 09:00:00",
        email_from: "receivable@berger.ca",
        email_subject: "Berger receivable",
        pdf_filename: "BUIAS1.pdf",
        ocr_invoice_number: "NO",
        ocr_total: "140.55",
      })],
    });
    expect(findApRecord(b, f).length).toBeGreaterThan(0);
  });

  it("does NOT explain a bill from a repeated identical amount weeks away", () => {
    // Benny Martinez bills $2,450 every cycle - an unbounded amount match would
    // silently hide a genuinely unforwarded invoice.
    const b = bill({ vendor_name: "Benny Martinez Trucking", invoice_number: "B4038", invoice_amount: 2450, invoice_date: "2026-10-03" });
    const f = facts({
      forwards: [fwd({
        id: 900,
        forwarded_at: "2026-08-11 18:01:45",
        email_from: "scans-watcher@aria.local",
        email_subject: "Scanned Invoice: Benny_08112026.pdf",
        pdf_filename: "Benny_08112026.pdf",
        ocr_total: "2450",
      })],
    });
    expect(findApRecord(b, f)).toEqual([]);
  });

  it("returns nothing when the vendor does not match", () => {
    const b = bill({ vendor_name: "Certis USA L.L.C.", invoice_number: "INV16137", invoice_amount: 4928 });
    const f = facts({ forwards: [fwd({ ocr_invoice_number: "INV16137", ocr_total: "4928" })] });
    // vendor@example.com does not resolve to Certis
    expect(findApRecord(b, f)).toEqual([]);
  });

  it("finds a record held only in the vendor_invoices ledger", () => {
    const b = bill({ vendor_name: "SeaCoast Compost", invoice_number: "001789", invoice_amount: 7470, invoice_date: "2026-01-15" });
    const f = facts({
      vendorInvoices: [{ vendor_name: "SEACOAST COMPOST", invoice_number: "001789", invoice_date: "2026-01-15", total: 7470 }],
    });
    expect(findApRecord(b, f).map((e) => e.source)).toEqual(["vendor_invoices"]);
  });
});

describe("classifyNoRecord", () => {
  it("classifies FedEx as by-design", () => {
    const v = classifyNoRecord(bill({ vendor_name: "FedEx", invoice_number: "9-341-49252", invoice_amount: 16448.76 }), facts({}));
    expect(v.kind).toBe("FEDEX_RULE");
    expect(v.actionable).toBe(false);
  });

  it("flags a claimed-but-never-delivered invoice", () => {
    // Evergreen 150323, ledger row 752: ERROR, claim expired, never sent.
    const b = bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150323", invoice_amount: 110.35, invoice_date: "2026-09-16" });
    const f = facts({
      forwards: [fwd({
        id: 752,
        forwarded_at: "2026-09-17 16:30:19",
        status: "ERROR",
        email_from: "<order@evergreengrowers.com>",
        email_subject: "Invoice 150323 from Evergreen Growers Supply, LLC.",
        pdf_filename: "Inv_150323_from_Evergreen_Growers_Supply_LLC._14240.pdf",
        error_message: "stale CLAIMED expired after 15m",
      })],
    });
    const v = classifyNoRecord(b, f);
    expect(v.kind).toBe("STUCK_NEVER_SENT");
    expect(v.actionable).toBe(true);
    expect(v.detail).toContain("752");
  });

  it("classifies a hand-entered invoice from a vendor that flows through Aria", () => {
    const b = bill({ vendor_name: "DestiNation Transport LLC", invoice_number: "9483171", invoice_amount: 5450, invoice_date: "2026-09-29" });
    const f = facts({
      forwards: [fwd({
        id: 800,
        forwarded_at: "2026-09-15 18:01:28",
        email_from: '"smtp@destinationtrans.com" <smtp@destinationtrans.com>',
        email_subject: "Destination Transport Invoice _9477993",
        ocr_invoice_number: "9477993",
      })],
    });
    const v = classifyNoRecord(b, f);
    expect(v.kind).toBe("HAND_FORWARDED");
    expect(v.actionable).toBe(false);
  });

  it("classifies a vendor that never reaches Aria", () => {
    const b = bill({ vendor_name: "SeaCoast Compost", invoice_number: "002967", invoice_amount: 13055, invoice_date: "2026-10-01" });
    const f = facts({
      ref: [
        bill({ vendor_name: "SeaCoast Compost", invoice_number: "002920", invoice_amount: 13915 }),
        bill({ vendor_name: "SeaCoast Compost", invoice_number: "002790", invoice_amount: 12085 }),
      ],
    });
    const v = classifyNoRecord(b, f);
    expect(v.kind).toBe("NO_AP_FORWARDS_EVER");
    expect(v.actionable).toBe(false);
  });

  it("flags a first-time vendor with no history anywhere", () => {
    const b = bill({ vendor_name: "Invico Worldwide", invoice_number: "IUSA26942c", invoice_amount: 33516, invoice_date: "2026-09-30" });
    const v = classifyNoRecord(b, facts({}));
    expect(v.kind).toBe("NO_VENDOR_HISTORY");
    expect(v.actionable).toBe(true);
  });

  it("ignores a subject that merely mentions the vendor", () => {
    // Bill's own thread "Re: BuildASoil PO # 125316 - Seacoast Compost" landed in
    // another forward's subject. A mention is not evidence that SeaCoast's mail
    // flows through Aria, so this must stay NO_AP_FORWARDS_EVER, not HAND_FORWARDED.
    const b = bill({ vendor_name: "SeaCoast Compost", invoice_number: "002967", invoice_amount: 13055, invoice_date: "2026-10-01" });
    const f = facts({
      forwards: [
        fwd({
          id: 700,
          email_from: "Bill Selee <bill.selee@buildasoil.com>",
          email_subject: "Re: BuildASoil PO # 125316 - Seacoast Compost - 9/21/2026",
          pdf_filename: "(no-attachment)",
        }),
      ],
      ref: [
        bill({ vendor_name: "SeaCoast Compost", invoice_number: "002920", invoice_amount: 13915 }),
        bill({ vendor_name: "SeaCoast Compost", invoice_number: "002790", invoice_amount: 12085 }),
      ],
    });
    expect(classifyNoRecord(b, f).kind).toBe("NO_AP_FORWARDS_EVER");
  });

  it("still uses the sender identity to prove a vendor flows through Aria", () => {
    // The same vendor with a real forward from its own sender stays HAND_FORWARDED.
    const b = bill({ vendor_name: "DestiNation Transport LLC", invoice_number: "9483171", invoice_amount: 5450, invoice_date: "2026-09-29" });
    const f = facts({
      forwards: [fwd({
        id: 800,
        email_from: '"smtp@destinationtrans.com" <smtp@destinationtrans.com>',
        email_subject: "Destination Transport Invoice _9477993",
        ocr_invoice_number: "9477993",
      })],
    });
    expect(classifyNoRecord(b, f).kind).toBe("HAND_FORWARDED");
  });
});

describe("selectStuckRowsToClose", () => {
  const stuckRow = fwd({
    id: 752,
    status: "ERROR",
    forwarded_at: "2026-09-17 16:30:19",
    email_from: "<order@evergreengrowers.com>",
    email_subject: "Invoice 150323 from Evergreen Growers Supply, LLC.",
    pdf_filename: "Inv_150323_from_Evergreen_Growers_Supply_LLC._14240.pdf",
  });

  it("closes a stuck row whose invoice is now a bill", () => {
    const ref = [bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150323", invoice_amount: 110.35 })];
    const closed = selectStuckRowsToClose([stuckRow], ref);
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe(752);
    expect(closed[0].invoice).toBe("150323");
  });

  it("does not touch a stuck row whose invoice is not in Bill.com", () => {
    const ref = [bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150400", invoice_amount: 93.25 })];
    expect(selectStuckRowsToClose([stuckRow], ref)).toEqual([]);
  });

  it("never touches rows that already have a terminal status", () => {
    const ref = [bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150323", invoice_amount: 110.35 })];
    for (const status of ["FORWARDED", "SKIPPED"]) {
      expect(selectStuckRowsToClose([{ ...stuckRow, status }], ref)).toEqual([]);
    }
  });

  it("requires an invoice match, not just a vendor and amount", () => {
    const ref = [bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150400", invoice_amount: 110.35 })];
    expect(selectStuckRowsToClose([stuckRow], ref)).toEqual([]);
  });

  it("ignores a reference row with no amount", () => {
    const ref = [bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150323", invoice_amount: null })];
    expect(selectStuckRowsToClose([stuckRow], ref)).toEqual([]);
  });

  it("ignores a stuck row with no derivable invoice", () => {
    const row = fwd({ id: 1, status: "ERROR", email_subject: "", pdf_filename: "", email_from: "", ocr_invoice_number: "" });
    const ref = [bill({ vendor_name: "Evergreen Growers Supply, LLC", invoice_number: "150323", invoice_amount: 110.35 })];
    expect(selectStuckRowsToClose([row], ref)).toEqual([]);
  });
});
